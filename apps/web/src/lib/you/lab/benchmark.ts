// ═══════════════════════════════════════════════════════════════════════════
// HUMAN-RECON-001 benchmark harness (Worker C lane).
//
// HONESTY MODEL — every number is labeled:
//  - coverage / confidence / modeled-latency / modeled-cost are produced by a
//    DETERMINISTIC simulation over the seeded Lab world (simulated: true);
//  - latencyMs additionally includes ONE REAL small provider call per
//    organization ("grounding call") so at least one honest measurement
//    anchors every latency claim; if the provider is unavailable the score is
//    modeled-only and the detail says so;
//  - W2.C LATENCY HONESTY: the report payload labels EVERY LLM-latency
//    component explicitly via `llmLatencyComponents` (basis: 'observed' |
//    'modeled' | 'unavailable' per component) and the aggregate score basis
//    via `latencyMsBasis`; the vlm-recon-1 stage carries its observed
//    grounding latency in perStage as `observedLatencyMs`;
//  - determinism is checked by re-running the pure metric computation and
//    comparing stable JSON — real provider latencies are measurements and are
//    deliberately EXCLUDED from the determinism check;
//  - costUsd is always modeled (costUsdModeled: true) — provider pricing is
//    not exposed to this sandbox.
// ═══════════════════════════════════════════════════════════════════════════
import type { LabWorldSpec } from '../contracts';
import { chatComplete } from '../ai/zai';
import { clamp, round, stableStringify } from './determinism';
import type { CompiledOrganization } from './organization-compiler';
import { worldActors } from './world';

export interface OrgEvaluation {
  organizationId: string;
  scores: {
    coverage: number;
    confidence: number;
    latencyMs: number;
    costUsd: number;
    determinism: number;
  };
  reproducible: boolean;
  detail: Record<string, unknown>;
}

export interface BenchmarkAggregate {
  bestOrganizationId: string;
  ranking: Array<{ organizationId: string; weightedScore: number }>;
  formula: string;
}

const MODELED_STAGE_COST: Record<string, number> = {
  'lab-segment-1': 0,
  'vlm-recon-1': 0.01, // modeled estimate per invocation
  'lab-merge-1': 0,
  'lab-qa-1': 0,
};

interface PureMetrics {
  coverage: number;
  confidence: number;
  latencyModeledMs: number;
  costUsd: number;
  regionSimulation: Array<{
    region: string;
    difficulty: number;
    occlusionPenalty: number;
    captured: boolean;
    regionConfidence: number;
  }>;
  perStage: Array<{
    adapterId: string;
    role: string;
    modeledLatencyMs: number;
    modeledCostUsd: number;
    /** real grounding-call latency for vlm-recon-1 stages (labeled observed in detail); 0 for determinism re-runs */
    observedLatencyMs?: number;
  }>;
  thresholds: Record<string, unknown>;
}

/**
 * Deterministic metric computation. `realGroundingLatencyMs` participates only
 * in the final latencyMs score (a measurement), never in the determinism
 * check — pass 0 when checking reproducibility.
 */
