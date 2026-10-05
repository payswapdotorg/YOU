// ═══════════════════════════════════════════════════════════════════════════
// Failure Atlas (Worker C lane) — docs/LAB_DESIGN.md:
// "Store every repeatable failure with input conditions, pipeline, technology
//  versions, artifacts, suspected cause, confidence and remediation."
//
// P6.C11: every recorded case now carries the typed failure CODE (taxonomy
// v1 — lib/you/lab/failure-codes.ts), its structured PAYLOAD, the remediation
// lifecycle fields (status + audit log) and the recorded POLICY DECISIONS
// (enforced vs proposed, with basis) for its class.
// ═══════════════════════════════════════════════════════════════════════════
import type { PrismaClient } from '@prisma/client';
import {
  classifyRegionFailure,
  failureCodeDefinition,
  policyDecisionsForCode,
  type ClassifiedCase,
} from './failure-codes';

export interface FailureCaseInput {
  benchmarkRunId?: string | null;
  organizationId?: string | null;
  /** taxonomy code (v1). Unknown codes are recorded UNCLASSIFIED — never guessed. */
  code?: string;
  inputConditions: Record<string, unknown>;
  /** structured payload per the taxonomy code's payloadFields */
  payload?: Record<string, unknown>;
  pipeline?: Record<string, unknown>;
  technologyVersions?: unknown[];
  artifacts?: unknown[];
  suspectedCause: string;
  confidence: number;
  remediation?: string | null;
}

export async function recordFailureCase(db: PrismaClient, input: FailureCaseInput): Promise<{ id: string }> {
  const code = input.code && failureCodeDefinition(input.code).code === input.code ? input.code : 'UNCLASSIFIED';
  return db.failureCase.create({
    data: {
      benchmarkRunId: input.benchmarkRunId ?? null,
      organizationId: input.organizationId ?? null,
      code,
      inputConditions: JSON.stringify(input.inputConditions),
      payload: JSON.stringify(input.payload ?? {}),
      pipeline: JSON.stringify(input.pipeline ?? {}),
      technologyVersions: JSON.stringify(input.technologyVersions ?? []),
      artifacts: JSON.stringify(input.artifacts ?? []),
      suspectedCause: input.suspectedCause,
      confidence: input.confidence,
      remediation: input.remediation ?? null,
      status: 'open',
      remediationLog: '[]',
      policyDecision: JSON.stringify({
        taxonomyVersion: 1,
        decisions: policyDecisionsForCode(code),
      }),
    },
  });
}

/** Record a pre-classified case (code + payload from a taxonomy classifier). */
export async function recordClassifiedFailureCase(
  db: PrismaClient,
  input: Omit<FailureCaseInput, 'code' | 'payload'> & { classified: ClassifiedCase }
): Promise<{ id: string }> {
  return recordFailureCase(db, {
    ...input,
    code: input.classified.code,
    payload: input.classified.payload,
  });
}

export interface RegionFailureSummary {
  region: string;
  failedOrganizations: string[];
  difficulty: number;
  occlusionPenalty: number;
}

/**
 * Derive FailureCase rows from benchmark evaluations: regions that stayed
 * uncaptured for at least one organization under the world's noise/occlusion
 * conditions. Sorted worst-first, capped. P6.C11: each case is classified
 * REGION_UNCAPTURED with its structured payload.
 */
export async function recordRegionFailures(
  db: PrismaClient,
  benchmarkRunId: string,
  worldSeed: number,
  evaluations: Array<{
    organizationId: string;
    detail: Record<string, unknown>;
  }>,
  max = 3
): Promise<string[]> {
  const byRegion = new Map<string, RegionFailureSummary>();
  for (const ev of evaluations) {
    const regionSim = (ev.detail.regionSimulation as Array<{
      region: string;
      difficulty: number;
      occlusionPenalty: number;
      captured: boolean;
    }> | undefined) ?? [];
    for (const r of regionSim) {
      if (r.captured) continue;
      const cur = byRegion.get(r.region) ?? {
        region: r.region,
        failedOrganizations: [],
        difficulty: r.difficulty,
        occlusionPenalty: r.occlusionPenalty,
      };
      cur.failedOrganizations.push(ev.organizationId);
      byRegion.set(r.region, cur);
    }
  }
  const ranked = [...byRegion.values()].sort(
    (a, b) => b.failedOrganizations.length - a.failedOrganizations.length || b.difficulty - a.difficulty
  );
  const ids: string[] = [];
  for (const f of ranked.slice(0, max)) {
    const classified = classifyRegionFailure({
      region: f.region,
      regionDifficulty: f.difficulty,
      occlusionPenalty: f.occlusionPenalty,
      worldSeed,
    });
    const rec = await recordClassifiedFailureCase(db, {
      benchmarkRunId,
      inputConditions: {
        simulated: true,
        worldSeed,
        region: f.region,
        regionDifficulty: f.difficulty,
        occlusionPenalty: f.occlusionPenalty,
        failedOrganizations: [...f.failedOrganizations],
        note: 'Lab simulation conditions — simulated research truth, not production human truth',
      },
      classified,
      suspectedCause:
        f.occlusionPenalty > 0.1
          ? `Region "${f.region}" was occluded in the seeded world (occlusion penalty ${f.occlusionPenalty}) and its capture difficulty (${f.difficulty}) exceeded the organizations' effective sensitivity thresholds.`
          : `Region "${f.region}" has high capture difficulty (${f.difficulty}) under the world's noise conditions; single-pass and staged thresholds both miss it.`,
      confidence: Math.min(0.9, 0.55 + f.failedOrganizations.length * 0.1),
      remediation:
        f.region === 'hands'
          ? 'Request targeted hand evidence (palms visible, fingers spread) via an EvidenceRequest and add a hand-specialist stage to the next searched genome.'
          : f.region === 'hair.back'
            ? 'Request a rear-view head capture and raise the segmenter granularity for hair regions in the next generation.'
            : `Request targeted "${f.region}" evidence via an EvidenceRequest and re-benchmark the mutated genome on the same seed.`,
    });
    ids.push(rec.id);
  }
  return ids;
}
