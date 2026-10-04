// ═══════════════════════════════════════════════════════════════════════════
// Benchmark run manifests + run comparison + artifact export (Worker C lane,
// P6.C11 — "benchmark artifacts" deliverable of P10).
//
// ZERO-IMPORT MODULE LAW (game-export.ts / try-on.ts precedent): no db, no
// storage, no crypto, no SDK imports — everything environmental (runtime
// versions, the sha256 function, loaded rows) is passed in by the executor
// or the route. node:test imports this file directly and exercises the
// CONTRACT, not the wiring.
//
// HONESTY MODEL (unchanged from the harness):
// - A run manifest is WRITE-ONCE: it is built once at job execution from the
//   run's real inputs (world seed, genome refs, technology versions,
//   environment fingerprint, per-stage provider/model/compute-provider) and
//   is never mutated afterwards. Any re-run is a NEW run whose manifest
//   references its parent via rerunOf. No timestamps inside the manifest —
//   the run row itself carries createdAt/finishedAt.
// - Every manifest entry is labeled: technology versions are structural
//   (verbatim from the genome stages) or observed (the real grounding-call
//   model); per-stage provider/model/compute entries are modeled (the
//   deterministic simulation) or observed (the real provider call).
// - Run comparison NEVER thresholds a one-shot observed latency — a single
//   wall-clock measurement is not regression evidence. Observed components
//   are displayed and labeled, but only deterministic/modeled metrics feed
//   the regression flags.
// ═══════════════════════════════════════════════════════════════════════════
import type { PipelineGenome } from '../contracts';
// NOTE: relative imports carry explicit .ts extensions (the ai/render-provider.ts
// precedent) so node:test's type-stripping resolver can load this contract core
// directly — the extensionless bundler specifiers are not resolvable under
// plain Node ESM.
import { clamp, round, stableStringify } from './determinism.ts';

// ─── Manifest ────────────────────────────────────────────────────────────────

export const RUN_MANIFEST_VERSION = 1;
export const RUN_MANIFEST_TYPE = 'you.lab.run-manifest/v1';
export const RUN_ARTIFACT_TYPE = 'you.lab.benchmark-run/v1';

export type LabScenario = 'human-recon-001' | 'soul-swap-001';

/** Provider/compute profile per known lab stage adapter — no invented providers. */
const STAGE_PROVIDER_PROFILE: Record<string, { provider: string; localModel: string | null; computeProvider: string }> = {
  'lab-segment-1': { provider: 'local-sim', localModel: 'lab-segmenter-sim-1', computeProvider: 'cpu-local-sim' },
  'vlm-recon-1': { provider: 'zai', localModel: null, computeProvider: 'zai-hosted-api' },
  'lab-merge-1': { provider: 'local-sim', localModel: 'lab-merger-sim-1', computeProvider: 'cpu-local-sim' },
  'lab-qa-1': { provider: 'local-sim', localModel: 'lab-qa-sim-1', computeProvider: 'cpu-local-sim' },
};

export interface RunManifestStage {
  adapterId: string;
  role: string;
  provider: string;
  model: string | null;
  computeProvider: string;
  basis: 'modeled' | 'observed';
}

export interface RunManifestGenome {
  pipelineId: string;
  name: string;
  generation: number;
  origin: string;
  stages: Array<{ adapterId: string; version: string; role: string }>;
}

export interface RunManifestTechnologyVersion {
  component: string;
  version: string;
  basis: 'structural' | 'observed';
}

export interface RunManifestOrganization {
  organizationId: string;
  origin: string;
  pipelineId: string;
  stages: RunManifestStage[];
}

export interface RunManifest {
  manifestType: typeof RUN_MANIFEST_TYPE;
  schemaVersion: number;
  objectiveCode: string;
  scenario: LabScenario;
  worldSeed: number;
  worldId: string;
  deterministic: true;
  writeOnce: true;
  rerunOf: string | null;
  genomes: RunManifestGenome[];
  technologyVersions: RunManifestTechnologyVersion[];
  environment: {
    runtime: { node: string | null; bun: string | null };
    harness: string;
    deterministicFlag: true;
    determinismNote: string;
  };
  organizations: RunManifestOrganization[];
  honesty: {
    model: string;
    labels: Record<string, string>;
    simulated: true;
    simulationNote: string;
  };
}

