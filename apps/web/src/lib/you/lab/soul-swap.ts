// ═══════════════════════════════════════════════════════════════════════════
// SOUL-SWAP-001 — the soul-swap benchmark scenario (Worker C lane, P6.C11).
//
// Measures IDENTITY PRESERVATION across soul swaps (ADR-0002: bodies are
// swappable infrastructure; the soul is the identity carrier). Per-organization
// scores: continuity, drift, post-swap capability retention — plus the same
// modeled latency/cost and the ONE real grounding call per organization.
//
// HONESTY MODEL — identical to the HUMAN-RECON-001 harness:
//  - continuity / drift / capabilityRetention / modeled-latency / modeled-cost
//    are produced by a DETERMINISTIC simulation over the seeded Lab world
//    (simulated: true — every number labeled modeled);
//  - latencyMs additionally includes ONE REAL small provider call per
//    organization ("grounding call", INJECTED — this module never imports the
//    SDK) so at least one honest measurement anchors every latency claim; if
//    the provider is unavailable the score is modeled-only and the detail
//    says so;
//  - determinism is checked by re-running the pure metric computation and
//    comparing stable JSON — real provider latencies are measurements and are
//    deliberately EXCLUDED from the determinism check;
//  - costUsd is always modeled (costUsdModeled: true).
// ═══════════════════════════════════════════════════════════════════════════
import type { LabWorldSpec, OrganizationDescriptor, PipelineGenome } from '../contracts';
// NOTE: relative imports carry explicit .ts extensions (the ai/render-provider.ts
// precedent) so node:test's type-stripping resolver can load this contract core
// directly — the extensionless bundler specifiers are not resolvable under
// plain Node ESM.
import { clamp, round, stableStringify } from './determinism.ts';
import { STAGE_SOUL, type CompiledOrganization } from './organization-compiler.ts';

export const SOUL_SWAP_OBJECTIVE_CODE = 'SOUL-SWAP-001';
export const SOUL_SWAP_SCENARIO = 'soul-swap-001' as const;

export interface GroundingCallResult {
  real: boolean;
  latencyMs: number | null;
  model: string | null;
  error: string | null;
}

export interface SoulSwapBodyResult {
  role: string;
  adapterId: string;
  canonicalSoul: string;
  assignedSoul: string;
  swappedSoul: string;
  fit: number;
  depthDelta: number;
}

export interface SoulSwapScores {
  continuity: number;
  drift: number;
  capabilityRetention: number;
  latencyMs: number;
  costUsd: number;
  determinism: number;
}

export interface SoulSwapEvaluation {
  organizationId: string;
  scores: SoulSwapScores;
  reproducible: boolean;
  detail: Record<string, unknown>;
}

export interface SoulSwapAggregate {
  bestOrganizationId: string;
  ranking: Array<{ organizationId: string; weightedScore: number }>;
  formula: string;
}

export const SOUL_SWAP_FORMULA =
  'weightedScore = 0.40·continuity + 0.30·capabilityRetention + 0.10·(1 − drift) + 0.10·determinism + 0.10·latencyScore, latencyScore = clamp(1 − latencyMs/60000, 0, 1)';

// ─── Soul model (deterministic, genome-driven) ───────────────────────────────

/** Deliberation depth of each soul (ADR-0002 soul registry). */
const SOUL_DEPTH: Record<string, number> = {
  'soul-one-fast': 1,
  'soul-two-deep': 2,
};

/**
 * Post-swap capability fit: how well a body's stage capabilities hold when a
 * different soul is bound to it. Fixed, documented research-heuristic priors.
 */
const STAGE_SOUL_FIT: Record<string, Record<string, number>> = {
  'vlm-recon-1': { 'soul-two-deep': 1, 'soul-one-fast': 0.55 },
  'lab-qa-1': { 'soul-two-deep': 1, 'soul-one-fast': 0.6 },
  'lab-segment-1': { 'soul-one-fast': 1, 'soul-two-deep': 0.9 },
  'lab-merge-1': { 'soul-one-fast': 1, 'soul-two-deep': 0.9 },
};

const UNKNOWN_SOUL_FIT = 0.75; // honest default for unknown adapter/soul combos (noted in detail)

/** Modeled per-stage cost (same constants as the recon harness). */
const MODELED_STAGE_COST: Record<string, number> = {
  'lab-segment-1': 0,
  'vlm-recon-1': 0.01,
  'lab-merge-1': 0,
  'lab-qa-1': 0,
};

