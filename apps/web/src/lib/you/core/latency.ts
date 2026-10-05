// ═══════════════════════════════════════════════════════════════════════════
// YOU core — latency SLOs + observed-latency recorder (Worker C, P6.C12).
//
// Declared SLOs for the hot paths (the realtime path and the API read paths)
// and a lightweight per-request measurement recorder. Every number this
// module exposes is an OBSERVATION recorded by real route handlers — no
// fabricated percentiles, no modeled latencies. When a bucket has zero
// observations its percentiles are null with an honest note (unknown is
// unknown).
//
// MEASUREMENT POINT HONESTY: the P6.A7 middleware issues the x-request-id
// but a Next.js middleware CANNOT observe response completion
// (NextResponse.next() resolves before the handler runs) — so the honest
// server-side measurement point is the route-handler wrapper
// (core/errors.ts handleRoute), which measures REAL handler wall-clock and
// records it scoped by the middleware-issued request id. This is documented
// in docs/COST_LATENCY.md.
//
// SCOPE DISCLOSURE (same class as core/metrics.ts counters): observations
// live in PROCESS-LOCAL ring buffers (the last MAX_OBSERVATIONS per bucket,
// pinned on globalThis so every route entry shares one store — the same
// next-dev module-registry law). Multi-instance deployments under-observe by
// the instance count; the /api/v1/metrics route labels this honestly instead
// of implying global truth.
//
// ZERO-IMPORT MODULE (erasable TS only): imported directly by node:test
// suites under Node >= 23.6 type stripping. App callers import it via
// '@/lib/you/core/latency'.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Declared SLOs ──────────────────────────────────────────────────────────

export const SLO_BUCKET_IDS = ['api.read', 'live.session.setup', 'live.state.stream'] as const;
export type SloBucketId = (typeof SLO_BUCKET_IDS)[number];

export interface SloDeclaration {
  readonly id: SloBucketId;
  readonly label: string;
  /** what requests the bucket observes (documented, verbatim). */
  readonly covers: string;
  /** the declared p95 target in ms (an SLO WE set, not a provider SLA). */
  readonly targetP95Ms: number;
  readonly basis: string;
}

/**
 * The declared SLOs (P6.C12). These are OUR targets for OUR hot paths —
 * declared, not measured; observations against them are recorded separately
 * and labeled `observed`.
 */
export const SLO_DECLARATIONS: readonly SloDeclaration[] = [
  {
    id: 'api.read',
    label: 'API read paths',
    covers: 'GET /api/v1/session, /api/v1/overview, /api/v1/twins, /api/v1/usage, /api/v1/metrics — handler wall-clock',
    targetP95Ms: 250,
    basis: 'declared SLO (docs/COST_LATENCY.md) — a YOU target, not a provider SLA',
  },
  {
    id: 'live.session.setup',
    label: 'Live session setup',
    covers: 'POST /api/v1/live-sessions — consent verification → LiveSession row → signaling-token mint',
    targetP95Ms: 200,
    basis: 'declared SLO (docs/COST_LATENCY.md) — a YOU target, not a provider SLA',
  },
  {
    id: 'live.state.stream',
    label: 'Agent-state stream write',
    covers: 'POST /api/v1/live-sessions/:id/state — idempotent live state-event append (the agent-state stream path)',
    targetP95Ms: 100,
    basis: 'declared SLO (docs/COST_LATENCY.md) — a YOU target, not a provider SLA',
  },
];

export function sloDeclaration(id: SloBucketId): SloDeclaration {
  const found = SLO_DECLARATIONS.find((s) => s.id === id);
  if (!found) throw new Error(`unknown SLO bucket "${id}" (known: ${SLO_BUCKET_IDS.join(', ')})`);
  return found;
}

// ─── The recorder (process-local ring buffers) ──────────────────────────────

export const MAX_OBSERVATIONS = 512;

export interface LatencyObservation {
  /** the middleware-issued x-request-id (P6.A7 observability baseline field). */
  readonly requestId: string | null;
  /** the route label passed by the handler wrapper (e.g. 'GET /api/v1/twins'). */
  readonly route: string;
  readonly method: string;
  readonly status: number;
  /** observed handler wall-clock in ms — a real measurement, never modeled. */
  readonly durationMs: number;
  readonly at: string;
}

interface LatencyGlobalStore {
  __youLatency?: Map<SloBucketId, LatencyObservation[]>;
  __youLatencyBreaches?: Map<SloBucketId, number>;
  __youLatencyTotal?: Map<SloBucketId, number>;
}
const latencyGlobal = globalThis as typeof globalThis & LatencyGlobalStore;
const buffers: Map<SloBucketId, LatencyObservation[]> = (latencyGlobal.__youLatency ??= new Map());
const breachCounts: Map<SloBucketId, number> = (latencyGlobal.__youLatencyBreaches ??= new Map());
const totals: Map<SloBucketId, number> = (latencyGlobal.__youLatencyTotal ??= new Map());