/** Metric → honesty label per scenario (the harness's labels, verbatim). */
const SCENARIO_LABELS: Record<LabScenario, Record<string, string>> = {
  'human-recon-001': {
    coverage: 'modeled (deterministic seeded-world simulation)',
    confidence: 'modeled (deterministic seeded-world simulation)',
    latencyMs: 'mixed: modeled per-stage latencies + ONE observed provider grounding call per organization',
    costUsd: 'modeled (provider pricing is not exposed to this sandbox)',
    determinism: 'observed (pure recomputation equality check)',
  },
  'soul-swap-001': {
    continuity: 'modeled (deterministic seeded-world simulation)',
    drift: 'modeled (deterministic seeded-world simulation)',
    capabilityRetention: 'modeled (deterministic seeded-world simulation)',
    latencyMs: 'mixed: modeled per-stage latencies + ONE observed provider grounding call per organization',
    costUsd: 'modeled (provider pricing is not exposed to this sandbox)',
    determinism: 'observed (pure recomputation equality check)',
  },
};

export interface BuildRunManifestArgs {
  objectiveCode: string;
  scenario: LabScenario;
  worldSeed: number;
  worldId: string;
  rerunOf?: string | null;
  genomes: Array<{
    pipelineId: string;
    name: string;
    generation: number;
    origin: string;
    genome: PipelineGenome;
  }>;
  /** Per-organization grounding outcome (provider model observed or failed). */
  organizations: Array<{
    organizationId: string;
    origin: string;
    pipelineId: string;
    grounding: { real: boolean; model: string | null };
  }>;
  environment: {
    runtime: { node: string | null; bun: string | null };
    harness?: string;
  };
}

/**
 * Build the write-once run manifest. Deterministic: same args → identical
 * manifest (stable construction order, sorted collections, no clocks).
 */
export function buildRunManifest(args: BuildRunManifestArgs): RunManifest {
  const genomes: RunManifestGenome[] = [...args.genomes]
    .sort((a, b) => (a.pipelineId < b.pipelineId ? -1 : a.pipelineId > b.pipelineId ? 1 : 0))
    .map((g) => ({
      pipelineId: g.pipelineId,
      name: g.name,
      generation: g.generation,
      origin: g.origin,
      stages: g.genome.stages.map((s) => ({
        adapterId: s.adapterId,
        version: s.version,
        role: String(s.params.role ?? (s.adapterId === 'vlm-recon-1' ? 'analyze' : 'stage')),
      })),
    }));

  // technology versions: the union of stage adapter versions across genomes
  // (structural — verbatim from the genomes) + the observed grounding model.
  const techMap = new Map<string, RunManifestTechnologyVersion>();
  for (const g of genomes) {
    for (const s of g.stages) {
      const key = `${s.adapterId}@${s.version}`;
      if (!techMap.has(key)) {
        techMap.set(key, { component: s.adapterId, version: s.version, basis: 'structural' });
      }
    }
  }
  const observedModels = new Set<string>();
  for (const org of args.organizations) {
    if (org.grounding.real && org.grounding.model) observedModels.add(org.grounding.model);
  }
  for (const model of observedModels) {
    const key = `vlm-recon-1-grounding@${model}`;
    techMap.set(key, { component: 'vlm-recon-1-grounding', version: model, basis: 'observed' });
  }
  const technologyVersions = [...techMap.values()].sort((a, b) =>
    a.component < b.component ? -1 : a.component > b.component ? 1 : a.version < b.version ? -1 : 1,
  );

  // per-organization stage profiles — derived from each org's genome stages
  const genomeByPipeline = new Map(args.genomes.map((g) => [g.pipelineId, g.genome]));
  const groundingByOrg = new Map(args.organizations.map((o) => [o.organizationId, o.grounding]));
  const organizations: RunManifestOrganization[] = [...args.organizations]
    .sort((a, b) => (a.organizationId < b.organizationId ? -1 : 1))
    .map((o) => {
      const genome = genomeByPipeline.get(o.pipelineId);
      const grounding = groundingByOrg.get(o.organizationId);
      const stages: RunManifestStage[] = (genome?.stages ?? []).map((s) => {
        const profile = STAGE_PROVIDER_PROFILE[s.adapterId];
        if (!profile) {
          return {
            adapterId: s.adapterId,
            role: String(s.params.role ?? 'stage'),
            provider: 'unknown',
            model: null,
            computeProvider: 'unknown',
            basis: 'modeled' as const,
          };
        }
        if (s.adapterId === 'vlm-recon-1') {
          const observedModel = grounding?.real ? grounding.model : null;
          return {
            adapterId: s.adapterId,
            role: String(s.params.role ?? 'analyze'),
            provider: profile.provider,
            model: observedModel,
            computeProvider: profile.computeProvider,
            basis: observedModel ? ('observed' as const) : ('modeled' as const),
          };
        }
        return {
          adapterId: s.adapterId,
          role: String(s.params.role ?? 'stage'),
          provider: profile.provider,
          model: profile.localModel,
          computeProvider: profile.computeProvider,
          basis: 'modeled' as const,
        };
      });
      return { organizationId: o.organizationId, origin: o.origin, pipelineId: o.pipelineId, stages };
    });

  return {
    manifestType: RUN_MANIFEST_TYPE,
    schemaVersion: RUN_MANIFEST_VERSION,
    objectiveCode: args.objectiveCode,
    scenario: args.scenario,
    worldSeed: args.worldSeed,
    worldId: args.worldId,
    deterministic: true,
    writeOnce: true,
    rerunOf: args.rerunOf ?? null,
    genomes,
    technologyVersions,
    environment: {
      runtime: {
        node: args.environment.runtime.node ?? null,
        bun: args.environment.runtime.bun ?? null,
      },
      harness: args.environment.harness ?? 'lab.benchmark@1',
      deterministicFlag: true,
      determinismNote:
        'same world seed + same genomes + same environment → identical benchmark metrics (pure-metric recomputation check inside the harness); observed provider latencies are measurements and are excluded from the check',
    },
    organizations,
    honesty: {
      model: 'every number is labeled modeled or observed',
      labels: SCENARIO_LABELS[args.scenario],
      simulated: true,
      simulationNote:
        'Lab benchmark results are SIMULATED research truth (deterministic seeded simulation + explicitly-labeled real provider grounding measurements); never production human truth',
    },
  };
}