/** Modeled per-stage latency (same constants as the recon harness). */
function modeledStageLatencyMs(adapterId: string, params: Record<string, unknown>): number {
  switch (adapterId) {
    case 'lab-segment-1':
      return 120 * (typeof params.granularity === 'number' ? params.granularity : 2);
    case 'lab-merge-1':
      return 60;
    case 'lab-qa-1':
      return params.role === 'fallback' ? 135 : 90;
    case 'vlm-recon-1':
      return 0; // anchored by the real grounding call
    default:
      return 100;
  }
}

/** Modeled soul-rebind overhead per swapped body (local computation). */
const SWAP_OVERHEAD_MS_PER_BODY = 15;

interface SoulSwapPureMetrics {
  continuity: number;
  drift: number;
  capabilityRetention: number;
  latencyModeledMs: number;
  costUsd: number;
  perBodySwap: SoulSwapBodyResult[];
  perStage: Array<{
    adapterId: string;
    role: string;
    modeledLatencyMs: number;
    modeledCostUsd: number;
    observedLatencyMs?: number;
  }>;
  thresholds: Record<string, unknown>;
}

/**
 * Deterministic soul-swap metric computation. `realGroundingLatencyMs`
 * participates only in the final latencyMs score (a measurement), never in
 * the determinism check — pass 0 when checking reproducibility.
 */
function computeSoulSwapMetrics(
  world: LabWorldSpec,
  org: CompiledOrganization,
  realGroundingLatencyMs: number
): SoulSwapPureMetrics & { latencyMs: number } {
  const noise = world.noise as { sensorNoise: number; motionBlur: number; compression: number };
  const effectiveNoise = clamp(noise.sensorNoise + noise.motionBlur * 0.5, 0, 1);

  const stages = org.genome.stages;
  const n = stages.length;

  // the compiled assignment (mirrors organization-compiler: one soul per stage)
  const assignedSouls = stages.map((s) => STAGE_SOUL[s.adapterId] ?? 'soul-one-fast');

  // THE SWAP: each body receives the next body's soul (rotation). A
  // single-body organization swaps its sole soul for the complementary soul —
  // deterministic, honest (recorded per body in the result detail).
  const swappedSouls =
    n > 1
      ? assignedSouls.map((_, i) => assignedSouls[(i + 1) % n])
      : assignedSouls.map((soul) => (soul === 'soul-one-fast' ? 'soul-two-deep' : 'soul-one-fast'));

  const perBodySwap: SoulSwapBodyResult[] = [];
  let fitSum = 0;
  let depthDeltaSum = 0;

  for (let i = 0; i < n; i++) {
    const stage = stages[i];
    const adapterId = stage.adapterId;
    const canonicalSoul = STAGE_SOUL[adapterId] ?? 'soul-one-fast';
    const swappedSoul = swappedSouls[i];
    const fitTable = STAGE_SOUL_FIT[adapterId];
    const fit = fitTable ? (fitTable[swappedSoul] ?? UNKNOWN_SOUL_FIT) : UNKNOWN_SOUL_FIT;
    const depthDelta = Math.abs(
      (SOUL_DEPTH[swappedSoul] ?? 1) - (SOUL_DEPTH[canonicalSoul] ?? 1)
    );
    const role = String(
      stage.params.role ??
      (stage.adapterId === 'vlm-recon-1' ? 'analyze' : adapterId === 'lab-segment-1' ? 'segmenter' : 'stage')
    );
    perBodySwap.push({
      role: adapterId === 'lab-qa-1' && stage.params.role === 'fallback' ? 'qa-fallback' : role,
      adapterId,
      canonicalSoul,
      assignedSoul: assignedSouls[i],
      swappedSoul,
      fit: round(fit, 3),
      depthDelta,
    });
    fitSum += fit;
    depthDeltaSum += depthDelta;
  }

  const meanFit = n > 0 ? fitSum / n : 0;
  const meanDepthDelta = n > 0 ? depthDeltaSum / n : 0;

  const capabilityRetention = round(clamp(meanFit, 0, 1), 3);
  const continuity = round(clamp(1 - meanDepthDelta * 0.35 - effectiveNoise * 0.08, 0, 1), 3);
  const drift = round(clamp(meanDepthDelta * (0.6 + effectiveNoise * 0.4), 0, 1), 3);

  // modeled per-stage latency + swap overhead + the ONE observed grounding call
  const perStage: SoulSwapPureMetrics['perStage'] = [];
  let latencyModeledMs = 0;
  let costUsd = 0;
  for (const stage of stages) {
    const ms = modeledStageLatencyMs(stage.adapterId, stage.params);
    const cost = MODELED_STAGE_COST[stage.adapterId] ?? 0;
    perStage.push({
      adapterId: stage.adapterId,
      role: String(stage.params.role ?? (stage.adapterId === 'vlm-recon-1' ? 'analyze' : 'stage')),
      modeledLatencyMs: ms,
      modeledCostUsd: cost,
      ...(stage.adapterId === 'vlm-recon-1' && realGroundingLatencyMs > 0
        ? { observedLatencyMs: realGroundingLatencyMs }
        : {}),
    });
    latencyModeledMs += ms;
    costUsd += cost;
  }
  latencyModeledMs += n * SWAP_OVERHEAD_MS_PER_BODY; // modeled swap overhead
  if (stages.some((s) => s.adapterId === 'vlm-recon-1')) {
    latencyModeledMs += realGroundingLatencyMs; // real measurement (0 during determinism check)
    costUsd += MODELED_STAGE_COST['vlm-recon-1'];
  }

  return {
    continuity,
    drift,
    capabilityRetention,
    latencyModeledMs,
    costUsd: round(costUsd, 4),
    perBodySwap,
    perStage,
    thresholds: {
      effectiveNoise: round(effectiveNoise, 3),
      continuityModel: '1 − 0.35·meanSoulDepthDelta − 0.08·effectiveNoise',
      driftModel: 'meanSoulDepthDelta · (0.6 + 0.4·effectiveNoise)',
      capabilityRetentionModel: 'mean(post-swap stage/soul fit)',
      unknownSoulFitDefault: UNKNOWN_SOUL_FIT,
    },
    latencyMs: latencyModeledMs,
  };
}

