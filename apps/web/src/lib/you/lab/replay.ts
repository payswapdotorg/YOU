// ═══════════════════════════════════════════════════════════════════════════
// Deterministic replay (Worker C lane, P6.C10) — the learning ladder's first
// stage (docs/LAB_DESIGN.md): "deterministic replay" of the same seed must
// reproduce identical benchmark metrics.
//
// The projection strips the REAL-MEASUREMENT components (the W2.C grounding
// calls: scores.latencyMs, perStage.observedLatencyMs and the detail block's
// latency-honesty fields that embed the observed provider call) and keeps
// everything the seeded world + the genome determine — including
// genomeStages, so a mutated genome can never replay as its parent.
// Compared via stableStringify: byte-identical projections across same-seed
// runs = deterministic replay. A single observation is an HONEST non-pass
// (never a fabricated deterministic verdict).
// PURE (node:test-importable — runtime import follows the .ts law).
// ═══════════════════════════════════════════════════════════════════════════
import { stableStringify } from './determinism.ts';

export interface ReplayReportInput {
  scores: Record<string, unknown>;
  detail: Record<string, unknown>;
}

/** Real-measurement score fields the projection removes. */
const SCORE_MEASUREMENTS = ['latencyMs'] as const;

/** Real-measurement detail fields the projection removes (the W2.C honesty block). */
const DETAIL_MEASUREMENTS = [
  'groundingCall',
  'latencyRealMs',
  'llmLatencyComponents',
  'latencyComponentsLabeled',
  'latencyMsBasis',
  'latencyNote',
] as const;

/**
 * The deterministic projection of an evaluation report: everything the
 * seeded world + the genome determine, with the real measurements stripped.
 * (costUsd stays: it is always modeled. determinism/coverage/confidence
 * stay: pure functions of world + genome.)
 */
export function projectForDeterministicReplay(report: ReplayReportInput): Record<string, unknown> {
  const scores = { ...report.scores };
  for (const key of SCORE_MEASUREMENTS) delete scores[key];

  const detail = { ...report.detail };
  for (const key of DETAIL_MEASUREMENTS) delete detail[key];
  if (Array.isArray(detail.perStage)) {
    detail.perStage = detail.perStage.map((stage) => {
      if (!stage || typeof stage !== 'object') return stage;
      const copy = { ...(stage as Record<string, unknown>) };
      delete copy.observedLatencyMs;
      return copy;
    });
  }
  return { scores, detail };
}

export interface ReplayVerdict {
  deterministic: boolean;
  runsCompared: number;
  reason: string;
}

/**
 * Compare same-seed replay projections. The FIRST run is the reference;
 * every other run must be byte-identical to it (stableStringify).
 */
export function replayVerdict(projections: Array<Record<string, unknown>>): ReplayVerdict {
  if (projections.length === 0) {
    return {
      deterministic: false,
      runsCompared: 0,
      reason: 'no same-seed runs to compare — at least two are required',
    };
  }
  if (projections.length === 1) {
    return {
      deterministic: false,
      runsCompared: 1,
      reason: 'single observation — at least two same-seed runs are required to prove determinism (honest refusal, never a fabricated pass)',
    };
  }
  const reference = stableStringify(projections[0]);
  for (let i = 1; i < projections.length; i++) {
    if (stableStringify(projections[i]) !== reference) {
      return {
        deterministic: false,
        runsCompared: projections.length,
        reason: `diverged at run ${i + 1} — the projection differs from the reference run (a mutated genome or a changed world can never replay as its parent)`,
      };
    }
  }
  return {
    deterministic: true,
    runsCompared: projections.length,
    reason: `byte-identical across ${projections.length} same-seed runs (real measurements stripped from the projection)`,
  };
}