// ─── Write-once law (immutability) ───────────────────────────────────────────

export const RUN_TERMINAL_STATUSES = ['succeeded', 'failed'] as const;

/**
 * The write-once decision: a queued/running run may still be filled in by its
 * own job; a TERMINAL run (succeeded/failed) must never be mutated — a
 * re-run targets a NEW row carrying rerunOf = the original id.
 */
export function runIsFillable(status: string): boolean {
  return !(RUN_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * The executor's write-once targeting decision, PURE: given the job's
 * benchmarkRunId and the existing row's status (null = no row), decide which
 * row gets written and what rerunOf lands in the manifest. A TERMINAL row is
 * NEVER the target — the re-run becomes a NEW row referencing it as parent.
 */
export function resolveWriteOnceTarget(args: {
  benchmarkRunId: string | null;
  /** status of the row at benchmarkRunId; null when the id is absent/unfound */
  existingStatus: string | null;
  /** rerunOf carried by the job input (POST /runs rerunOf) */
  rerunOfFromInput?: string | null;
}): { targetRunId: string | null; rerunOfId: string | null; createdNewRun: boolean } {
  if (
    args.benchmarkRunId &&
    args.existingStatus !== null &&
    !runIsFillable(args.existingStatus)
  ) {
    // the job pointed at a TERMINAL run — never mutate it: new row, parent ref
    return { targetRunId: null, rerunOfId: args.benchmarkRunId, createdNewRun: true };
  }
  return {
    targetRunId: args.benchmarkRunId,
    rerunOfId: args.rerunOfFromInput ?? null,
    createdNewRun: args.benchmarkRunId === null,
  };
}

// ─── Run comparison + regression detection ───────────────────────────────────

export interface RegressionThresholds {
  /** absolute allowed drop in coverage (higher-better). Default 0.05. */
  coverageDownMax: number;
  /** absolute allowed drop in confidence. Default 0.05. */
  confidenceDownMax: number;
  /** absolute allowed drop in determinism (0/1 flag — any drop flags). Default 0. */
  determinismDownMax: number;
  /** absolute allowed drop in continuity (soul-swap). Default 0.05. */
  continuityDownMax: number;
  /** absolute allowed drop in capabilityRetention (soul-swap). Default 0.05. */
  capabilityRetentionDownMax: number;
  /** absolute allowed rise in drift (soul-swap, lower-better). Default 0.05. */
  driftUpMax: number;
  /** relative allowed rise in latencyMs. Default 0.10 (10%). */
  latencyUpMaxPct: number;
  /** relative allowed rise in costUsd. Default 0.10 (10%). */
  costUpMaxPct: number;
}

export const DEFAULT_REGRESSION_THRESHOLDS: RegressionThresholds = {
  coverageDownMax: 0.05,
  confidenceDownMax: 0.05,
  determinismDownMax: 0,
  continuityDownMax: 0.05,
  capabilityRetentionDownMax: 0.05,
  driftUpMax: 0.05,
  latencyUpMaxPct: 0.1,
  costUpMaxPct: 0.1,
};

export const REGRESSION_THRESHOLD_DOCS: Record<string, string> = {
  coverageDownMax: 'absolute coverage drop allowed before a per-org regression flag (default 0.05)',
  confidenceDownMax: 'absolute confidence drop allowed (default 0.05)',
  determinismDownMax: 'absolute determinism drop allowed (default 0 — any 1→0 drop flags)',
  continuityDownMax: 'absolute continuity drop allowed, soul-swap scenario (default 0.05)',
  capabilityRetentionDownMax: 'absolute capabilityRetention drop allowed, soul-swap scenario (default 0.05)',
  driftUpMax: 'absolute drift rise allowed, soul-swap scenario (default 0.05)',
  latencyUpMaxPct: 'relative latencyMs rise allowed (default 0.10 = 10% over baseline)',
  costUpMaxPct: 'relative costUsd rise allowed (default 0.10 = 10% over baseline)',
};

/** Metric → direction. Unknown metrics are compared but never flagged (honest). */
const METRIC_DIRECTION: Record<string, 'higher-better' | 'lower-better' | undefined> = {
  coverage: 'higher-better',
  confidence: 'higher-better',
  determinism: 'higher-better',
  continuity: 'higher-better',
  capabilityRetention: 'higher-better',
  latencyMs: 'lower-better',
  costUsd: 'lower-better',
  drift: 'lower-better',
};

/** Absolute-drop thresholds per higher-better metric. */
const ABSOLUTE_DROP_THRESHOLD: Record<string, keyof RegressionThresholds> = {
  coverage: 'coverageDownMax',
  confidence: 'confidenceDownMax',
  determinism: 'determinismDownMax',
  continuity: 'continuityDownMax',
  capabilityRetention: 'capabilityRetentionDownMax',
};

/** Absolute-rise thresholds per lower-better metric. */
const ABSOLUTE_RISE_THRESHOLD: Record<string, keyof RegressionThresholds> = {
  drift: 'driftUpMax',
};

/** Relative-rise thresholds per lower-better metric. */
const RELATIVE_RISE_THRESHOLD: Record<string, keyof RegressionThresholds> = {
  latencyMs: 'latencyUpMaxPct',
  costUsd: 'costUpMaxPct',
};

export interface CompareStageRow {
  adapterId: string;
  role: string;
  baselineModeledLatencyMs: number;
  candidateModeledLatencyMs: number;
  deltaModeledLatencyMs: number;
  baselineModeledCostUsd: number;
  candidateModeledCostUsd: number;
  deltaModeledCostUsd: number;
  /** one-shot measurements — displayed, never thresholded */
  observedLatencyMs: { baseline: number | null; candidate: number | null };
}

export interface CompareMetricRow {
  metric: string;
  direction: 'higher-better' | 'lower-better' | 'unknown';
  baselineValue: number;
  candidateValue: number;
  delta: number;
  deltaKind: 'absolute' | 'relative-pct' | 'none';
  changed: boolean;
}

export interface RegressionFlag {
  organizationId: string;
  metric: string;
  kind: 'absolute' | 'relative';
  threshold: number;
  observed: number;
  detail: string;
}

export interface CompareOrganizationRow {
  organizationId: string;
  presentIn: { baseline: boolean; candidate: boolean };
  metrics: CompareMetricRow[];
  stages: CompareStageRow[];
  regressions: RegressionFlag[];
  improvements: RegressionFlag[];
}

export interface RunComparison {
  baselineRunId: string;
  candidateRunId: string;
  objectiveCode: { baseline: string; candidate: string; match: boolean };
  worldSeed: number;
  thresholds: { applied: RegressionThresholds; defaults: typeof DEFAULT_REGRESSION_THRESHOLDS; overridden: string[] };
  organizations: CompareOrganizationRow[];
  regressionFlags: RegressionFlag[];
  improvementFlags: RegressionFlag[];
  verdict: 'regression' | 'improvement' | 'no_material_change';
  verdictBasis: string;
  honestyNotes: string[];
}

export interface CompareRunInput {
  id: string;
  worldSeed: number;
  objectiveCode: string;
  reports: Array<{
    organizationId: string;
    scores: Record<string, number>;
    detail?: {
      perStage?: Array<{
        adapterId: string;
        role: string;
        modeledLatencyMs: number;
        modeledCostUsd: number;
        observedLatencyMs?: number;
      }>;
    } | null;
  }>;
}

interface CompareStageSource {
  adapterId: string;
  role: string;
  modeledLatencyMs: number;
  modeledCostUsd: number;
  observedLatencyMs?: number;
}

function stageRowsFor(reports: CompareRunInput['reports'], organizationId: string): CompareStageSource[] {
  const rep = reports.find((r) => r.organizationId === organizationId);
  return (rep?.detail?.perStage ?? []) as CompareStageSource[];
}

/**
 * Compare two runs. PURE: both runs are passed in parsed. The caller (route)
 * enforces the same-world-seed law BEFORE calling — this function asserts it
 * defensively and throws on cross-seed (never silently compares worlds).
 */
export function compareRuns(
  baseline: CompareRunInput,
  candidate: CompareRunInput,
  thresholds: Partial<RegressionThresholds> = {},
): RunComparison {
  if (baseline.worldSeed !== candidate.worldSeed) {
    throw new Error(
      `cross_seed: run ${candidate.id} (seed ${candidate.worldSeed}) cannot be compared against baseline ${baseline.id} (seed ${baseline.worldSeed}) — comparisons require the same world seed`,
    );
  }

  const applied: RegressionThresholds = { ...DEFAULT_REGRESSION_THRESHOLDS, ...thresholds };
  const overridden = Object.keys(thresholds).filter(
    (k) => (thresholds as unknown as Record<string, unknown>)[k] !== undefined &&
      JSON.stringify((thresholds as unknown as Record<string, unknown>)[k]) !==
        JSON.stringify((DEFAULT_REGRESSION_THRESHOLDS as unknown as Record<string, unknown>)[k]),
  );

  const orgIds = [
    ...new Set([
      ...baseline.reports.map((r) => r.organizationId),
      ...candidate.reports.map((r) => r.organizationId),
    ]),
  ].sort();

  const regressionFlags: RegressionFlag[] = [];
  const improvementFlags: RegressionFlag[] = [];
  const organizations: CompareOrganizationRow[] = [];

  for (const orgId of orgIds) {
    const baseRep = baseline.reports.find((r) => r.organizationId === orgId);
    const candRep = candidate.reports.find((r) => r.organizationId === orgId);
    const metrics: CompareMetricRow[] = [];
    const regressions: RegressionFlag[] = [];
    const improvements: RegressionFlag[] = [];

    if (baseRep && candRep) {
      const metricKeys = [...new Set([...Object.keys(baseRep.scores), ...Object.keys(candRep.scores)])].sort();
      for (const metric of metricKeys) {
        const bv = baseRep.scores[metric];
        const cv = candRep.scores[metric];
        if (typeof bv !== 'number' || typeof cv !== 'number') continue;
        const direction: 'higher-better' | 'lower-better' | 'unknown' =
          METRIC_DIRECTION[metric] ?? 'unknown';
        const delta = round(cv - bv, 4);
        let deltaKind: CompareMetricRow['deltaKind'] = 'none';
        if (RELATIVE_RISE_THRESHOLD[metric] && bv > 0) deltaKind = 'relative-pct';
        else if (direction !== 'unknown') deltaKind = 'absolute';
        metrics.push({ metric, direction, baselineValue: bv, candidateValue: cv, delta, deltaKind, changed: delta !== 0 });
        if (direction === 'unknown' || delta === 0) continue;

        if (direction === 'higher-better') {
          // rounding discipline: the comparison quantity is rounded to the SAME
          // precision as the displayed delta — a drop of exactly the threshold
          // (as displayed) is AT the threshold, never beyond it (float residue
          // like 0.9 − 0.85 = 0.050000…44 must not flip an at-threshold case)
          const drop = round(bv - cv, 4);
          const thKey = ABSOLUTE_DROP_THRESHOLD[metric];
          const th = thKey ? (applied[thKey] as number) : undefined;
          if (th !== undefined && drop > th) {
            regressions.push({
              organizationId: orgId,
              metric,
              kind: 'absolute',
              threshold: th,
              observed: round(drop, 4),
              detail: `${metric} dropped ${round(drop, 4)} (baseline ${bv} → candidate ${cv}) — beyond the allowed absolute drop ${th}`,
            });
          } else if (th !== undefined && -drop > th) {
            improvements.push({
              organizationId: orgId,
              metric,
              kind: 'absolute',
              threshold: th,
              observed: round(-drop, 4),
              detail: `${metric} improved ${round(-drop, 4)} (baseline ${bv} → candidate ${cv}) — beyond the absolute threshold ${th}`,
            });
          }
        } else {
          // lower-better
          const relKey = RELATIVE_RISE_THRESHOLD[metric];
          if (relKey && bv > 0) {
            // rounding discipline: same precision as the displayed relative delta
            const relRise = round((cv - bv) / bv, 6);
            const th = applied[relKey] as number;
            if (relRise > th) {
              regressions.push({
                organizationId: orgId,
                metric,
                kind: 'relative',
                threshold: th,
                observed: round(relRise, 4),
                detail: `${metric} rose ${round(relRise * 100, 2)}% (baseline ${bv} → candidate ${cv}) — beyond the allowed relative rise ${round(th * 100, 1)}%`,
              });
            } else if (-relRise > th) {
              improvements.push({
                organizationId: orgId,
                metric,
                kind: 'relative',
                threshold: th,
                observed: round(-relRise, 4),
                detail: `${metric} fell ${round(-relRise * 100, 2)}% (baseline ${bv} → candidate ${cv}) — beyond the relative threshold ${round(th * 100, 1)}%`,
              });
            }
          } else {
            const absKey = ABSOLUTE_RISE_THRESHOLD[metric];
            const th = absKey ? (applied[absKey] as number) : undefined;
            const rise = round(cv - bv, 4);
            if (th !== undefined && rise > th) {
              regressions.push({
                organizationId: orgId,
                metric,
                kind: 'absolute',
                threshold: th,
                observed: round(rise, 4),
                detail: `${metric} rose ${round(rise, 4)} (baseline ${bv} → candidate ${cv}) — beyond the allowed absolute rise ${th}`,
              });
            } else if (th !== undefined && -rise > th) {
              improvements.push({
                organizationId: orgId,
                metric,
                kind: 'absolute',
                threshold: th,
                observed: round(-rise, 4),
                detail: `${metric} fell ${round(-rise, 4)} (baseline ${bv} → candidate ${cv}) — beyond the absolute threshold ${th}`,
              });
            }
          }
        }
      }
    }

    // stage-level diff (modeled latencies/cost are deterministic per genome)
    const baseStages = stageRowsFor(baseline.reports, orgId);
    const candStages = stageRowsFor(candidate.reports, orgId);
    const stageKeys = [
      ...new Set([
        ...baseStages.map((s) => `${s.adapterId}::${s.role}`),
        ...candStages.map((s) => `${s.adapterId}::${s.role}`),
      ]),
    ].sort();
    const stages: CompareStageRow[] = [];
    for (const key of stageKeys) {
      const bs = baseStages.find((s) => `${s.adapterId}::${s.role}` === key);
      const cs = candStages.find((s) => `${s.adapterId}::${s.role}` === key);
      if (!bs || !cs) continue; // stage present on one side only — not comparable
      stages.push({
        adapterId: bs.adapterId,
        role: bs.role,
        baselineModeledLatencyMs: bs.modeledLatencyMs,
        candidateModeledLatencyMs: cs.modeledLatencyMs,
        deltaModeledLatencyMs: round(cs.modeledLatencyMs - bs.modeledLatencyMs, 3),
        baselineModeledCostUsd: bs.modeledCostUsd,
        candidateModeledCostUsd: cs.modeledCostUsd,
        deltaModeledCostUsd: round(cs.modeledCostUsd - bs.modeledCostUsd, 6),
        observedLatencyMs: {
          baseline: bs.observedLatencyMs ?? null,
          candidate: cs.observedLatencyMs ?? null,
        },
      });
    }

    organizations.push({
      organizationId: orgId,
      presentIn: { baseline: !!baseRep, candidate: !!candRep },
      metrics,
      stages,
      regressions,
      improvements,
    });
    regressionFlags.push(...regressions);
    improvementFlags.push(...improvements);
  }

  const verdict: RunComparison['verdict'] =
    regressionFlags.length > 0 ? 'regression' : improvementFlags.length > 0 ? 'improvement' : 'no_material_change';

  const objectiveMatch = baseline.objectiveCode === candidate.objectiveCode;

  return {
    baselineRunId: baseline.id,
    candidateRunId: candidate.id,
    objectiveCode: { baseline: baseline.objectiveCode, candidate: candidate.objectiveCode, match: objectiveMatch },
    worldSeed: baseline.worldSeed,
    thresholds: { applied, defaults: DEFAULT_REGRESSION_THRESHOLDS, overridden },
    organizations,
    regressionFlags,
    improvementFlags,
    verdict,
    verdictBasis:
      `verdict=${verdict} from ${regressionFlags.length} regression flag(s) and ${improvementFlags.length} improvement flag(s) against the configured thresholds` +
      (objectiveMatch ? '' : `; NOTE: the two runs measured different objectives (${baseline.objectiveCode} vs ${candidate.objectiveCode}) — only shared metric keys were compared`),
    honestyNotes: [
      'regression thresholds apply ONLY to deterministic/modeled metrics (coverage, confidence, determinism, continuity, drift, capabilityRetention, modeled latencyMs/costUsd aggregates)',
      'latencyMs flags operate on the MIXED-BASIS aggregate (modeled per-stage + ONE observed grounding call per organization) — the observed component is a single wall-clock measurement, so latency flags are weaker evidence than coverage/confidence flags',
      'per-stage observed latencies are displayed but never thresholded — a single wall-clock measurement is not regression evidence',
      'all values are SIMULATED Lab evidence (modeled) with explicitly-labeled observed grounding measurements — never production truth',
    ],
  };
}

// ─── Run artifact export (content-addressed) ─────────────────────────────────

export interface RunArtifactInput {
  run: {
    id: string;
    objectiveCode: string;
    worldSeed: number;
    status: string;
    createdAt: string;
    rerunOfId: string | null;
    manifest: Record<string, unknown> | null;
  };
  reports: Array<{
    organizationId: string;
    scores: Record<string, number>;
    reproducible: boolean;
    seed: number;
    detail: Record<string, unknown>;
  }>;
  metrics: Record<string, unknown> | null;
}

export interface RunArtifact {
  artifactType: typeof RUN_ARTIFACT_TYPE;
  schemaVersion: number;
  run: RunArtifactInput['run'];
  manifest: Record<string, unknown> | null;
  evaluations: RunArtifactInput['reports'];
  aggregate: Record<string, unknown> | null;
  honesty: {
    simulated: true;
    simulationNote: string;
    contentAddressing: string;
  };
}

/**
 * Build the downloadable run artifact. The sha256 function is INJECTED
 * (zero-import law) — the route passes node:crypto's, tests pass their own.
 * Deterministic: stable stringify → the same run always yields the same
 * bytes and therefore the same sha256.
 */
export function buildRunArtifact(
  input: RunArtifactInput,
  sha256Hex: (bytes: string) => string,
): { artifact: RunArtifact; bytes: string; sha256: string } {
  const artifact: RunArtifact = {
    artifactType: RUN_ARTIFACT_TYPE,
    schemaVersion: RUN_MANIFEST_VERSION,
    run: input.run,
    manifest: input.run.manifest,
    evaluations: input.reports,
    aggregate: input.metrics,
    honesty: {
      simulated: true,
      simulationNote:
        'Lab benchmark results are SIMULATED research truth (deterministic seeded simulation + explicitly-labeled real provider grounding measurements); never production human truth',
      contentAddressing: 'sha256 over the stable-stringified artifact bytes (X-Content-Sha256 response header); identical bytes ⇔ identical sha256',
    },
  };
  const bytes = stableStringify(artifact);
  return { artifact, bytes, sha256: sha256Hex(bytes) };
}

// ─── Route decision folds (the routes' enforcement order, exactly) ───────────

export interface LabRouteAuth {
  tenantId: string;
  actorType: 'user' | 'application';
  actorId: string;
  /** null = interactive session (full studio access); array = api key scopes */
  scopes: string[] | null;
}

export type CompareDecision =
  | { kind: 'error'; status: number; code: string; message: string }
  | { kind: 'proceed'; baseline: CompareRunInput; candidate: CompareRunInput; thresholds: Partial<RegressionThresholds> };

/**
 * The GET /api/v1/lab/runs/:id/compare?baseline=:id decision fold:
 * unauthenticated → 401; read-scope enforcement → 403; unknown runs → 404;
 * missing baseline param → 400; CROSS-SEED → 400 with a clear error (never a
 * silent cross-world diff); otherwise proceed with query-parsed thresholds.
 */
export function decideCompareRuns(args: {
  auth: LabRouteAuth | null;
  runId: string;
  baselineParam: string | null;
  run: CompareRunInput | null;
  baselineRun: CompareRunInput | null;
  thresholdOverrides: Partial<RegressionThresholds>;
}): CompareDecision {
  if (!args.auth) {
    return { kind: 'error', status: 401, code: 'unauthenticated', message: 'authentication required' };
  }
  const scopes = args.auth.scopes;
  if (scopes !== null && !(scopes.includes('read') || scopes.includes('write'))) {
    return {
      kind: 'error',
      status: 403,
      code: 'forbidden',
      message: `api key lacks the "read" scope required for GET /api/v1/lab/runs/${args.runId}/compare`,
    };
  }
  if (!args.run) {
    return { kind: 'error', status: 404, code: 'not_found', message: `benchmark run "${args.runId}" not found` };
  }
  if (!args.baselineParam || !args.baselineParam.trim()) {
    return {
      kind: 'error',
      status: 400,
      code: 'validation_failed',
      message: 'query parameter "baseline" is required (the baseline run id to compare against)',
    };
  }
  if (!args.baselineRun) {
    return {
      kind: 'error',
      status: 404,
      code: 'not_found',
      message: `baseline benchmark run "${args.baselineParam}" not found`,
    };
  }
  if (args.run.worldSeed !== args.baselineRun.worldSeed) {
    return {
      kind: 'error',
      status: 400,
      code: 'validation_failed',
      message:
        `cannot compare runs across world seeds: run ${args.run.id} used seed ${args.run.worldSeed} while baseline ${args.baselineRun.id} used seed ${args.baselineRun.worldSeed} — comparisons require the same world seed`,
    };
  }
  return {
    kind: 'proceed',
    baseline: args.baselineRun,
    candidate: args.run,
    thresholds: args.thresholdOverrides,
  };
}

/**
 * The GET /api/v1/lab/runs/:id/artifact decision fold: unauthenticated → 401;
 * read-scope enforcement → 403; unknown run → 404 (an honest miss, never a
 * leak); otherwise proceed.
 */
export function decideRunArtifact(
  auth: LabRouteAuth | null,
  runId: string,
  run: { id: string; status: string } | null,
): { status: 200; run: { id: string; status: string } } | { status: number; code: string; message: string } {
  if (!auth) return { status: 401, code: 'unauthenticated', message: 'authentication required' };
  const scopes = auth.scopes;
  if (scopes !== null && !(scopes.includes('read') || scopes.includes('write'))) {
    return {
      status: 403,
      code: 'forbidden',
      message: `api key lacks the "read" scope required for GET /api/v1/lab/runs/${runId}/artifact`,
    };
  }
  if (!run) return { status: 404, code: 'not_found', message: `benchmark run "${runId}" not found` };
  return { status: 200, run };
}

/** Parse + validate threshold override query params (honest 400s). */
export function parseThresholdOverrides(
  params: URLSearchParams,
): { ok: true; thresholds: Partial<RegressionThresholds> } | { ok: false; message: string } {
  const thresholds: Partial<RegressionThresholds> = {};
  const allowed: Record<string, keyof RegressionThresholds> = {
    coverageDownMax: 'coverageDownMax',
    confidenceDownMax: 'confidenceDownMax',
    determinismDownMax: 'determinismDownMax',
    continuityDownMax: 'continuityDownMax',
    capabilityRetentionDownMax: 'capabilityRetentionDownMax',
    driftUpMax: 'driftUpMax',
    latencyUpMaxPct: 'latencyUpMaxPct',
    costUpMaxPct: 'costUpMaxPct',
  };
  for (const [key, value] of params.entries()) {
    if (key === 'baseline') continue;
    const mapped = allowed[key];
    if (!mapped) {
      return {
        ok: false,
        message: `unknown threshold parameter "${key}" — allowed: ${Object.keys(allowed).join(', ')} (plus "baseline")`,
      };
    }
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) {
      return { ok: false, message: `threshold parameter "${key}" must be a finite number ≥ 0 (got "${value}")` };
    }
    thresholds[mapped] = num;
  }
  return { ok: true, thresholds };
}

/** Clamp a value into [0,1] — exported for the atlas confidence rollups. */
export function clampUnit(n: number): number {
  return clamp(n, 0, 1);
}