/**
 * Evaluate all compiled organizations on the seeded world under soul swaps.
 * `grounding` is INJECTED (zero-import law): the executor passes the real
 * provider call; tests pass a stub or null (modeled-only).
 */
export async function evaluateSoulSwap(
  world: LabWorldSpec,
  organizations: CompiledOrganization[],
  grounding: (() => Promise<GroundingCallResult>) | null
): Promise<{ evaluations: SoulSwapEvaluation[]; aggregate: SoulSwapAggregate; llmCalls: number }> {
  const evaluations: SoulSwapEvaluation[] = [];
  let llmCalls = 0;

  for (const org of organizations) {
    const groundingResult: GroundingCallResult = grounding
      ? await grounding()
      : { real: false, latencyMs: null, model: null, error: 'no grounding call injected (pure evaluation)' };
    if (groundingResult.real) llmCalls += 1;
    const realLatency = groundingResult.real ? (groundingResult.latencyMs as number) : 0;

    const withReal = computeSoulSwapMetrics(world, org, realLatency);
    const latencyMs = Math.round(withReal.latencyMs);

    // determinism: pure metric computation re-run must be bit-identical
    const rerunA = computeSoulSwapMetrics(world, org, 0);
    const rerunB = computeSoulSwapMetrics(world, org, 0);
    const reproducible = stableStringify(rerunA) === stableStringify(rerunB);

    // latency honesty: label EVERY LLM-latency component
    const llmLatencyComponents: Array<{
      component: string;
      latencyMs: number | null;
      basis: 'observed' | 'modeled' | 'unavailable';
      note?: string;
    }> = withReal.perStage.map((s) => ({
      component: `${s.adapterId} (${s.role})`,
      latencyMs: s.modeledLatencyMs,
      basis: 'modeled',
      note: 'deterministic seeded-world simulation estimate — not a provider measurement',
    }));
    llmLatencyComponents.push({
      component: 'soul-swap rebind overhead (modeled)',
      latencyMs: withReal.perBodySwap.length * SWAP_OVERHEAD_MS_PER_BODY,
      basis: 'modeled',
      note: 'local deterministic rebind cost — not a provider measurement',
    });
    if (withReal.perStage.some((s) => s.adapterId === 'vlm-recon-1')) {
      llmLatencyComponents.push(
        groundingResult.real
          ? {
              component: 'vlm-recon-1 analyze stage — real provider grounding call',
              latencyMs: groundingResult.latencyMs,
              basis: 'observed',
              note: 'client wall-clock measured around the provider call (the z-ai SDK response exposes no provider-side timing field)',
            }
          : {
              component: 'vlm-recon-1 analyze stage — real provider grounding call',
              latencyMs: null,
              basis: 'unavailable',
              note: `provider call FAILED (${groundingResult.error ?? 'unknown error'}) — no measurement is claimed; the score is modeled-only`,
            }
      );
    }

    const latencyMsBasis = groundingResult.real
      ? 'mixed: modeled per-stage latencies + modeled swap overhead + ONE observed provider grounding call (measurement)'
      : 'modeled only — the grounding call FAILED or was not injected (no provider measurement claimed)';

    evaluations.push({
      organizationId: org.descriptor.organizationId,
      scores: {
        continuity: withReal.continuity,
        drift: withReal.drift,
        capabilityRetention: withReal.capabilityRetention,
        latencyMs,
        costUsd: withReal.costUsd,
        determinism: reproducible ? 1 : 0,
      },
      reproducible,
      detail: {
        simulated: true,
        simulationNote:
          'Soul-swap Lab results are SIMULATED research truth — continuity/drift/capabilityRetention/modeled-latency/modeled-cost come from a deterministic simulation over the seeded world; never production human truth',
        scenario: SOUL_SWAP_SCENARIO,
        organization: org.descriptor,
        genomeStages: org.genome.stages,
        worldId: world.worldId,
        worldSeed: world.seed,
        groundingCall: groundingResult,
        latencyRealMs: groundingResult.real ? groundingResult.latencyMs : null,
        latencyModeledMs: withReal.latencyModeledMs - realLatency,
        latencyMsBasis,
        latencyComponentsLabeled: llmLatencyComponents.length,
        llmLatencyComponents,
        latencyNote: groundingResult.real
          ? 'latencyMs = modeled per-stage latencies + modeled swap overhead + ONE real provider grounding call (measured); every component is labeled per llmLatencyComponents'
          : 'latencyMs is modeled-only — no provider measurement is claimed; every component is labeled per llmLatencyComponents',
        costUsdModeled: true,
        costNote: 'costUsd is a modeled estimate; provider pricing is not exposed to this sandbox',
        perStage: withReal.perStage,
        perBodySwap: withReal.perBodySwap,
        thresholds: withReal.thresholds,
        determinismCheck:
          'pure metric computation re-run twice with the same seed → stable-JSON equality; real provider latencies are excluded from the check',
      },
    });
  }

  const ranking = evaluations
    .map((e) => ({
      organizationId: e.organizationId,
      weightedScore: round(
        0.4 * e.scores.continuity +
          0.3 * e.scores.capabilityRetention +
          0.1 * (1 - e.scores.drift) +
          0.1 * e.scores.determinism +
          0.1 * clamp(1 - e.scores.latencyMs / 60_000, 0, 1),
        4
      ),
    }))
    .sort((a, b) => b.weightedScore - a.weightedScore);

  return {
    evaluations,
    aggregate: {
      bestOrganizationId: ranking[0]?.organizationId ?? '',
      ranking,
      formula: SOUL_SWAP_FORMULA,
    },
    llmCalls,
  };
}

