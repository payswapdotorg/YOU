// ═══════════════════════════════════════════════════════════════════════════
// YOU core — in-process metrics counters (Worker A lane, P6.A6-FULL).
//
// Minimal counter registry for the resilience surface exposed by
// GET /api/v1/metrics (operator-session gated): retry counters, dead-letter
// counts, rate-limit hits. Breaker state is NOT stored here — the circuit
// breaker owns its own snapshot (core/circuit-breaker.ts) and the metrics
// route composes both.
//
// Scope disclosure (same class as the P6.A6-interim rate limiter): counters
// are PROCESS-LOCAL. Multi-instance deployments under-count by the instance
// count; the shared-store (Upstash) adoption is the pending full-A6 item.
// The metrics route labels this scope honestly instead of implying global
// truth.
//
// SHARING NOTE (F-07 class, same as circuit-breaker.ts / db.ts): next dev
// compiles each route entry with its own module registry, so the counter Map
// is pinned on globalThis — every route entry that links this module bumps
// and reads the SAME process-wide counters (the job runner's provider
// retries are visible to the /api/v1/metrics route, etc).
//
// ZERO-IMPORT MODULE (erasable TS only): imported directly by node:test unit
// suites under Node >= 23.6 type stripping — no `@/` aliases, no runtime
// dependencies. Callers in the app import it via '@/lib/you/core/metrics'.
// ═══════════════════════════════════════════════════════════════════════════

export type CounterLabels = Record<string, string | number>;

/** Canonical key: `name{k=v,...}` with deterministic label order. */
export function counterKey(name: string, labels?: CounterLabels): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${String(labels[k])}`);
  return `${name}{${parts.join(',')}}`;
}

/** globalThis pinning surface (see SHARING NOTE above). */
interface MetricsGlobalStore {
  __youCounters?: Map<string, number>;
}
const metricsGlobal = globalThis as typeof globalThis & MetricsGlobalStore;
const counters: Map<string, number> = (metricsGlobal.__youCounters ??= new Map<string, number>());

/** Increment a labeled counter (never throws — metrics must not break calls). */
export function bumpCounter(name: string, labels?: CounterLabels, by = 1): void {
  try {
    const key = counterKey(name, labels);
    counters.set(key, (counters.get(key) ?? 0) + by);
  } catch {
    // never let a metrics bug take down the measured path
  }
}

/** Point-in-time snapshot of every counter (canonical keys, plain numbers). */
export function counterSnapshot(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of counters) out[k] = v;
  return out;
}

/** Test-only: drop all counters. */
export function resetMetricsForTests(): void {
  counters.clear();
}
