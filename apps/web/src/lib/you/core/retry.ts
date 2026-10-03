// ═══════════════════════════════════════════════════════════════════════════
// YOU core — bounded retry engine (Worker A lane, P6.A6-FULL).
//
// The ONE shared retry primitive for provider calls, outbound webhook
// deliveries and durable-job execution. Laws:
//
// - BOUNDED, ALWAYS: every retry loop stops at maxAttempts AND at a wall-clock
//   budget (budgetMs). There is no configuration — and no code path — that
//   retries forever. Budget exhaustion is an honest terminal outcome, never a
//   hang.
// - EXPONENTIAL BACKOFF + JITTER: delay_n = random in [0, min(maxDelayMs,
//   baseDelayMs * factor^(n-1))] (full jitter by default; jitter=0 disables).
//   Jittered delays prevent thundering-herd lockstep across concurrent jobs.
// - RETRY-AFTER IS RESPECTED: when the failing error carries retry-after
//   information (HTTP 429/503 `Retry-After`), that value is used verbatim for
//   the next delay, capped at maxDelayMs (the bounded law wins over a
//   misbehaving server that asks for an hour).
// - FAIL-CLOSED CLASSIFICATION: unknown errors are NOT retried. Only explicit
//   retryable signals (429/5xx statuses, timeouts, network failures, database
//   unreachability) retry; the circuit breaker's `provider_unavailable`
//   fail-fast error is deliberately non-retryable (the breaker owns recovery).
// - VERBATIM ERRORS: the failed outcome carries the LAST error as-is. Nothing
//   is rewritten to look like success or hide the provider message.
//
// Env knobs (read per call; safe fail-closed defaults; documented in
// .env.example):
//   YOU_RETRY_MAX_ATTEMPTS   total attempts per call        (default 3)
//   YOU_RETRY_BASE_DELAY_MS  first backoff delay            (default 500)
//   YOU_RETRY_MAX_DELAY_MS   backoff + retry-after ceiling  (default 8000)
//   YOU_RETRY_BUDGET_MS      wall-clock retry budget        (default 30000)
//
// ZERO-IMPORT MODULE (erasable TS only): imported directly by node:test unit
// suites under Node >= 23.6 type stripping — no `@/` aliases, no runtime
// dependencies. Callers in the app import it via '@/lib/you/core/retry'.
// ═══════════════════════════════════════════════════════════════════════════

export interface RetryOptions {
  /** Total attempts (1 = no retries). Default: YOU_RETRY_MAX_ATTEMPTS or 3. */
  maxAttempts?: number;
  /** First backoff delay. Default: YOU_RETRY_BASE_DELAY_MS or 500. */
  baseDelayMs?: number;
  /** Ceiling for every computed delay (backoff AND retry-after). Default: YOU_RETRY_MAX_DELAY_MS or 8000. */
  maxDelayMs?: number;
  /** Exponential growth factor. Default 2. */
  factor?: number;
  /** Jitter fraction 0..1 (1 = full jitter). Default 1. */
  jitter?: number;
  /**
   * Wall-clock budget for the whole sequence (delays included). The loop stops
   * BEFORE sleeping/attempting again once the next step would exceed it; the
   * in-flight attempt always finishes. Default: YOU_RETRY_BUDGET_MS or 30000.
   */
  budgetMs?: number;
  /** Should this error be retried? Default: isRetryableError (fail-closed). */
  retryOn?: (err: unknown) => boolean;
  /** Injectable sleep (tests). Default: real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Observability hook, fired once per RETRY (not the first attempt). */
  onRetry?: (info: RetryNotice) => void;
}

export interface RetryNotice {
  /** The attempt that just failed (1-based). */
  attempt: number;
  /** The error it failed with (verbatim). */
  error: unknown;
  /** The delay that will be slept before the next attempt. */
  delayMs: number;
}

export type RetryStoppedBy = 'succeeded' | 'exhausted-attempts' | 'budget' | 'non-retryable';

export interface RetrySucceeded<T> {
  ok: true;
  value: T;
  attempts: number;
  firstAttemptAt: number;
  finishedAt: number;
  stoppedBy: 'succeeded';
}
export interface RetryFailed {
  ok: false;
  /** The last error, verbatim — never rewritten. */
  error: unknown;
  attempts: number;
  firstAttemptAt: number;
  finishedAt: number;
  stoppedBy: 'exhausted-attempts' | 'budget' | 'non-retryable';
}
export type RetryOutcome<T> = RetrySucceeded<T> | RetryFailed;

// ─── env knobs (per call, fail-closed defaults) ─────────────────────────────

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function retryDefaults(): Required<
  Pick<RetryOptions, 'maxAttempts' | 'baseDelayMs' | 'maxDelayMs' | 'budgetMs'>
> {
  return {
    maxAttempts: envInt('YOU_RETRY_MAX_ATTEMPTS', 3),
    baseDelayMs: envInt('YOU_RETRY_BASE_DELAY_MS', 500),
    maxDelayMs: envInt('YOU_RETRY_MAX_DELAY_MS', 8000),
    budgetMs: envInt('YOU_RETRY_BUDGET_MS', 30000),
  };
}

// ─── retryable classification (fail-closed) ─────────────────────────────────

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_ERRNO = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED',
]);
const RETRYABLE_PRISMA = new Set(['P1001', 'P1002', 'P1003']); // db unreachable / starting / gone
/** Conservative message heuristics for providers that only surface strings
 * (the z-ai SDK's video path already ships this exact /429/ regex precedent). */
