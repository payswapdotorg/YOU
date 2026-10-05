// ═══════════════════════════════════════════════════════════════════════════
// Optimization evidence wiring (P6.C12) — pure functions over BenchmarkRun
// rows. EVIDENCE-DRIVEN ONLY: every optimization record cites the run-ids it
// is based on, and those runs must EXIST (the caller passes db rows; a cited
// run-id that resolves to no row never appears here — evidence is never
// fabricated, pairs that don't exist render as honest empty states).
//
// ZERO-IMPORT MODULE (erasable TS only): imported directly by node:test
// suites under Node >= 23.6 type stripping.
// ═══════════════════════════════════════════════════════════════════════════

// ─── The catalog (what P6.C12 changed, declared) ────────────────────────────

export interface OptimizationDeclaration {
  readonly id: 'parallel-org-evaluation' | 'deterministic-subresult-cache';
  readonly title: string;
  readonly kind: 'latency' | 'latency+cost';
  readonly changed: string;
  readonly basis: string;
  readonly note: string;
}

export const OPTIMIZATION_CATALOG: readonly OptimizationDeclaration[] = [
  {
    id: 'parallel-org-evaluation',
    title: 'Parallelized independent per-organization evaluation',
    kind: 'latency',
    changed: 'apps/web/src/lib/you/lab/benchmark.ts (P6.C12) — evaluateOrganizations now runs the independent per-org evaluations concurrently (Promise.all) instead of sequentially; the sequential path is preserved verbatim as evaluationMode "sequential" for reproduction',
    basis: 'observed wall-clock from REAL lab runs: the same worldSeed evaluated in both modes (sequential = the pre-C12 code path, parallel = the C12 default); per-org scores are unchanged by the mode (coverage/confidence/determinism are pure)',
    note: 'per-organization latencyMs scores keep their own per-org grounding measurements — parallelization changes the RUN wall-clock, never a per-org score',
  },
  {
    id: 'deterministic-subresult-cache',
    title: 'Content-hash cache for deterministic world + compiled organizations',
    kind: 'latency+cost',
    changed: 'apps/web/src/lib/you/lab/hot-path-cache.ts (P6.C12) — generateWorld/compileOrganizations behind a bounded process-local memo cache keyed by sha256 over the stable-stringified inputs',
    basis: 'observed generation wall-clock from REAL lab runs: a cold-cache run (misses) vs a warm-cache run (hits) on the same worldSeed',
    note: 'the absolute win is small (world generation + compilation are fast pure functions) — the numbers are reported as measured, never exaggerated; provider grounding calls are NEVER cached (that would fake latency evidence)',
  },
];

// ─── Run-metrics extraction ─────────────────────────────────────────────────

export interface CostLatencyRunEvidence {
  readonly evaluation: {
    readonly mode: 'sequential' | 'parallel';
    /** observed wall-clock of the evaluation stage (ms) — a real measurement. */
    readonly wallClockMs: number;
    readonly perOrgLatencyMs: number[];
  };
  readonly compile: {
    readonly worldKey: string;
    readonly worldCacheHit: boolean;
    readonly orgKey: string;
    readonly orgCacheHit: boolean;
    readonly cacheHits: number;
    readonly cacheMisses: number;
    /** observed world-generation + compilation wall-clock (ms). */
    readonly worldCompileMs: number;
  };
  readonly optimizationVersion: string;
}

/**
 * Extract the P6.C12 cost/latency evidence a lab run persisted in its metrics
 * JSON (run.metrics.costLatency). Returns null when the run predates P6.C12
 * or carries no well-formed evidence — never fabricated.
 */
