// ═══════════════════════════════════════════════════════════════════════════
// YOU core — per-tenant rate limiting (Worker A lane, P6.A6 interim).
//
// Fixed-window counters in process memory. This is the INTERIM control that
// closes security-review finding O-1's near-term option; the full A6 item
// moves the counters to Upstash Redis once P6.T3 provisions it (multi-
// instance correctness needs the shared store — a per-instance counter
// under-counts by the instance count, which is disclosed here and bounded
// by the deployment size).
//
// Laws:
// - fail-open on limiter internals (availability beats a broken counter),
//   but the LIMITS themselves are enforced before any handler work;
// - 429 responses carry ERR.rate_limited + Retry-After (seconds to window
//   reset) — the documented contract code that existed unused until now;
// - keys are (bucket, identity): identity = tenantId when authenticated,
//   client IP for the unauthenticated session bootstrap;
// - memory is bounded: windows are pruned lazily (at most one entry per
//   bucket+identity per window; entries expire by reset time).
// ═══════════════════════════════════════════════════════════════════════════
import { ERR } from '../contracts';
import { HttpError } from './errors';
import { bumpCounter } from './metrics';

interface Window {
  count: number;
  resetAt: number; // epoch ms
}

const windows = new Map<string, Window>();
let lastPrune = 0;

function prune(now: number): void {
  // lazy prune at most once per window-minute — keeps the map bounded
  if (now - lastPrune < 60_000) return;
  lastPrune = now;
  for (const [k, w] of windows) {
    if (w.resetAt <= now) windows.delete(k);
  }
}

export interface RateLimit {
  limit: number;
  windowMs: number;
}

/** Default limits (env-overridable): conservative per-identity ceilings. */
export function limits(): Record<string, RateLimit> {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    'session-bootstrap': { limit: num(process.env.YOU_RATE_LIMIT_SESSION_PER_MIN, 30), windowMs: 60_000 },
    'asset-upload': { limit: num(process.env.YOU_RATE_LIMIT_UPLOAD_PER_MIN, 60), windowMs: 60_000 },
    'api-key-mutation': { limit: num(process.env.YOU_RATE_LIMIT_KEY_PER_MIN, 10), windowMs: 60_000 },
  };
}

/** Client IP for unauthenticated buckets: first x-forwarded-for hop, else 'unknown'. */
export function clientIdentity(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0].trim();
    if (first) return first;
  }
  return 'unknown';
}

/**
 * Enforce a fixed-window limit. Throws HttpError(429, rate_limited) with a
 * Retry-After when the window is exhausted; returns normally otherwise.
 */
export function enforceRateLimit(bucket: string, identity: string, rl?: RateLimit): void {
  try {
    const now = Date.now();
    prune(now);
    const rule = rl ?? limits()[bucket];
    if (!rule) return; // unknown bucket — never block on a config miss
    const key = `${bucket}:${identity}`;
    const w = windows.get(key);
    if (!w || w.resetAt <= now) {
      windows.set(key, { count: 1, resetAt: now + rule.windowMs });
      return;
    }
    w.count += 1;
    if (w.count > rule.limit) {
      const retryAfterSec = Math.max(1, Math.ceil((w.resetAt - now) / 1000));
      // P6.A6-FULL: every enforced rejection is counted for /api/v1/metrics
      bumpCounter('rate_limit_hits', { bucket });
      throw new HttpError(
        429,
        ERR.RATE_LIMITED,
        `rate limit exceeded for ${bucket} — retry after ${retryAfterSec}s`,
        { bucket, limit: rule.limit, windowMs: rule.windowMs, retryAfterSeconds: retryAfterSec },
      );
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // limiter internals must never take the route down (fail open, disclosed)
    console.error('[you/ratelimit] internal failure (fail-open):', err instanceof Error ? err.message : err);
  }
}
