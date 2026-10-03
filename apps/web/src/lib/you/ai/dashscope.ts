// ═══════════════════════════════════════════════════════════════════════════
// DashScope provider wrapper — hosted image/video generation for the
// production render path (Worker C lane, P6.C2: render seam, hosted side).
//
// Mirrors the C1 law that closed the same gap for reconstruction (ai/openrouter.ts):
// the station's z-ai SDK render calls (adapters/ai-image.ts + ai-video.ts via
// ai/zai.ts) are unavailable to the hosted deployment, so rendering runs only
// where the sandbox SDK exists. This seam adds the hosted alternative against
// the DashScope (Alibaba Cloud Model Studio / Bailian) HTTP APIs:
//
//   image: POST /api/v1/services/aigc/text2image/image-synthesis  (task-based)
//   video: POST /api/v1/services/aigc/video-generation/video-synthesis
//   poll:  GET  /api/v1/tasks/{task_id}                            (shared)
//   fetch: GET  {result_url}                                       (OSS result host)
//
// Honesty contract (mirrors ai/zai.ts + ai/openrouter.ts):
// - every wrapper measures REAL wall-clock latency around the provider calls
//   (clocks are injectable for the deterministic test suite, never sampled);
// - provider errors surface verbatim inside DashScopeProviderError with a
//   precise failureKind (auth / quota / network / parse / timeout / http);
// - no wrapper fabricates content, progress or costs;
// - the request/response shapes follow the PUBLIC DashScope docs; they are
//   verified against a local contract mock (tests/contract/dashscope.test.mjs)
//   but NOT against the live provider from this sandbox (no egress, no key) —
//   capability/pricing numbers are never fabricated here.
//
// ZERO SDK DEPENDENCY (openrouter.ts's zero-dependency law): plain fetch only.
// Resilience composition (P6.A6-FULL, the same shape as zai.ts/openrouter.ts):
// submit calls run breaker-INSIDE-retry — every attempt is admitted by the
// 'dashscope' circuit breaker and transient failures (429/5xx/timeout/network)
// retry under the shared bounded engine; breaker-open refusals fail fast with
// the typed ProviderUnavailableError, rethrown VERBATIM. The task POLL loop
// uses read-only breaker admission (a 10-minute poll must not hold a
// half-open probe) and its own bounded inline error handling, exactly like
// the station's pollVideoTask law. The result FETCH runs under bounded retry
// only — the OSS result bucket is a different service from the DashScope API
// endpoint and must not trip its breaker.
//
// Bounded-poll law: poll loops stop at BOTH a wall-clock deadline AND a
// maximum attempt count. There is no configuration — and no code path — that
// polls forever.
//
// Env (validated only at USE time — the module stays import-safe with no env):
//   DASHSCOPE_API_KEY                — required (fail closed, never guessed)
//   YOU_DASHSCOPE_IMAGE_MODEL        — default wanx2.1-t2i-turbo
//   YOU_DASHSCOPE_VIDEO_MODEL        — default wan2.2-t2v-plus
//   YOU_DASHSCOPE_BASE_URL           — default https://dashscope-intl.aliyuncs.com
//                                       (CN mainland: https://dashscope.aliyuncs.com)
//   YOU_DASHSCOPE_TIMEOUT_MS         — per-HTTP-call timeout (default 30000)
//   YOU_DASHSCOPE_POLL_INTERVAL_MS   — poll cadence (default 5000)
//   YOU_DASHSCOPE_IMAGE_MAX_WAIT_MS  — image poll deadline (default 300000)
//   YOU_DASHSCOPE_VIDEO_MAX_WAIT_MS  — video poll deadline (default 600000)
//
// IMPORT SHAPE NOTE: the relative imports below carry explicit `.ts` extensions
// so this module is directly importable by the node:test suites under Node's
// type stripping (the same directly-testable law as the zero-import core
// modules — retry.ts / circuit-breaker.ts / metrics.ts). The app bundler
// resolves the exact paths unchanged; tsconfig enables
// allowImportingTsExtensions (noEmit already held).
// ═══════════════════════════════════════════════════════════════════════════
import { callWithBreaker, assertProviderAvailable, ProviderUnavailableError } from '../core/circuit-breaker.ts';
import { withRetries, defaultRetryOptions, type RetryOutcome } from '../core/retry.ts';
import { bumpCounter } from '../core/metrics.ts';

