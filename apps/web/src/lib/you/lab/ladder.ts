// ═══════════════════════════════════════════════════════════════════════════
// Promotion ladder (Worker C lane, P6.C10) — docs/LAB_DESIGN.md "Promotion":
//   Draft -> benchmarked -> validated -> canary -> production -> retired.
//   Promotion is evidence-driven and reversible.
//
// PURE + zero-import (node:test-importable, the suite law): no db, no clock,
// no randomness. The routes (promotions/gates) and the promotion gate engine
// (lab/promotion.ts) consume this; the contract suite asserts the full
// transition table.
// ═══════════════════════════════════════════════════════════════════════════

export type LabPipelineStatus = 'draft' | 'benchmarked' | 'validated' | 'canary' | 'production' | 'retired';

/** The stages a `promote` can move a pipeline TO (never draft, never retired). */
export type PromoteTarget = 'benchmarked' | 'validated' | 'canary' | 'production';

export const LAB_PIPELINE_STATUSES: readonly LabPipelineStatus[] = [
  'draft', 'benchmarked', 'validated', 'canary', 'production', 'retired',
] as const;

export function isLabPipelineStatus(status: string): status is LabPipelineStatus {
  return (LAB_PIPELINE_STATUSES as readonly string[]).includes(status);
}

/** The ladder in order (retired is terminal — OFF the ladder). */
const LADDER: readonly LabPipelineStatus[] = ['draft', 'benchmarked', 'validated', 'canary', 'production'];

/**
 * The ONLY legal promote target from a status: exactly one stage forward.
 * NO skipping. production has no target (the top); retired is terminal.
 */
export function promoteTarget(status: LabPipelineStatus): PromoteTarget | null {
  switch (status) {
    case 'draft':
      return 'benchmarked';
    case 'benchmarked':
      return 'validated';
    case 'validated':
      return 'canary';
    case 'canary':
      return 'production';
    default:
      return null; // production is the top of the ladder; retired is terminal
  }
}

/** Any live stage may retire (terminal). A retired pipeline cannot retire again. */
export function canRetire(status: LabPipelineStatus): boolean {
  return status !== 'retired';
}

/**
 * A revert target must be a REAL backward step on the ladder — or an
 * un-retire (retired → any live stage; the honest trail-derived target is
 * whatever the pipeline held before it was retired). A live pipeline
 * reverts exactly ONE stage: the trail-derived prior is always the
 * immediate predecessor (promote/draft/retire records are all single-step),
 * so anything else is incoherent and refused.
 */
export function canRevert(from: LabPipelineStatus, to: LabPipelineStatus): boolean {
  if (from === 'retired') return to !== 'retired'; // un-retire
  const fi = LADDER.indexOf(from);
  const ti = LADDER.indexOf(to);
  return fi > 0 && ti === fi - 1; // exactly one stage back
}

export interface PromotionTrailEntry {
  decision: string; // promoted | rejected | reverted | drafted | retired
  fromStatus: string;
  toStatus: string;
  createdAt: Date | string | number;
}

/**
 * The status the pipeline held BEFORE its most recent forward transition,
 * computed from the promotion trail (newest-first):
 *   - 'promoted' / 'drafted' / 'retired' are FORWARD moves — the newest one's
 *     fromStatus is the revert target (retiring counts as forward: reverting
 *     a retired pipeline un-retires it to its pre-retire status);
 *   - 'rejected' never moved anything — skipped;
 *   - 'reverted' is a backward move — skipped (the prior is defined by the
 *     latest forward move, so a double-revert lands on the honest
 *     already-at-prior 409 instead of walking further back).
 * null = no forward move ever happened — nothing to revert to.
 */
export function priorStatusForRevert(trail: PromotionTrailEntry[]): LabPipelineStatus | null {
  const FORWARD_DECISIONS = new Set(['promoted', 'drafted', 'retired']);
  const sorted = [...trail].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  for (const entry of sorted) {
    if (!FORWARD_DECISIONS.has(entry.decision)) continue;
    return isLabPipelineStatus(entry.fromStatus) ? entry.fromStatus : null;
  }
  return null;
}

export interface PromotionStageRequirement {
  label: string;
  detail: string;
  /** the machine-checked criteria, for the contract suite + the report */
  criteria: readonly string[];
}

/**
 * Per-stage evidence requirements (what the server machine-checks before a
 * promote to that stage is allowed) — rendered by the gates preview and
 * enforced by lab/promotion.ts.
 */
export const PROMOTION_STAGE_REQUIREMENTS: Record<PromoteTarget, PromotionStageRequirement> = {
  benchmarked: {
    label: 'One succeeded benchmark run',
    detail:
      'At least one succeeded BenchmarkRun whose organizations[] includes this pipeline — machine-checked from real run rows.',
    criteria: ['run.status = succeeded', 'run.organizations[].pipelineId = pipeline'],
  },
  validated: {
    label: 'Objective machine gates + deterministic replay',
    detail:
      'The objective\u2019s machine gates pass on the pipeline\u2019s newest report AND at least two same-seed runs replay byte-identical (real measurements stripped from the projection).',
    criteria: ['objective machine gates pass', '\u22652 same-seed runs', 'replay projections byte-identical'],
  },
  canary: {
    label: 'Newest-3-run window spanning \u22651h',
    detail:
      'The newest three same-seed runs span at least one hour of real time, all reproducible, objective gates passing.',
    criteria: ['\u22653 same-seed runs', 'window span \u2265 1h of real time', 'all reproducible', 'gates passing'],
  },
  production: {
    label: 'Canary evidence + zero blocking failures',
    detail:
      'Canary evidence plus zero FailureCases inside the window for regions this organization still missed (unknown is unknown — conservative).',
    criteria: ['canary evidence', 'no blocking failures inside the window'],
  },
};