// ─── Soul-swap failure derivation (real sim output only) ─────────────────────

/** capability-retention floor for recording a SOUL_SWAP_CAPABILITY_LOSS case. */
export const SOUL_SWAP_FIT_FLOOR = 0.7;
/** drift ceiling for recording a SOUL_SWAP_IDENTITY_DRIFT case. */
export const SOUL_SWAP_DRIFT_CEILING = 0.5;

/**
 * Derive honest failure-classification inputs from a REAL soul-swap
 * evaluation: bodies whose post-swap fit fell below the floor, and orgs whose
 * drift exceeded the ceiling. No thresholds breached → no cases (honest).
 * Structural input: only what is actually read (organizationId, drift,
 * perBodySwap) — the executor passes the full evaluation; tests pass minimal
 * fixtures.
 */
export function deriveSoulSwapFailureInputs(
  evaluation: { organizationId: string; scores: { drift: number }; detail: Record<string, unknown> },
  worldSeed: number
): Array<{ kind: 'capability-loss' | 'drift'; input: Record<string, unknown> }> {
  const out: Array<{ kind: 'capability-loss' | 'drift'; input: Record<string, unknown> }> = [];
  const perBodySwap = (evaluation.detail.perBodySwap as SoulSwapBodyResult[] | undefined) ?? [];
  for (const body of perBodySwap) {
    if (body.fit < SOUL_SWAP_FIT_FLOOR) {
      out.push({
        kind: 'capability-loss',
        input: {
          organizationId: evaluation.organizationId,
          role: body.role,
          adapterId: body.adapterId,
          canonicalSoul: body.canonicalSoul,
          swappedSoul: body.swappedSoul,
          fit: body.fit,
          worldSeed,
        },
      });
    }
  }
  if (evaluation.scores.drift > SOUL_SWAP_DRIFT_CEILING) {
    out.push({
      kind: 'drift',
      input: {
        organizationId: evaluation.organizationId,
        drift: evaluation.scores.drift,
        driftCeiling: SOUL_SWAP_DRIFT_CEILING,
        worldSeed,
      },
    });
  }
  return out;
}

// re-exported for the executor's manifest construction convenience
export type { CompiledOrganization, OrganizationDescriptor, PipelineGenome };