export const DASHSCOPE_ADAPTER = {
  adapterId: 'ai-render-dashscope-1',
  version: '1',
  inferenceOnly: true,
  trainingOnBiometrics: false,
  privacyNote:
    'inference-only generation via DashScope-hosted models; the render path sends STYLIZED AVATAR prompts derived from consented HTIR descriptors (never raw biometric evidence, never a real-identity likeness claim); no training is performed on user biometric data',
  contractNote:
    'request/response shapes from the public DashScope docs, verified against the local contract mock in tests/contract/dashscope.test.mjs only — no live-provider verification from this sandbox',
} as const;

export const DEFAULT_DASHSCOPE_IMAGE_MODEL = 'wanx2.1-t2i-turbo';
export const DEFAULT_DASHSCOPE_VIDEO_MODEL = 'wan2.2-t2v-plus';
const DEFAULT_BASE_URL = 'https://dashscope-intl.aliyuncs.com';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_IMAGE_MAX_WAIT_MS = 300_000; // 5 min — images finish in seconds; this is the honest ceiling
const DEFAULT_VIDEO_MAX_WAIT_MS = 600_000; // 10 min — mirrors the station pollVideoTask bound

// ─── Typed errors ────────────────────────────────────────────────────────────

/** Precise failure modes — distinguished for honest operator diagnosis. */
export type DashScopeFailureKind =
  | 'config' // missing/invalid local configuration (never retried)
  | 'auth' // 401/403 — invalid key, denied access (never retried)
  | 'quota' // 429 / quota-exhausted codes (retried when transient)
  | 'network' // transport-level failure (fetch TypeError etc.)
  | 'parse' // unparseable provider response / missing required fields
  | 'timeout' // per-call timeout (AbortError) or poll deadline exhaustion
  | 'http' // other non-OK HTTP status (5xx retried, other 4xx not)
  | 'task'; // provider task reached a terminal non-success state

/** Normalized provider error: verbatim cause message, tagged + classified. */
export class DashScopeProviderError extends Error {
  readonly operation: string;
  readonly causeMessage: string;
  readonly status?: number;
  /** DashScope-reported error code, when sent (e.g. InvalidApiKey, Throttling.RateQuota). */
  readonly providerCode?: string;
  /** Precise failure mode (see DashScopeFailureKind). */
  readonly failureKind: DashScopeFailureKind;
  /** Server-requested delay (Retry-After, ms) — honored by the retry engine. */
  readonly retryAfterMs?: number;
  /** Honest retryability hint for the shared classifier. */
  readonly retryable?: boolean;
  constructor(
    operation: string,
    cause: unknown,
    opts: {
      status?: number;
      providerCode?: string;
      failureKind?: DashScopeFailureKind;
      retryAfterMs?: number;
      retryable?: boolean;
      attempts?: number;
    } = {},
  ) {
    const causeMessage =
      cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : JSON.stringify(cause);
    const attempts = opts.attempts ?? 1;
    super(
      `dashscope provider error during ${operation}${opts.failureKind ? ` [${opts.failureKind}]` : ''}: ${causeMessage}` +
        (attempts > 1 ? ` (after ${attempts} attempts)` : ''),
    );
    this.name = 'DashScopeProviderError';
    this.operation = operation;
    this.causeMessage = causeMessage;
    this.status = opts.status;
    this.providerCode = opts.providerCode;
    this.failureKind = opts.failureKind ?? 'http';
    this.retryAfterMs = opts.retryAfterMs;
    this.retryable = opts.retryable;
  }
}

/** Parse a Retry-After response header (seconds or HTTP-date) into ms. */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const httpDate = Date.parse(trimmed);
  if (!Number.isNaN(httpDate)) return Math.max(0, httpDate - Date.now());
  return undefined;
}

// ─── Config (fail-closed at USE time) ────────────────────────────────────────