const RETRYABLE_MESSAGE = /429|too many requests|\b50[234]\b|fetch failed|network|econnreset|etimedout|enotfound|timed? ?out|aborterror|socket hang up/i;

/**
 * Fail-closed retryability. True ONLY for explicit transient signals:
 * 429/5xx HTTP statuses, timeouts/aborts, network-level failures, and database
 * unreachability. Provider-unavailable (breaker fail-fast) is NOT retryable.
 */
export function isRetryableError(err: unknown): boolean {
  if (!err) return false;
  const e = err as {
    code?: unknown; name?: unknown; status?: unknown; retryable?: unknown; message?: unknown; cause?: unknown;
  };
  if (typeof e.code === 'string') {
    if (e.code === 'provider_unavailable') return false; // breaker owns recovery — fail fast
    if (RETRYABLE_ERRNO.has(e.code) || RETRYABLE_PRISMA.has(e.code)) return true;
  }
  if (e.retryable === true) return true;
  if (typeof e.status === 'number') return RETRYABLE_STATUS.has(e.status);
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  if (typeof e.message === 'string' && RETRYABLE_MESSAGE.test(e.message)) return true;
  // fetch() wraps transport failures in TypeError with a cause chain
  if (e.name === 'TypeError' && e.cause !== undefined) return true;
  return false; // unknown ⇒ never retry
}

/** Read a server-requested delay (Retry-After) off a thrown error, if present. */
export function retryAfterFromError(err: unknown): number | null {
  const e = err as { retryAfterMs?: unknown };
  return typeof e?.retryAfterMs === 'number' && Number.isFinite(e.retryAfterMs) && e.retryAfterMs > 0
    ? e.retryAfterMs
    : null;
}

// ─── delay computation ───────────────────────────────────────────────────────

function computeDelay(opts: Required<Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'factor' | 'jitter'>>, attempt: number, err: unknown): number {
  const cap = Math.max(0, opts.maxDelayMs);
  const requested = retryAfterFromError(err);
  if (requested !== null) {
    // Retry-After honored verbatim, capped by the bounded law
    return Math.min(requested, cap);
  }
  const raw = Math.min(cap, opts.baseDelayMs * Math.pow(opts.factor, Math.max(0, attempt - 1)));
  if (opts.jitter <= 0) return Math.min(raw, cap);
  // full jitter: uniform in [0, raw] — also bounded by cap
  return Math.min(raw, cap) * Math.random() * Math.min(1, opts.jitter);
}

// ─── the engine ──────────────────────────────────────────────────────────────

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn` with bounded retries. `fn` receives the 1-based attempt counter.
 * NEVER throws for fn failures — the outcome object carries the verbatim last
 * error plus attempt/timing data for dead-lettering. (If `fn` itself is not a
 * function, that caller bug still throws normally.)
 */
export async function withRetries<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<RetryOutcome<T>> {
  const d = retryDefaults();
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? d.maxAttempts));
  const baseDelayMs = opts.baseDelayMs ?? d.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? d.maxDelayMs;
  const factor = opts.factor ?? 2;
  const jitter = Math.min(1, Math.max(0, opts.jitter ?? 1));
  const budgetMs = Math.max(0, opts.budgetMs ?? d.budgetMs);
  const retryOn = opts.retryOn ?? isRetryableError;
  const sleep = opts.sleep ?? defaultSleep;

  const firstAttemptAt = Date.now();
  let lastError: unknown = undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const value = await fn(attempt);
      return { ok: true, value, attempts: attempt, firstAttemptAt, finishedAt: Date.now(), stoppedBy: 'succeeded' };
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts) {
        return { ok: false, error: err, attempts: attempt, firstAttemptAt, finishedAt: Date.now(), stoppedBy: 'exhausted-attempts' };
      }
      if (!retryOn(err)) {
        return { ok: false, error: err, attempts: attempt, firstAttemptAt, finishedAt: Date.now(), stoppedBy: 'non-retryable' };
      }
      // delay: Retry-After (capped) when the server asked, else jittered backoff
      const delay = computeDelay({ baseDelayMs, maxDelayMs, factor, jitter }, attempt, err);
      // budget law: stop BEFORE sleeping if the next step would blow the budget
      const now = Date.now();
      if (now - firstAttemptAt + delay > budgetMs) {
        return { ok: false, error: err, attempts: attempt, firstAttemptAt, finishedAt: now, stoppedBy: 'budget' };
      }
      if (opts.onRetry) {
        try {
          opts.onRetry({ attempt, error: err, delayMs: delay });
        } catch {
          // observability hooks must never break the retry loop
        }
      }
      await sleep(delay);
    }
  }
  // unreachable — the loop returns from every branch
  return { ok: false, error: lastError, attempts: maxAttempts, firstAttemptAt, finishedAt: Date.now(), stoppedBy: 'exhausted-attempts' };
}

/**
 * Default retry options for provider seams (zai / openrouter): the shared env
 * knobs + the fail-closed classifier (isRetryableError) — Retry-After is
 * honored inside computeDelay via retryAfterFromError. Callers add their own
 * onRetry (metrics/logging) and tighten knobs as needed.
 */
export function defaultRetryOptions(): RetryOptions {
  return { retryOn: isRetryableError };
}