function computePureMetrics(
  world: LabWorldSpec,
  org: CompiledOrganization,
  realGroundingLatencyMs: number
): PureMetrics & { latencyMs: number } {
  const noise = world.noise as { sensorNoise: number; motionBlur: number; compression: number };
  const effectiveNoise = clamp(noise.sensorNoise + noise.motionBlur * 0.5, 0, 1);
  const occlusions = (world.occlusions ?? []) as Array<{ affectsRegion: string; severity: number }>;
  const actors = worldActors(world);
  const expected = (world.groundTruth.expectedRegions as string[]) ?? [];

  // per-region occlusion penalty (max severity, scaled)
  const occPenalty = new Map<string, number>();
  for (const occ of occlusions) {
    const cur = occPenalty.get(occ.affectsRegion) ?? 0;
    occPenalty.set(occ.affectsRegion, Math.max(cur, clamp(occ.severity, 0, 1) * 0.35));
  }

  // genome-derived stage facts
  const stages = org.genome.stages;
  const stageCount = stages.length;
  const hasSegment = stages.some((s) => s.adapterId === 'lab-segment-1');
  const hasAnalyzer = stages.some((s) => s.adapterId === 'vlm-recon-1');
  const hasMerge = stages.some((s) => s.adapterId === 'lab-merge-1');
  const qaStages = stages.filter((s) => s.adapterId === 'lab-qa-1');
  const hasFallbackQa = qaStages.some((s) => s.params.role === 'fallback');
  const granularity = (() => {
    const seg = stages.find((s) => s.adapterId === 'lab-segment-1');
    const g = seg?.params.granularity;
    return typeof g === 'number' ? g : 2;
  })();
  const mutationCount = (() => {
    const muts = (org.genome.parameters as Record<string, unknown>).mutations;
    return Array.isArray(muts) ? muts.length : 0;
  })();
  // simulated search noise: deterministic small modifier from mutation count
  const mutationModifier = ((mutationCount % 5) - 2) * 0.01;

  const baseSensitivity = 0.92 - effectiveNoise * 0.5 + mutationModifier;

  const regionSimulation: PureMetrics['regionSimulation'] = [];
  let capturedCount = 0;
  let confSum = 0;

  for (const region of expected) {
    const actor = actors[0]; // worlds are homogeneous per region difficulty in wave-1; actor 0 is the reference
    const truth = actor.groundTruth.regions.find((r) => r.region === region);
    const difficulty = truth?.difficulty ?? 0.5;
    const occ = occPenalty.get(region) ?? 0;
    const threshold = baseSensitivity - occ;

    let captured = false;
    let regionConfidence = 0;
    if (hasSegment && hasAnalyzer && hasMerge) {
      // staged pipeline
      const segmentPass = difficulty < threshold + 0.05 * (granularity / 2);
      const analyzePass = difficulty < threshold + 0.08;
      captured = segmentPass || analyzePass;
      regionConfidence = captured ? (segmentPass ? (hasMerge ? 1 : 0.9) : 0.72) : 0;
      if (!captured && hasFallbackQa && difficulty < threshold + 0.02) {
        captured = true; // fallback QA re-review recovers borderline regions at reduced confidence
        regionConfidence = 0.6;
      }
    } else {
      // generalist single-pass
      captured = difficulty < threshold - 0.06;
      regionConfidence = captured ? 0.78 : 0;
    }
    if (captured) capturedCount += 1;
    confSum += regionConfidence;
    regionSimulation.push({ region, difficulty, occlusionPenalty: occ, captured, regionConfidence });
  }

  const coverage = round(capturedCount / Math.max(1, expected.length), 3);
  const meanConf = confSum / Math.max(1, expected.length);
  const confidence = round(clamp(meanConf * (1 - (noise.compression ?? 0) * 0.15), 0, 1), 3);

  // modeled per-stage latency
  const perStage: PureMetrics['perStage'] = [];
  let latencyModeledMs = 0;
  let costUsd = 0;
  for (const stage of stages) {
    let ms = 0;
    switch (stage.adapterId) {
      case 'lab-segment-1':
        ms = 120 * (typeof stage.params.granularity === 'number' ? stage.params.granularity : 2);
        break;
      case 'lab-merge-1':
        ms = 60;
        break;
      case 'lab-qa-1':
        ms = stage.params.role === 'fallback' ? 135 : 90;
        break;
      case 'vlm-recon-1':
        // the analysis stage is anchored by the real grounding call latency
        ms = 0;
        break;
      default:
        ms = 100;
    }
    const cost = MODELED_STAGE_COST[stage.adapterId] ?? 0;
    perStage.push({
      adapterId: stage.adapterId,
      role: String(stage.params.role ?? (stage.adapterId === 'vlm-recon-1' ? 'analyze' : 'stage')),
      modeledLatencyMs: ms,
      modeledCostUsd: cost,
      ...(stage.adapterId === 'vlm-recon-1' && realGroundingLatencyMs > 0
        ? { observedLatencyMs: realGroundingLatencyMs } // real measurement (labeled); absent during determinism re-runs
        : {}),
    });
    latencyModeledMs += ms;
    costUsd += cost;
  }
  if (hasAnalyzer) {
    latencyModeledMs += realGroundingLatencyMs; // real measurement (0 during determinism check)
    costUsd += MODELED_STAGE_COST['vlm-recon-1'];
  }
  void stageCount;

  return {
    coverage,
    confidence,
    latencyModeledMs,
    costUsd: round(costUsd, 4),
    regionSimulation,
    perStage,
    thresholds: {
      baseSensitivity: round(baseSensitivity, 4),
      effectiveNoise: round(effectiveNoise, 3),
      effectiveSensitivityNote: 'staged orgs add +0.05·granularity/2 (segment) and +0.08 (analyze) headroom; generalist single-pass is −0.06',
    },
    latencyMs: latencyModeledMs,
  };
}

export interface GroundingCallResult {
  real: boolean;
  latencyMs: number | null;
  model: string | null;
  error: string | null;
}