function bucketBuffer(bucket: SloBucketId): LatencyObservation[] {
  let buf = buffers.get(bucket);
  if (!buf) {
    buf = [];
    buffers.set(bucket, buf);
  }
  return buf;
}

/**
 * Record one REAL observation. A duration above the declared p95 target
 * counts as a breach (the counter is lifetime, not ring-buffer-scoped —
 * disclosed in the snapshot). Never throws: measurement must not break the
 * measured path (the same law as core/metrics.ts bumpCounter).
 */
export function recordLatency(
  bucket: SloBucketId,
  obs: { requestId?: string | null; route: string; method: string; status: number; durationMs: number; at?: Date },
): void {
  try {
    const decl = sloDeclaration(bucket);
    const observation: LatencyObservation = {
      requestId: typeof obs.requestId === 'string' && obs.requestId.length > 0 ? obs.requestId : null,
      route: obs.route,
      method: obs.method,
      status: obs.status,
      durationMs: obs.durationMs,
      at: (obs.at ?? new Date()).toISOString(),
    };
    const buf = bucketBuffer(bucket);
    buf.push(observation);
    if (buf.length > MAX_OBSERVATIONS) buf.splice(0, buf.length - MAX_OBSERVATIONS);
    totals.set(bucket, (totals.get(bucket) ?? 0) + 1);
    if (observation.durationMs > decl.targetP95Ms) {
      breachCounts.set(bucket, (breachCounts.get(bucket) ?? 0) + 1);
    }
  } catch {
    // never let a measurement bug take down the measured path
  }
}

// ─── Percentiles (nearest-rank over real observations only) ─────────────────

/**
 * Nearest-rank percentile over a sorted list — NO interpolation. The result
 * is always a REAL observed value (or null when there are no observations).
 * p must be in (0, 100].
 */
export function nearestRankPercentile(sortedDurations: readonly number[], p: number): number | null {
  if (sortedDurations.length === 0) return null;
  if (!(p > 0 && p <= 100)) return null;
  const idx = Math.min(sortedDurations.length - 1, Math.ceil((p / 100) * sortedDurations.length) - 1);
  return sortedDurations[Math.max(0, idx)];
}

// ─── Snapshot (the /api/v1/metrics surface) ─────────────────────────────────

export interface SloStatView {
  readonly id: SloBucketId;
  readonly label: string;
  readonly covers: string;
  readonly targetP95Ms: number;
  readonly basis: string;
  /** ring-buffer-resident observation count. */
  readonly observations: number;
  /** lifetime observations recorded by this process (≥ observations). */
  readonly totalObservations: number;
  /** lifetime p95-target breaches (a counter, not ring-buffer-scoped). */
  readonly breaches: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly percentileMethod: string;
  readonly lastObservation: LatencyObservation | null;
}

export function latencySnapshot(): { slos: SloStatView[]; scope: string; honesty: string[] } {
  const slos: SloStatView[] = SLO_DECLARATIONS.map((decl) => {
    const buf = buffers.get(decl.id) ?? [];
    const sorted = buf.map((o) => o.durationMs).sort((a, b) => a - b);
    const p50 = nearestRankPercentile(sorted, 50);
    const p95 = nearestRankPercentile(sorted, 95);
    return {
      id: decl.id,
      label: decl.label,
      covers: decl.covers,
      targetP95Ms: decl.targetP95Ms,
      basis: decl.basis,
      observations: buf.length,
      totalObservations: totals.get(decl.id) ?? 0,
      breaches: breachCounts.get(decl.id) ?? 0,
      p50Ms: p50,
      p95Ms: p95,
      percentileMethod:
        'nearest-rank over the last ≤512 observed durations (process-local ring buffer) — every percentile is a REAL observed value; null when no observations exist',
      lastObservation: buf.length > 0 ? buf[buf.length - 1] : null,
    };
  });
  return {
    slos,
    scope: 'process-local ring buffers (last 512 per SLO) — multi-instance deployments aggregate at the collector',
    honesty: [
      'p50/p95 are computed from observed handler wall-clock only — no modeled latencies, no fabricated percentiles',
      'zero observations → null percentiles (unknown is unknown)',
      'targets are DECLARED SLOs (docs/COST_LATENCY.md), not provider SLAs',
    ],
  };
}

/** Lifetime SLO-breach counters in the canonical counter-key form. */
export function sloBreachCounters(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const decl of SLO_DECLARATIONS) {
    const n = breachCounts.get(decl.id) ?? 0;
    out[`slo_breaches{bucket=${decl.id}}`] = n;
  }
  return out;
}

/** Test-only: drop all observations, breach counters and totals. */
export function resetLatencyForTests(): void {
  buffers.clear();
  breachCounts.clear();
  totals.clear();
}