export function extractCostLatency(metricsJson: string | null | undefined): CostLatencyRunEvidence | null {
  if (!metricsJson) return null;
  try {
    const parsed: unknown = JSON.parse(metricsJson);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const cl = (parsed as Record<string, unknown>).costLatency;
    if (cl === null || typeof cl !== 'object' || Array.isArray(cl)) return null;
    const e = (cl as Record<string, unknown>).evaluation as Record<string, unknown> | undefined;
    const c = (cl as Record<string, unknown>).compile as Record<string, unknown> | undefined;
    if (!e || typeof e.mode !== 'string' || (e.mode !== 'sequential' && e.mode !== 'parallel')) return null;
    if (typeof e.wallClockMs !== 'number' || !Number.isFinite(e.wallClockMs)) return null;
    if (!c || typeof c.worldCacheHit !== 'boolean' || typeof c.orgCacheHit !== 'boolean') return null;
    const perOrg = Array.isArray(e.perOrgLatencyMs)
      ? (e.perOrgLatencyMs as unknown[]).filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
      : [];
    return {
      evaluation: { mode: e.mode, wallClockMs: e.wallClockMs, perOrgLatencyMs: perOrg },
      compile: {
        worldKey: typeof c.worldKey === 'string' ? c.worldKey : '',
        worldCacheHit: c.worldCacheHit,
        orgKey: typeof c.orgKey === 'string' ? c.orgKey : '',
        orgCacheHit: c.orgCacheHit,
        cacheHits: typeof c.cacheHits === 'number' ? c.cacheHits : 0,
        cacheMisses: typeof c.cacheMisses === 'number' ? c.cacheMisses : 0,
        worldCompileMs: typeof c.worldCompileMs === 'number' ? c.worldCompileMs : 0,
      },
      optimizationVersion: typeof (cl as Record<string, unknown>).optimizationVersion === 'string'
        ? ((cl as Record<string, unknown>).optimizationVersion as string)
        : '',
    };
  } catch {
    return null;
  }
}

// ─── Pairing (before/after evidence records) ────────────────────────────────

/** A BenchmarkRun row as the db-bound caller passes it in. */
export interface RunRow {
  readonly id: string;
  readonly worldSeed: number;
  readonly metrics: string | null;
  readonly createdAt: Date;
}

export interface OptimizationSide {
  readonly runId: string;
  readonly worldSeed: number;
  readonly wallClockMs: number;
  readonly mode: 'sequential' | 'parallel';
  readonly cacheHits: number;
}

export interface OptimizationEvidenceView {
  readonly id: OptimizationDeclaration['id'];
  readonly title: string;
  readonly kind: OptimizationDeclaration['kind'];
  readonly changed: string;
  readonly basis: string;
  readonly note: string;
  /** null when no paired runs exist yet (an honest empty state, not silence). */
  readonly evidence: {
    readonly before: OptimizationSide;
    readonly after: OptimizationSide;
    /** after − before (negative = improvement). Observed, labeled. */
    readonly deltaMs: number;
    readonly improvementPct: number | null;
    readonly basis: string;
  } | null;
  readonly emptyStateReason: string;
}

function sideOf(run: RunRow, ev: CostLatencyRunEvidence): OptimizationSide {
  return {
    runId: run.id,
    worldSeed: run.worldSeed,
    wallClockMs: ev.evaluation.wallClockMs,
    mode: ev.evaluation.mode,
    cacheHits: ev.compile.cacheHits,
  };
}

/**
 * Pair before/after runs for each optimization. Rules:
 *  - parallel-org-evaluation: the LATEST 'sequential' run and the LATEST
 *    'parallel' run with the SAME worldSeed;
 *  - deterministic-subresult-cache: the LATEST cold-cache run (both caches
 *    missed) and the LATEST warm-cache run (both hit) with the same seed.
 * Runs without P6.C12 evidence are ignored (pre-C12 runs pair nothing).
 */
