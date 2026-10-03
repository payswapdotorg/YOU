// ═══════════════════════════════════════════════════════════════════════════
// YOU core — in-process metrics counters (Worker A lane, P6.A6 full).
//
// Minimal counter surface backing GET /api/v1/metrics:
//   retries / retry.<label>        — every re-attempt through the shared helper
//   retries.exhausted              — retry loops that ran out (attempts/budget)
//   jobs.dead                      — durable jobs that exhausted retries
//   breaker.opened.<provider>      — closed→open transitions
//   breaker.rejected.<provider>     — calls refused while open (fail-fast)
//   breaker.failure.<provider>      — retryable-class provider exhaustions
//   ratelimit.hits / .<bucket>     — 429s thrown by the interim limiter
//   webhook.delivered / .failed    — delivery outcomes
//
// Counters live on globalThis (symbol-keyed): one set per server process,
// shared across Next route bundles / HMR reloads in dev. Process-local by
// design (same disclosed limitation as the rate limiter — multi-instance
// aggregation needs the P6.T3 shared store). resetCounters() exists for the
// test suite only.
//
// IMPORT-FREE so node:test can import it directly via type stripping.
// ═══════════════════════════════════════════════════════════════════════════

const COUNTERS_KEY = Symbol.for('you.core.metrics.counters');

interface MetricsStore {
  counters: Map<string, number>;
}

function store(): Map<string, number> {
  const g = globalThis as Record<symbol, MetricsStore | undefined>;
  let s = g[COUNTERS_KEY];
  if (!s) {
    s = { counters: new Map() };
    g[COUNTERS_KEY] = s;
  }
  return s.counters;
}

/** Increment a counter (no-op on invalid names; counters never throw). */
export function incrCounter(name: string, by = 1): void {
  if (!name) return;
  try {
    const map = store();
    map.set(name, (map.get(name) ?? 0) + by);
  } catch {
    // metrics must never take down the path they observe
  }
}

/** Plain-object snapshot (counter name → value). */
export function countersSnapshot(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, value] of store()) out[name] = value;
  return out;
}

/** Test seam: zero every counter. */
export function resetCounters(): void {
  store().clear();
}