/** ONE real, small provider call to anchor latency honestly. */
async function groundingCall(): Promise<GroundingCallResult> {
  try {
    const res = await chatComplete(
      [{ role: 'user', content: 'Reply with the single word: ok' }],
      { thinking: false, temperature: 0 }
    );
    return { real: true, latencyMs: res.latencyMs, model: res.model, error: null };
  } catch (e) {
    return {
      real: false,
      latencyMs: null,
      model: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Evaluate all compiled organizations on the seeded world. */
export async function evaluateOrganizations(
  world: LabWorldSpec,
  organizations: CompiledOrganization[]
): Promise<{ evaluations: OrgEvaluation[]; aggregate: BenchmarkAggregate; llmCalls: number }> {
  const evaluations: OrgEvaluation[] = [];
  let llmCalls = 0;

  for (const org of organizations) {
    const grounding = await groundingCall();
    if (grounding.real) llmCalls += 1;
    const realLatency = grounding.real ? (grounding.latencyMs as number) : 0;

    const withReal = computePureMetrics(world, org, realLatency);
    const latencyMs = Math.round(withReal.latencyMs);

    // determinism: pure metric computation re-run must be bit-identical
    const rerunA = computePureMetrics(world, org, 0);
    const rerunB = computePureMetrics(world, org, 0);
    const reproducible = stableStringify(rerunA) === stableStringify(rerunB);

    // W2.C latency honesty: label EVERY LLM-latency component in the report
    // payload — modeled simulation stages vs the observed provider grounding
    // call — so no modeled component can masquerade as a measurement.
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
    if (withReal.perStage.some((s) => s.adapterId === 'vlm-recon-1')) {
      llmLatencyComponents.push(
        grounding.real
          ? {
              component: 'vlm-recon-1 analyze stage — real provider grounding call',
              latencyMs: grounding.latencyMs,
              basis: 'observed',
              note: 'client wall-clock measured around the provider call (the z-ai SDK response exposes no provider-side timing field)',
            }
          : {
              component: 'vlm-recon-1 analyze stage — real provider grounding call',
              latencyMs: null,
              basis: 'unavailable',
              note: `provider call FAILED (${grounding.error ?? 'unknown error'}) — no measurement is claimed; the score is modeled-only`,
            }
      );
    }

    const latencyMsBasis = grounding.real
      ? 'mixed: modeled per-stage latencies + ONE observed provider grounding call (measurement)'
      : 'modeled only — the grounding call FAILED (no provider measurement claimed)';

    evaluations.push({
      organizationId: org.descriptor.organizationId,
      scores: {
        coverage: withReal.coverage,
        confidence: withReal.confidence,
        latencyMs,
        costUsd: withReal.costUsd,
        determinism: reproducible ? 1 : 0,
      },
      reproducible,
      detail: {
        simulated: true,
        simulationNote:
          'Lab results are SIMULATED research truth — coverage/confidence/modeled-latency/modeled-cost come from a deterministic simulation over the seeded world; never production human truth',
        organization: org.descriptor,
        genomeStages: org.genome.stages,
        worldId: world.worldId,
        worldSeed: world.seed,
        groundingCall: grounding,
        latencyRealMs: grounding.real ? grounding.latencyMs : null,
        latencyModeledMs: withReal.latencyModeledMs - realLatency,
        latencyMsBasis,
        latencyComponentsLabeled: llmLatencyComponents.length,
        llmLatencyComponents,
        latencyNote: grounding.real
          ? 'latencyMs = modeled per-stage latencies + ONE real provider grounding call (measured); every component is labeled per llmLatencyComponents'
          : 'latencyMs is modeled-only — the real grounding call FAILED; no provider measurement is claimed; every component is labeled per llmLatencyComponents',
        costUsdModeled: true,
        costNote: 'costUsd is a modeled estimate; provider pricing is not exposed to this sandbox',
        perStage: withReal.perStage,
        regionSimulation: withReal.regionSimulation,
        thresholds: withReal.thresholds,
        determinismCheck:
          'pure metric computation re-run twice with the same seed → stable-JSON equality; real provider latencies are excluded from the check',
      },
    });
  }

  // ranking (formula recorded verbatim in the aggregate)
  const formula =
    'weightedScore = 0.45·coverage + 0.35·confidence + 0.10·determinism + 0.10·latencyScore, latencyScore = clamp(1 − latencyMs/60000, 0, 1)';
  const ranking = evaluations
    .map((e) => ({
      organizationId: e.organizationId,
      weightedScore: round(
        0.45 * e.scores.coverage +
          0.35 * e.scores.confidence +
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
      formula,
    },
    llmCalls,
  };
}