export interface DashScopeConfig {
  apiKey: string;
  baseUrl: string;
  imageModel: string;
  videoModel: string;
  timeoutMs: number;
  pollIntervalMs: number;
  imageMaxWaitMs: number;
  videoMaxWaitMs: number;
}

/** Read + validate the DashScope env contract. Throws with what is missing. */
export function dashScopeConfig(): DashScopeConfig {
  const apiKey = process.env.DASHSCOPE_API_KEY?.trim();
  if (!apiKey) {
    throw new DashScopeProviderError(
      'config',
      'DASHSCOPE_API_KEY is not configured (YOU_RENDER_PROVIDER=dashscope requires it) — refusing to guess credentials',
      { failureKind: 'config' },
    );
  }
  const num = (name: string, fallback: number): number => {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  return {
    apiKey,
    baseUrl: (process.env.YOU_DASHSCOPE_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    imageModel: process.env.YOU_DASHSCOPE_IMAGE_MODEL?.trim() || DEFAULT_DASHSCOPE_IMAGE_MODEL,
    videoModel: process.env.YOU_DASHSCOPE_VIDEO_MODEL?.trim() || DEFAULT_DASHSCOPE_VIDEO_MODEL,
    timeoutMs: num('YOU_DASHSCOPE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
    pollIntervalMs: num('YOU_DASHSCOPE_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS),
    imageMaxWaitMs: num('YOU_DASHSCOPE_IMAGE_MAX_WAIT_MS', DEFAULT_IMAGE_MAX_WAIT_MS),
    videoMaxWaitMs: num('YOU_DASHSCOPE_VIDEO_MAX_WAIT_MS', DEFAULT_VIDEO_MAX_WAIT_MS),
  };
}

/** Map a station-style 'WxH' size to the DashScope 'W*H' convention (idempotent). */
export function toDashScopeSize(size: string): string {
  const m = /^(\d+)x(\d+)$/.exec(size.trim());
  return m ? `${m[1]}*${m[2]}` : size.trim();
}

// ─── Injectable test surface ─────────────────────────────────────────────────

export interface DashScopeCallOptions {
  /** Injectable fetch (tests). Default: the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep (tests) — also feeds the retry engine's backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (tests) — drives deadlines, cadence and latency math. */
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── HTTP core ───────────────────────────────────────────────────────────────

interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
}

/** One DashScope API call with a per-call abort timeout. Raw transport errors
 * (TypeError / AbortError) propagate for the resilience layer to classify. */
async function dashScopeHttp(
  cfg: DashScopeConfig,
  init: { method: 'GET' | 'POST'; path: string; body?: unknown },
  opts: DashScopeCallOptions = {},
): Promise<HttpResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await doFetch(`${cfg.baseUrl}${init.path}`, {
      method: init.method,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  } finally {
    clearTimeout(timer);
  }
}

/** Classify a non-OK DashScope HTTP response into the typed error. */
function classifyHttpError(operation: string, res: { status: number; headers: Headers; text: string }): DashScopeProviderError {
  let providerCode: string | undefined;
  let providerMessage: string | undefined;
  try {
    const parsed = JSON.parse(res.text) as { code?: unknown; message?: unknown };
    if (typeof parsed?.code === 'string') providerCode = parsed.code;
    if (typeof parsed?.message === 'string') providerMessage = parsed.message;
  } catch {
    // body was not the documented error envelope — keep the raw text
  }
  const detail = providerMessage ?? res.text.slice(0, 300);
  const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
  let failureKind: DashScopeFailureKind;
  let retryable: boolean;
  if (res.status === 401 || res.status === 403) {
    // 403 can also mean quota/arrears — the provider code disambiguates
    const quotaish = /arrear|quota|balance/i.test(`${providerCode ?? ''} ${detail}`);
    failureKind = quotaish ? 'quota' : 'auth';
    retryable = quotaish; // billing-blocked keys do not recover within a retry budget
  } else if (res.status === 429) {
    failureKind = 'quota';
    retryable = true;
  } else {
    failureKind = 'http';
    retryable = [500, 502, 503, 504].includes(res.status);
  }
  return new DashScopeProviderError(operation, `HTTP ${res.status}${providerCode ? ` ${providerCode}` : ''} ${detail}`, {
    status: res.status,
    providerCode,
    failureKind,
    retryAfterMs,
    retryable,
  });
}

/** Parse a JSON object body or throw the typed parse error. */
function parseJsonObject(operation: string, text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`top-level JSON is not an object: ${text.slice(0, 200)}`);
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new DashScopeProviderError(operation, `unparseable provider response: ${e instanceof Error ? e.message : String(e)}`, {
      failureKind: 'parse',
    });
  }
}

// ─── Resilience composition (breaker INSIDE retry — the A6-FULL law) ────────

interface ResilientCallContext extends DashScopeCallOptions {
  timeoutMs: number; // for the honest timeout re-wrap
}

async function runResilient<T>(operation: string, fn: () => Promise<T>, ctx: ResilientCallContext): Promise<T> {
  const outcome: RetryOutcome<T> = await withRetries(
    () =>
      callWithBreaker('dashscope', async () => {
        return fn();
      }),
    {
      ...defaultRetryOptions(),
      ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
      onRetry: (info) => {
        bumpCounter('provider_retries', { provider: 'dashscope', operation });
        console.warn(
          `[you/dashscope] ${operation} attempt ${info.attempt} failed (${String(info.error instanceof Error ? info.error.message : info.error).slice(0, 160)}) — retrying in ${info.delayMs}ms`,
        );
      },
    },
  );
  if (outcome.ok) return outcome.value;
  const e = outcome.error;
  // breaker fail-fast: the typed error surfaces VERBATIM (never wrapped —
  // callers and the retry classifier match on its code)
  if (e instanceof ProviderUnavailableError) throw e;
  // rethrow the provider error verbatim on single-attempt failures (message
  // contract preserved); wrap multi-attempt exhaustions with the honest count
  if (e instanceof DashScopeProviderError && outcome.attempts === 1) throw e;
  if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
    throw new DashScopeProviderError(operation, `no response within ${ctx.timeoutMs}ms`, {
      failureKind: 'timeout',
      retryable: true,
      attempts: outcome.attempts,
    });
  }
  throw new DashScopeProviderError(operation, e, {
    ...(e instanceof DashScopeProviderError
      ? {
          status: e.status,
          providerCode: e.providerCode,
          failureKind: e.failureKind,
          retryAfterMs: e.retryAfterMs,
          retryable: e.retryable,
        }
      : { failureKind: 'network' }),
    attempts: outcome.attempts,
  });
}

// ─── Task handles ────────────────────────────────────────────────────────────

export interface DashScopeTaskHandle {
  taskId: string;
  /** provider-reported initial status, verbatim (PENDING etc.) */
  status: string;
  requestId: string | null;
}

function requireTaskHandle(operation: string, data: Record<string, unknown>): DashScopeTaskHandle {
  const output = data.output as { task_id?: unknown; task_status?: unknown } | undefined;
  const taskId = output?.task_id;
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new DashScopeProviderError(
      operation,
      `task creation returned no task_id: ${JSON.stringify(data).slice(0, 300)}`,
      { failureKind: 'parse' },
    );
  }
  const requestId = typeof data.request_id === 'string' ? data.request_id : null;
  return { taskId, status: typeof output?.task_status === 'string' ? output.task_status : 'unknown', requestId };
}