export function pairOptimizationEvidence(runs: readonly RunRow[]): OptimizationEvidenceView[] {
  const withEvidence = runs
    .map((run) => ({ run, ev: extractCostLatency(run.metrics) }))
    .filter((x): x is { run: RunRow; ev: CostLatencyRunEvidence } => x.ev !== null);

  const view = (decl: OptimizationDeclaration, evidence: OptimizationEvidenceView['evidence'], reason: string): OptimizationEvidenceView => ({
    id: decl.id,
    title: decl.title,
    kind: decl.kind,
    changed: decl.changed,
    basis: decl.basis,
    note: decl.note,
    evidence,
    emptyStateReason: evidence === null ? reason : '',
  });

  // ── parallel-org-evaluation ──
  const declParallel = OPTIMIZATION_CATALOG[0];
  const sequential = withEvidence
    .filter((x) => x.ev.evaluation.mode === 'sequential')
    .sort((a, b) => b.run.createdAt.getTime() - a.run.createdAt.getTime());
  const parallel = withEvidence
    .filter((x) => x.ev.evaluation.mode === 'parallel')
    .sort((a, b) => b.run.createdAt.getTime() - a.run.createdAt.getTime());
  const seqBySeed = new Map<number, (typeof sequential)[number]>();
  for (const s of sequential) if (!seqBySeed.has(s.run.worldSeed)) seqBySeed.set(s.run.worldSeed, s);
  let parallelEvidence: OptimizationEvidenceView['evidence'] = null;
  let parallelReason = 'no paired runs yet — create a lab run with evaluationMode "sequential" and one with "parallel" on the same worldSeed to record before/after evidence';
  for (const p of parallel) {
    const s = seqBySeed.get(p.run.worldSeed);
    if (!s) continue;
    const before = sideOf(s.run, s.ev);
    const after = sideOf(p.run, p.ev);
    const deltaMs = after.wallClockMs - before.wallClockMs;
    const improvementPct = before.wallClockMs > 0 ? Math.round((-deltaMs / before.wallClockMs) * 1000) / 10 : null;
    parallelEvidence = {
      before,
      after,
      deltaMs,
      improvementPct,
      basis: `observed wall-clock of the evaluation stage — before run ${s.run.id} (sequential) vs after run ${p.run.id} (parallel), same worldSeed ${p.run.worldSeed}`,
    };
    break; // latest parallel run with a same-seed sequential counterpart wins
  }

  // ── deterministic-subresult-cache ──
  const declCache = OPTIMIZATION_CATALOG[1];
  const cold = withEvidence
    .filter((x) => !x.ev.compile.worldCacheHit && !x.ev.compile.orgCacheHit)
    .sort((a, b) => b.run.createdAt.getTime() - a.run.createdAt.getTime());
  const warm = withEvidence
    .filter((x) => x.ev.compile.worldCacheHit && x.ev.compile.orgCacheHit)
    .sort((a, b) => b.run.createdAt.getTime() - a.run.createdAt.getTime());
  const coldBySeed = new Map<number, (typeof cold)[number]>();
  for (const c of cold) if (!coldBySeed.has(c.run.worldSeed)) coldBySeed.set(c.run.worldSeed, c);
  let cacheEvidence: OptimizationEvidenceView['evidence'] = null;
  let cacheReason = 'no paired runs yet — run the same worldSeed twice in one process (first run is cold-cache, second is warm-cache) to record before/after evidence';
  for (const w of warm) {
    const c = coldBySeed.get(w.run.worldSeed);
    if (!c) continue;
    const before = sideOf(c.run, c.ev);
    const after = sideOf(w.run, w.ev);
    const deltaMs = after.wallClockMs - before.wallClockMs;
    const improvementPct = before.wallClockMs > 0 ? Math.round((-deltaMs / before.wallClockMs) * 1000) / 10 : null;
    cacheEvidence = {
      before,
      after,
      deltaMs,
      improvementPct,
      basis: `observed wall-clock of the evaluation stage — cold-cache run ${c.run.id} vs warm-cache run ${w.run.id}, same worldSeed ${w.run.worldSeed} (cache keys ${c.ev.compile.worldKey} → ${w.ev.compile.worldKey})`,
    };
    break;
  }

  return [view(declParallel, parallelEvidence, parallelReason), view(declCache, cacheEvidence, cacheReason)];
}
