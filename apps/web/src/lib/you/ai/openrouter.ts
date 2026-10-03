// ═══════════════════════════════════════════════════════════════════════════
// OpenRouter provider wrapper — hosted vision for the production recon path
// (Worker C lane, P6.C1: adapter vlm-recon-or-1).
//
// Honesty contract (mirrors ai/zai.ts):
// - every wrapper measures REAL wall-clock latency around the provider call;
// - provider errors surface verbatim inside OpenRouterProviderError (message
//   is never rewritten to look like success);
// - no wrapper fabricates content, progress or costs.
//
// Env (validated only when the openrouter provider is SELECTED — the module
// itself stays import-safe with no env present):
//   OPENROUTER_API_KEY     — required (fail closed, never guessed)
//   YOU_RECON_MODEL        — vision model id (default google/gemini-2.5-flash)
//   YOU_RECON_TIMEOUT_MS   — per-call timeout (default 30000)
//   YOU_RECON_BASE_URL     — API base (default https://openrouter.ai/api/v1;
//                            tests point this at a local mock)
//
// P6.A6-FULL: every call runs under the 'openrouter' circuit breaker and the
// shared bounded retry engine (core/retry.ts) — see openRouterVisionAnalyze.
// ═══════════════════════════════════════════════════════════════════════════
import { callWithBreaker, ProviderUnavailableError } from '../core/circuit-breaker';
import { withRetries, defaultRetryOptions, type RetryOutcome } from '../core/retry';
import { bumpCounter } from '../core/metrics';

export const OPENROUTER_ADAPTER = {
  adapterId: 'vlm-recon-or-1',
  version: '1',
  inferenceOnly: true,
  trainingOnBiometrics: false,
  privacyNote:
    'inference-only analysis via OpenRouter-hosted vision models; raw evidence stays in object storage and is passed to the provider solely as transient analysis input; no training is performed on user biometric data',
} as const;

export const DEFAULT_RECON_MODEL = 'google/gemini-2.5-flash';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/** Normalized provider error: verbatim cause message, tagged with the operation. */
export class OpenRouterProviderError extends Error {
  readonly operation: string;
  readonly causeMessage: string;
  readonly status?: number;
  /** Server-requested delay (Retry-After, ms) — honored by the retry engine. */
  readonly retryAfterMs?: number;
  /** Honest retryability hint for the shared classifier (timeouts/network). */
  readonly retryable?: boolean;
  constructor(
    operation: string,
    cause: unknown,
    status?: number,
    extra?: { retryAfterMs?: number; retryable?: boolean; attempts?: number },
  ) {
    const causeMessage =
      cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : JSON.stringify(cause);
    const attempts = extra?.attempts ?? 1;
    super(
      `openrouter provider error during ${operation}: ${causeMessage}` +
        (attempts > 1 ? ` (after ${attempts} attempts)` : ''),
    );
    this.name = 'OpenRouterProviderError';
    this.operation = operation;
    this.causeMessage = causeMessage;
    this.status = status;
    this.retryAfterMs = extra?.retryAfterMs;
    this.retryable = extra?.retryable;
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

export interface VisionResult {
  content: string;
  latencyMs: number; // real, measured around the provider call
  model: string; // as reported by the provider response
}

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
  baseUrl: string;
}

/** Read + validate the OpenRouter env contract. Throws with what is missing. */
export function openRouterConfig(): OpenRouterConfig {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new OpenRouterProviderError(
      'config',
      'OPENROUTER_API_KEY is not configured (YOU_RECON_PROVIDER=openrouter requires it) — refusing to guess credentials',
    );
  }
  return {
    apiKey,
    model: process.env.YOU_RECON_MODEL?.trim() || DEFAULT_RECON_MODEL,
    timeoutMs: Number(process.env.YOU_RECON_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    baseUrl: (process.env.YOU_RECON_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
  };
}

/**
 * Hosted vision analysis through OpenRouter's chat-completions API with
 * image input as a data-URL content part (the standard OpenAI-compatible
 * vision shape OpenRouter proxies). `opts.model` overrides the env-derived
 * model — the P6.C5 registry passes the resolved model id here (single
 * recon vision call site).
 *
 * P6.A6-FULL composition (the textbook resilience4j/Poly shape — breaker
 * INSIDE the retry loop, so the breaker observes EVERY failed attempt and a
 * breaker-open refusal short-circuits the loop instead of hammering a down
 * provider): each attempt is admitted by the 'openrouter' circuit breaker;
 * 429/5xx/timeout/network failures retry with exponential backoff + jitter
 * (Retry-After honored when sent, capped by the bounded law); 4xx fail fast;
 * a breaker-open refusal returns the typed ProviderUnavailableError VERBATIM
 * (non-retryable by classification — the breaker owns recovery). Latency is
 * measured across the whole (possibly retried) sequence — real, never sampled.
 */
export async function openRouterVisionAnalyze(
  imageBase64DataUrl: string,
  prompt: string,
  opts: { thinking?: boolean; model?: string } = {},
): Promise<VisionResult> {
  const cfg = openRouterConfig();
  const model = opts.model?.trim() || cfg.model;
  const t0 = Date.now();
  const outcome: RetryOutcome<Response> = await withRetries(
    () =>
      callWithBreaker('openrouter', async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
        try {
          const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              authorization: `Bearer ${cfg.apiKey}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model,
              messages: [
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: imageBase64DataUrl } },
                  ],
                },
              ],
            }),
          });
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new OpenRouterProviderError(
              'vision.http',
              `HTTP ${res.status} ${body.slice(0, 300)}`,
              res.status,
              { retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after')) },
            );
          }
          return res;
        } finally {
          clearTimeout(timer);
        }
      }),
    {
      ...defaultRetryOptions(),
      onRetry: (info) => {
        bumpCounter('provider_retries', { provider: 'openrouter', operation: 'vision' });
        console.warn(
          `[you/openrouter] vision attempt ${info.attempt} failed (${String(info.error instanceof Error ? info.error.message : info.error).slice(0, 160)}) — retrying in ${info.delayMs}ms`,
        );
      },
    },
  );
  if (!outcome.ok) {
    const e = outcome.error;
    // breaker fail-fast: the typed error surfaces VERBATIM (never wrapped —
    // callers and the retry classifier match on its code)
    if (e instanceof ProviderUnavailableError) throw e;
    // rethrow the provider error verbatim on single-attempt failures (message
    // contract preserved); wrap multi-attempt exhaustions with the honest count
    if (e instanceof OpenRouterProviderError && outcome.attempts === 1) throw e;
    if (e instanceof Error && e.name === 'AbortError') {
      throw new OpenRouterProviderError(
        'vision.timeout',
        `no response within ${cfg.timeoutMs}ms`,
        undefined,
        { attempts: outcome.attempts },
      );
    }
    throw new OpenRouterProviderError('vision', e, e instanceof OpenRouterProviderError ? e.status : undefined, {
      attempts: outcome.attempts,
      retryAfterMs: e instanceof OpenRouterProviderError ? e.retryAfterMs : undefined,
    });
  }
  try {
    const data = (await outcome.value.json()) as {
      model?: string;
      choices?: { message?: { content?: unknown } }[];
    };
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new OpenRouterProviderError('vision.content', `empty or non-string content: ${JSON.stringify(data)?.slice(0, 300)}`);
    }
    return { content, latencyMs: Date.now() - t0, model: data?.model ?? 'unknown' };
  } catch (e) {
    if (e instanceof OpenRouterProviderError) throw e;
    throw new OpenRouterProviderError('vision', e);
  }
}