// ─── Image generation (task-based: submit → poll → fetch) ───────────────────

export interface DashScopeImageTaskInput {
  prompt: string;
  negativePrompt?: string;
  /** DashScope 'W*H' convention; station 'WxH' is normalized transparently. */
  size?: string;
  /** number of images (default 1 — the render path always wants one). */
  n?: number;
}

export async function dashScopeCreateImageTask(
  input: DashScopeImageTaskInput,
  opts: { model?: string } & DashScopeCallOptions = {},
): Promise<DashScopeTaskHandle> {
  const cfg = dashScopeConfig();
  const model = opts.model?.trim() || cfg.imageModel;
  return runResilient(
    'image-create',
    async () => {
      const res = await dashScopeHttp(
        cfg,
        {
          method: 'POST',
          path: '/api/v1/services/aigc/text2image/image-synthesis',
          body: {
            model,
            input: {
              prompt: input.prompt,
              ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
            },
            parameters: { size: toDashScopeSize(input.size ?? '1024*1024'), n: input.n ?? 1 },
          },
        },
        opts,
      );
      if (res.status !== 200) throw classifyHttpError('image-create', res);
      return requireTaskHandle('image-create', parseJsonObject('image-create', res.text));
    },
    { ...opts, timeoutMs: cfg.timeoutMs },
  );
}

