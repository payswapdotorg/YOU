// ═══════════════════════════════════════════════════════════════════════════
// YOU core — resilience composition (Worker A lane, P6.A6 full).
//
// Joins the pure primitives (core/retry.ts, core/breaker.ts, core/metrics.ts)
// into the two platform-wide behaviors:
//
//   withProviderResilience(provider, fn)
//     breaker → bounded retry → provider call. Every provider seam call site
//     (reconstruction vision, hosted recon, …) routes through this. A
//     retryable-class exhaustion counts ONE breaker failure; a provider that
//     ANSWERED (even 4xx) records health and never trips the breaker.
//
//   assertProviderAvailable(provider)
//     route pre-flight: when the breaker refuses, the user-facing route
//     returns an honest 503 with retry guidance instead of queueing work
//     that would hang or fail against a down provider (graceful degraded
//     state — no spins, no hangs).
//
// Env knobs (all optional, fail-closed safe defaults; see .env.example):
//   YOU_PROVIDER_MAX_ATTEMPTS / _RETRY_BASE_DELAY_MS / _RETRY_MAX_DELAY_MS
// ═══════════════════════════════════════════════════════════════════════════
import { retry, RetryExhaustedError, type RetryOptions } from './retry';
import {
  providerBreaker,
  ProviderUnavailableError,
  type ProviderName,
} from './breaker';
import { incrCounter } from './metrics';
import { HttpError } from './errors';
import { ERR } from '../contracts';

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback; // fail-closed safe default
  return n;
}

/** Provider-call retry knobs (platform-wide; per-call-site overrides possible). */
export function providerEnvRetryOptions(): Pick<RetryOptions, 'maxAttempts' | 'baseDelayMs' | 'maxDelayMs'> {
  return {
    maxAttempts: envNum('YOU_PROVIDER_MAX_ATTEMPTS', 3),
    baseDelayMs: envNum('YOU_PROVIDER_RETRY_BASE_DELAY_MS', 1_000),
    maxDelayMs: envNum('YOU_PROVIDER_RETRY_MAX_DELAY_MS', 15_000),
  };
}

/**
 * Provider retry classification (duck-typed — core never imports the ai lane):
 * - OpenRouterProviderError-style errors carry `.status`: 429/408/5xx retry
 *   (with `.retryAfterMs` honored when the provider sent Retry-After);
 * - the zai SDK surfaces verbatim error messages: a conservative network /
 *   rate-limit / timeout heuristic (disclosed: bounded by maxAttempts);
 * - a breaker refusal is never retried (the breaker governs provider health).
 */
export function providerRetryDecision(err: unknown): boolean | { retry: boolean; retryAfterMs?: number } {
  if (err instanceof ProviderUnavailableError) return false;
  if (err instanceof Error) {
    const status = (err as { status?: unknown }).status;
    const retryAfterMs = (err as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof status === 'number') {
      const retryable = status === 429 || status === 408 || status >= 500;
      if (!retryable) return false;
      if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        return { retry: true, retryAfterMs };
      }
      return true;
    }
    if (
      /429|too many requests|rate limit|timeout|timed out|network|econn|enotfound|etimedout|eai_again|fetch failed|socket hang up|bad gateway|service unavailable/i.test(
        err.message,
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Provider seam wrapper: fail fast when the breaker is open, otherwise run
 * the call with bounded retries. Retryable-class exhaustion counts one
 * breaker failure; any completed exchange records provider health.
 */
export async function withProviderResilience<T>(
  provider: ProviderName,
  fn: () => Promise<T>,
  opts?: { label?: string },
): Promise<T> {
  const label = opts?.label ?? `provider.${provider}`;
  const breaker = providerBreaker(provider);
  const verdict = breaker.canExecute();
  if (!verdict.allowed) {
    incrCounter(`breaker.rejected.${provider}`);
    throw new ProviderUnavailableError(provider, verdict.state, Math.max(0, verdict.retryAfterMs ?? 0));
  }

  try {
    const value = await retry(fn, label, {
      ...providerEnvRetryOptions(),
      retryOn: providerRetryDecision,
      onAttempt: (info) => {
        if (info.attempt > 1) {
          incrCounter('retries');
          incrCounter(`retry.${label}`);
        }
      },
    });
    breaker.recordSuccess();
    return value;
  } catch (err) {
    if (err instanceof RetryExhaustedError) {
      // retryable class ran out — this is the provider-health signal
      const wasOpen = breaker.snapshot().state === 'open';
      breaker.recordFailure();
      incrCounter(`breaker.failure.${provider}`);
      if (!wasOpen && breaker.snapshot().state === 'open') incrCounter(`breaker.opened.${provider}`);
      incrCounter('retries.exhausted');
      incrCounter(`retry.exhausted.${label}`);
      throw err;
    }
    // non-retryable: the provider ANSWERED (or the request was malformed) —
    // that is evidence of health, not outage. Never trip the breaker on it.
    breaker.recordSuccess();
    throw err;
  }
}

/**
 * Route pre-flight (graceful degraded state): throw the honest 503 envelope
 * when the provider's breaker refuses. Uses peek() — a pre-flight check must
 * not consume the half-open probe slot.
 */
export function assertProviderAvailable(provider: ProviderName): void {
  const breaker = providerBreaker(provider);
  const verdict = breaker.peek();
  if (verdict.allowed) return;
  const retryAfterSeconds = Math.max(1, Math.ceil((verdict.retryAfterMs ?? 1000) / 1000));
  throw new HttpError(
    503,
    ERR.SERVICE_UNAVAILABLE,
    `the ${provider} provider is temporarily unavailable (circuit breaker ${verdict.state}) — this request was refused fast instead of hanging; retry after ~${retryAfterSeconds}s or contact the operator to reset the breaker`,
    {
      kind: 'provider-unavailable',
      provider,
      breakerState: verdict.state,
      retryAfterSeconds,
    },
  );
}
