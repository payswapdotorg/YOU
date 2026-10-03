// ═══════════════════════════════════════════════════════════════════════════
// YOU core — bounded retry helper (Worker A lane, P6.A6 full).
//
// The ONE shared retry primitive for the platform: provider calls, outbound
// webhook deliveries and durable-job execution all route through it.
//
// Laws (docs/PRODUCTION_CHECKLIST.md "bounded retries"):
// - NEVER infinite: maxAttempts is a hard cap on total attempts (>= 1);
// - budgets STOP: an optional wall-clock budget (budgetMs) cuts the loop
//   short instead of sleeping past the deadline — the failure surfaces as
//   RetryExhaustedError with stoppedBy: 'budget';
// - exponential backoff with jitter (default FULL jitter: delay * random());
// - Retry-After is HONORED: when the classifier returns retryAfterMs (parsed
//   from a 429/503), the wait is never shorter than the server's demand;
// - non-retryable errors propagate UNTOUCHED (original type and message) —
//   callers classify, this module only executes their decision;
// - per-call attempt counters: every attempt reports through onAttempt (the
//   metrics surface aggregates them) and exhaustion carries `attempts`.
//
// This module is deliberately IMPORT-FREE (pure logic + injectable clock and
// sleep) so the node:test suite can import it directly via type stripping.
// ═══════════════════════════════════════════════════════════════════════════

/** Classifier verdict: false/true shorthand, or retry-after guidance. */
export type RetryDecision = boolean | { retry: boolean; retryAfterMs?: number };

/** Observable per-attempt facts (counters/telemetry hook). */
export interface RetryAttemptInfo {
  label: string;
  attempt: number; // 1-based, the attempt that just finished
  ok: boolean;
  willRetry: boolean; // a retry was actually scheduled
  nextDelayMs: number | null; // planned wait before the next attempt
  error?: unknown;
  durationMs: number; // real wall-clock duration of the attempt itself
}

export interface RetryOptions {
  /** total attempts (the first one included). Hard cap — never more. */
  maxAttempts: number;
  /** first retry delay; grows by `factor` per attempt. */
  baseDelayMs: number;
  /** ceiling for the computed backoff (NOT for a server Retry-After). */
  maxDelayMs: number;
  /** exponential growth factor (default 2). */
  factor?: number;
  /** wall-clock budget for the whole call (attempts + waits). Unset = attempts-only bound. */
  budgetMs?: number;
  /** decides whether an error is worth retrying (and any server retry-after). */
  retryOn: (err: unknown) => RetryDecision;
  /** per-attempt hook — the "per-call attempt counter" surface. */
  onAttempt?: (info: RetryAttemptInfo) => void;
  /** injectable sleep (tests pass a recorder); default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** injectable jitter (tests pass a deterministic fn); default full jitter. */
  jitter?: (delayMs: number, attempt: number) => number;
  /** injectable clock (tests control time); default Date.now. */
  now?: () => number;
}

/** Exhaustion of a RETRYABLE class: attempts or budget ran out. */
export class RetryExhaustedError extends Error {
  readonly label: string;
  readonly attempts: number;
  readonly stoppedBy: 'attempts' | 'budget';
  readonly lastError: unknown;
  constructor(label: string, attempts: number, stoppedBy: 'attempts' | 'budget', lastError: unknown) {
    const causeMessage =
      lastError instanceof Error ? lastError.message : typeof lastError === 'string' ? lastError : JSON.stringify(lastError);
    super(`retry(${label}) stopped after ${attempts} attempt(s) — ${stoppedBy} — last error: ${causeMessage}`);
    this.name = 'RetryExhaustedError';
    this.label = label;
    this.attempts = attempts;
    this.stoppedBy = stoppedBy;
    this.lastError = lastError;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);
}

function normalizeDecision(decision: RetryDecision): { retry: boolean; retryAfterMs?: number } {
  if (typeof decision === 'boolean') return { retry: decision };
  return decision;
}

/**
 * Run `fn` with bounded retries. Returns the first successful value; throws
 * the ORIGINAL error when it is not retryable, or RetryExhaustedError when
 * the retryable class ran out of attempts or budget.
 */
export async function retry<T>(fn: (attempt: number) => Promise<T>, label: string, opts: RetryOptions): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts));
  const factor = typeof opts.factor === 'number' && opts.factor > 1 ? opts.factor : 2;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const jitter = opts.jitter ?? ((delayMs: number) => Math.random() * delayMs); // full jitter
  const now = opts.now ?? Date.now;
  const deadline =
    typeof opts.budgetMs === 'number' && Number.isFinite(opts.budgetMs) && opts.budgetMs > 0
      ? now() + opts.budgetMs
      : null;

  let attempts = 0;
  for (;;) {
    attempts += 1;
    const attemptStartedAt = now();
    let value: T;
    try {
      value = await fn(attempts);
    } catch (err) {
      const decision = normalizeDecision(opts.retryOn(err));
      const canRetryByCount = attempts < maxAttempts;
      let delayMs: number | null = null;
      if (decision.retry && canRetryByCount) {
        const raw = Math.min(opts.maxDelayMs, opts.baseDelayMs * Math.pow(factor, attempts - 1));
        delayMs = Math.max(0, Math.floor(jitter(raw, attempts)));
        const retryAfterMs = decision.retryAfterMs;
        if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
          // honor the server's demand: never wait LESS than Retry-After
          // (maxDelayMs caps only the backoff half, not the server's floor)
          delayMs = Math.max(delayMs, Math.floor(retryAfterMs));
        }
      }
      const budgetLeft = deadline !== null ? deadline - now() : null;
      const budgetStops = budgetLeft !== null && budgetLeft <= delayMs!;
      const willRetry = decision.retry && canRetryByCount && !budgetStops;

      opts.onAttempt?.({
        label,
        attempt: attempts,
        ok: false,
        willRetry,
        nextDelayMs: willRetry ? delayMs : null,
        error: err,
        durationMs: Math.max(0, now() - attemptStartedAt),
      });

      if (!decision.retry) throw err; // non-retryable: original error, untouched
      if (!willRetry) {
        throw new RetryExhaustedError(label, attempts, budgetStops ? 'budget' : 'attempts', err);
      }
      await sleep(delayMs!);
      continue;
    }
    opts.onAttempt?.({
      label,
      attempt: attempts,
      ok: true,
      willRetry: false,
      nextDelayMs: null,
      durationMs: Math.max(0, now() - attemptStartedAt),
    });
    return value;
  }
}