// ─── Video generation (task-based: submit → poll) ───────────────────────────

export interface DashScopeVideoTaskInput {
  prompt?: string;
  /** base image for image-to-video: public URL or base64 data URL */
  imageUrl?: string;
  /** DashScope 'W*H' convention (e.g. 1280*720). */
  size?: string;
  /** seconds (the render path asks for 5). */
  duration?: number;
}

export interface DashScopeVideoTask extends DashScopeTaskHandle {
  model: string;
  /** station-only knobs the DashScope contract cannot express — recorded, not silently dropped. */
  droppedParams: string[];
}

export async function dashScopeCreateVideoTask(
  input: DashScopeVideoTaskInput,
  opts: { model?: string } & DashScopeCallOptions = {},
): Promise<DashScopeVideoTask> {
  const cfg = dashScopeConfig();
  const model = opts.model?.trim() || cfg.videoModel;
  const handle = await runResilient(
    'video-create',
    async () => {
      const res = await dashScopeHttp(
        cfg,
        {
          method: 'POST',
          path: '/api/v1/services/aigc/video-generation/video-synthesis',
          body: {
            model,
            input: {
              ...(input.prompt ? { prompt: input.prompt } : {}),
              ...(input.imageUrl ? { img_url: input.imageUrl } : {}),
            },
            parameters: {
              ...(input.size ? { size: toDashScopeSize(input.size) } : {}),
              ...(input.duration ? { duration: input.duration } : {}),
            },
          },
        },
        opts,
      );
      if (res.status !== 200) throw classifyHttpError('video-create', res);
      return requireTaskHandle('video-create', parseJsonObject('video-create', res.text));
    },
    { ...opts, timeoutMs: cfg.timeoutMs },
  );
  return { ...handle, model, droppedParams: [] };
}

// ─── Task polling (bounded: deadline AND max attempts — never infinite) ──────

export type DashScopePollStatus = 'succeeded' | 'failed' | 'timeout';

export interface DashScopePollResult {
  /** provider-hosted result URL when succeeded (image or video). */
  url: string | null;
  status: DashScopePollStatus;
  waitedMs: number; // real total wait (injectable clock in tests)
  lastProviderStatus: string; // verbatim last task_status observed
  attempts: number; // polls actually issued
}

export interface DashScopePollOptions extends DashScopeCallOptions {
  maxWaitMs?: number;
  pollIntervalMs?: number;
  /** hard attempt cap; default derived from the deadline (ceil(maxWait/interval)). */
  maxAttempts?: number;
}

/** Extract the result URL from either task family's output shape. */
function extractResultUrl(output: unknown): string | null {
  const o = output as { video_url?: unknown; image_url?: unknown; url?: unknown; results?: { url?: unknown }[] } | undefined;
  const candidates = [o?.video_url, o?.results?.[0]?.url, o?.image_url, o?.url];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return null;
}

const TERMINAL_FAILURE_STATUSES = new Set(['FAILED', 'CANCELED', 'UNKNOWN']);

/**
 * Poll a DashScope task to a terminal state. Bounded TWICE over: a wall-clock
 * deadline (default: the image/video max-wait knob) AND a maximum attempt
 * count (default: the deadline expressed in polls) — a stuck clock can never
 * make this loop infinite. Per-poll failures get the station pollVideoTask
 * treatment: throttling is tolerated until the deadline with a longer
 * backoff; any other poll error gets 3 strikes, then the honest typed error.
 *
 * Read-only breaker admission at loop start (P6.A6-FULL poll law): refuse to
 * START a minutes-long poll while the provider's breaker is open, but never
 * hold a half-open probe hostage to a poll loop.
 */
export async function dashScopePollTask(taskId: string, opts: DashScopePollOptions = {}): Promise<DashScopePollResult> {
  assertProviderAvailable('dashscope');
  const cfg = dashScopeConfig();
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const maxWaitMs = opts.maxWaitMs ?? cfg.videoMaxWaitMs;
  const pollIntervalMs = opts.pollIntervalMs ?? cfg.pollIntervalMs;
  const maxAttempts = opts.maxAttempts ?? Math.max(1, Math.ceil(maxWaitMs / Math.max(1, pollIntervalMs)));
  const started = now();
  const deadline = started + maxWaitMs;
  let lastProviderStatus = 'unknown';
  let consecutiveErrors = 0;
  let attempts = 0;
  for (;;) {
    const t = now();
    if (t >= deadline) {
      return { url: null, status: 'timeout', waitedMs: t - started, lastProviderStatus, attempts };
    }
    if (attempts >= maxAttempts) {
      return { url: null, status: 'timeout', waitedMs: t - started, lastProviderStatus, attempts };
    }
    attempts += 1;
    try {
      const res = await dashScopeHttp(cfg, { method: 'GET', path: `/api/v1/tasks/${encodeURIComponent(taskId)}` }, opts);
      if (res.status !== 200) throw classifyHttpError('poll', res);
      const data = parseJsonObject('poll', res.text);
      const output = data.output as { task_status?: unknown } | undefined;
      lastProviderStatus = typeof output?.task_status === 'string' ? output.task_status : 'unknown';
      if (lastProviderStatus === 'SUCCEEDED') {
        return {
          url: extractResultUrl(output),
          status: 'succeeded',
          waitedMs: now() - started,
          lastProviderStatus,
          attempts,
        };
      }
      if (TERMINAL_FAILURE_STATUSES.has(lastProviderStatus)) {
        return { url: null, status: 'failed', waitedMs: now() - started, lastProviderStatus, attempts };
      }
      // PENDING / RUNNING — keep waiting
      consecutiveErrors = 0;
      await sleep(pollIntervalMs);
    } catch (err) {
      // per-poll hiccup handling (station pollVideoTask law): throttling is
      // tolerated until the deadline with a longer backoff; anything else
      // gets 3 strikes, then the honest typed error
      consecutiveErrors += 1;
      const isThrottle = err instanceof DashScopeProviderError && err.failureKind === 'quota';
      if (!isThrottle && consecutiveErrors >= 3) {
        throw new DashScopeProviderError('poll', err, {
          ...(err instanceof DashScopeProviderError
            ? { status: err.status, providerCode: err.providerCode, failureKind: err.failureKind }
            : { failureKind: 'network' }),
          attempts,
        });
      }
      await sleep(isThrottle ? 15_000 : 7_000);
    }
  }
}

// ─── Result fetch (OSS result host — bounded retry, no API breaker) ─────────

export interface DashScopeFetchedImage {
  base64: string;
  bytes: number;
  mime: string;
  url: string;
}

/**
 * Download a provider-hosted result image and return its bytes as base64.
 * Runs under the shared bounded retry engine but deliberately NOT under the
 * 'dashscope' breaker: the result URL lives on the provider's OSS bucket, a
 * different service from the DashScope API endpoint — conflating their
 * failure modes would trip the breaker for the wrong reason.
 */
export async function dashScopeFetchImageAsBase64(url: string, opts: DashScopeCallOptions = {}): Promise<DashScopeFetchedImage> {
  const cfg = dashScopeConfig(); // use-time credential law (no key ⇒ precise error)
  const doFetch = opts.fetchImpl ?? fetch;
  const outcome = await withRetries(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      try {
        const res = await doFetch(url, { method: 'GET', signal: controller.signal });
        if (!res.ok) {
          throw new DashScopeProviderError('image-fetch', `result download HTTP ${res.status}`, {
            status: res.status,
            failureKind: 'http',
            retryable: [429, 500, 502, 503, 504].includes(res.status),
          });
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0) {
          throw new DashScopeProviderError('image-fetch', 'result download returned 0 bytes', {
            failureKind: 'parse',
          });
        }
        const mime = (res.headers.get('content-type') ?? 'image/png').split(';')[0].trim() || 'image/png';
        return { base64: buf.toString('base64'), bytes: buf.length, mime, url };
      } finally {
        clearTimeout(timer);
      }
    },
    {
      ...defaultRetryOptions(),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
      onRetry: (info) => {
        bumpCounter('provider_retries', { provider: 'dashscope', operation: 'image-fetch' });
        console.warn(
          `[you/dashscope] image-fetch attempt ${info.attempt} failed (${String(info.error instanceof Error ? info.error.message : info.error).slice(0, 160)}) — retrying in ${info.delayMs}ms`,
        );
      },
    },
  );
  if (!outcome.ok) {
    const e = outcome.error;
    if (e instanceof DashScopeProviderError && outcome.attempts === 1) throw e;
    if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      throw new DashScopeProviderError('image-fetch', `no response within ${cfg.timeoutMs}ms`, {
        failureKind: 'timeout',
        retryable: true,
        attempts: outcome.attempts,
      });
    }
    throw new DashScopeProviderError('image-fetch', e, {
      ...(e instanceof DashScopeProviderError
        ? { status: e.status, providerCode: e.providerCode, failureKind: e.failureKind, retryable: e.retryable }
        : { failureKind: 'network' }),
      attempts: outcome.attempts,
    });
  }
  return outcome.value;
}

// ─── High-level: the station-shape render entry points ──────────────────────

export interface DashScopeGeneratedImage {
  base64: string; // PNG/JPEG bytes, base64
  latencyMs: number; // REAL end-to-end (submit + poll + fetch)
  waitedMs: number; // REAL poll wait
  model: string; // model id actually used
  taskId: string; // provider task id (audit trail)
  mime: string;
  bytes: number;
}

/**
 * Generate one image end-to-end: submit the text2image task, poll it to a
 * terminal state (bounded), fetch the result bytes. Timeout / provider
 * failure / a succeeded task with no result URL are honest typed errors —
 * never a fabricated artifact. Station-size strings ('768x1344') are
 * normalized to the DashScope 'W*H' convention transparently.
 */
export async function dashScopeGenerateImage(
  prompt: string,
  size: string,
  opts: { model?: string; maxWaitMs?: number } & DashScopeCallOptions = {},
): Promise<DashScopeGeneratedImage> {
  const now = opts.now ?? Date.now;
  const cfg = dashScopeConfig();
  const t0 = now();
  const task = await dashScopeCreateImageTask({ prompt, size }, opts);
  const polled = await dashScopePollTask(task.taskId, {
    ...opts,
    maxWaitMs: opts.maxWaitMs ?? cfg.imageMaxWaitMs,
  });
  if (polled.status === 'timeout') {
    throw new DashScopeProviderError(
      'image-poll',
      `task ${task.taskId} did not finish within ${opts.maxWaitMs ?? cfg.imageMaxWaitMs}ms (${polled.attempts} polls, last status: ${polled.lastProviderStatus}) — honest failure, no artifact fabricated`,
      { failureKind: 'timeout', attempts: polled.attempts },
    );
  }
  if (polled.status === 'failed') {
    throw new DashScopeProviderError(
      'image-poll',
      `task ${task.taskId} reached terminal status ${polled.lastProviderStatus} — honest failure, no artifact fabricated`,
      { failureKind: 'task' },
    );
  }
  if (!polled.url) {
    throw new DashScopeProviderError(
      'image-poll',
      `task ${task.taskId} SUCCEEDED but returned no result URL — honest failure, no artifact fabricated`,
      { failureKind: 'parse' },
    );
  }
  const fetched = await dashScopeFetchImageAsBase64(polled.url, opts);
  const model = opts.model?.trim() || cfg.imageModel;
  return {
    base64: fetched.base64,
    latencyMs: now() - t0,
    waitedMs: polled.waitedMs,
    model,
    taskId: task.taskId,
    mime: fetched.mime,
    bytes: fetched.bytes,
  };
}
