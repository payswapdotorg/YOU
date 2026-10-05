// ═══════════════════════════════════════════════════════════════════════════
// Promotion evidence gates (Worker C lane, P6.C10) — db-facing.
// Machine-checks the per-stage promotion gates from REAL run rows:
//   benchmarked — ≥1 succeeded run whose organizations[] carries the pipeline;
//   validated   — the objective's machine gates pass (lab/evaluators.ts) PLUS
//                 byte-identical deterministic replay across ≥2 same-seed
//                 runs (lab/replay.ts — real measurements stripped);
//   canary      — the newest-3 same-seed run window spanning ≥1h of real
//                 time, all reproducible, gates passing;
//   production  — canary evidence PLUS zero FailureCases inside the window
//                 for regions this org still missed (unknown is unknown —
//                 conservative).
// Server-side module (routes + executors import it); the PURE halves
// (evaluators/replay/ladder) are node:test-importable.
// ═══════════════════════════════════════════════════════════════════════════
import type { FailureCase, PrismaClient } from '@prisma/client';
import type { LabCanaryWindowView, LabPromotionEvaluationView } from '../contracts';
import type { PromoteTarget } from './ladder';
import { evaluateObjectiveGates } from './evaluators';
import { projectForDeterministicReplay, replayVerdict } from './replay';

/** The evidence run + the pipeline's own organization report inside it. */
export interface PipelineRunObservation {
  runId: string;
  createdAt: Date;
  worldSeed: number;
  status: string;
  /** the run's objective gates JSON (parsed) — drives the machine verdicts */
  gates: Record<string, unknown>;
  report: {
    organizationId: string;
    scores: Record<string, number>;
    reproducible: boolean;
    detail: Record<string, unknown>;
  } | null;
}

function parseJsonObj(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseScores(raw: string): Record<string, number> {
  const obj = parseJsonObj(raw);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

interface OrgDescriptorRow {
  organizationId?: unknown;
  pipelineId?: unknown;
}

/**
 * Succeeded runs whose organizations[] includes this pipeline, newest first,
 * each joined with the pipeline's OWN organization report. Optionally
 * constrained to cited run ids (the promotions route validates the citation
 * set — an id that exists but does not include the pipeline is the caller's
 * not-found, surfaced by the route).
 */
export async function runsForPipeline(
  db: PrismaClient,
  pipelineId: string,
  benchmarkRunIds?: string[],
): Promise<PipelineRunObservation[]> {
  const runs = await db.benchmarkRun.findMany({
    where: {
      status: 'succeeded',
      ...(benchmarkRunIds && benchmarkRunIds.length > 0 ? { id: { in: benchmarkRunIds } } : {}),
    },
    include: { reports: true },
    orderBy: { createdAt: 'desc' },
  });

  const objectives = await db.labObjective.findMany();
  const gatesByObjective = new Map<string, Record<string, unknown>>(
    objectives.map((o) => [o.id, parseJsonObj(o.gates)]),
  );

  const observations: PipelineRunObservation[] = [];
  for (const run of runs) {
    // organizations is stored as a JSON array of org descriptors
    let list: OrgDescriptorRow[] = [];
    try {
      const parsed = JSON.parse(run.organizations) as unknown;
      if (Array.isArray(parsed)) list = parsed.filter((o): o is OrgDescriptorRow => !!o && typeof o === 'object');
    } catch {
      list = [];
    }
    const mine = list.filter(
      (o) => typeof o.pipelineId === 'string' && o.pipelineId === pipelineId,
    );
    if (mine.length === 0) continue;
    const orgIds = new Set(mine.map((o) => String(o.organizationId)));
    const report = run.reports.find((r) => orgIds.has(r.organizationId)) ?? null;
    observations.push({
      runId: run.id,
      createdAt: run.createdAt,
      worldSeed: run.worldSeed,
      status: run.status,
      gates: gatesByObjective.get(run.objectiveId) ?? {},
      report: report
        ? {
            organizationId: report.organizationId,
            scores: parseScores(report.scores),
            reproducible: report.reproducible,
            detail: parseJsonObj(report.detail),
          }
        : null,
    });
  }
  return observations;
}

/** Every FailureCase recorded against the given runs (deduped by prisma). */
export async function failuresForRuns(db: PrismaClient, runIds: string[]): Promise<FailureCase[]> {
  if (runIds.length === 0) return [];
  return db.failureCase.findMany({ where: { benchmarkRunId: { in: runIds } } });
}

const CANARY_WINDOW_RUNS = 3;
const CANARY_MIN_SPAN_MS = 60 * 60 * 1000; // ≥1h of REAL time

function gateVerdictsFor(o: PipelineRunObservation) {
  return evaluateObjectiveGates(o.gates, {
    scores: o.report?.scores ?? {},
    reproducible: o.report?.reproducible ?? false,
  });
}

function regionSimulationOf(detail: Record<string, unknown>): Array<{ region?: unknown; captured?: unknown }> {
  const sim = detail.regionSimulation;
  return Array.isArray(sim)
    ? sim.filter((r): r is { region?: unknown; captured?: unknown } => !!r && typeof r === 'object')
    : [];
}

/**
 * Evaluate the promotion evidence for a target stage. PURE over the
 * observations + failure rows (the db joins happen in runsForPipeline /
 * failuresForRuns — testable seams).
 */
export function evaluatePromotionEvidence(
  observations: PipelineRunObservation[],
  target: PromoteTarget | string,
  failureRows: FailureCase[],
): LabPromotionEvaluationView {
  // ─── benchmarked: ≥1 succeeded run including this pipeline ──────────────
  if (target === 'benchmarked') {
    const pass = observations.length >= 1;
    return {
      pass,
      target,
      reason: pass
        ? `${observations.length} succeeded run(s) include this pipeline`
        : 'no succeeded benchmark run includes this pipeline — run the benchmark first',
      runIds: observations.map((o) => o.runId),
      gates: null,
      replay: null,
      canary: null,
      blockingFailures: [],
    };
  }

  if (target !== 'validated' && target !== 'canary' && target !== 'production') {
    return {
      pass: false,
      target,
      reason: `unknown promotion target "${String(target)}" — refusing to evaluate`,
      runIds: [],
      gates: null,
      replay: null,
      canary: null,
      blockingFailures: [],
    };
  }

  const newest = observations[0] ?? null;
  if (!newest?.report) {
    return {
      pass: false,
      target,
      reason: 'no evaluation report for this pipeline exists yet — promotion needs real run evidence',
      runIds: [],
      gates: null,
      replay: null,
      canary: null,
      blockingFailures: [],
    };
  }

  // same-seed comparable runs (the canary/replay evidence pool)
  const sameSeed = observations.filter((o) => o.worldSeed === newest.worldSeed && o.report);

  // ─── validated: objective machine gates + deterministic replay ───────────
  if (target === 'validated') {
    const replay = replayVerdict(sameSeed.map((o) => projectForDeterministicReplay(o.report!)));
    const gateVerdicts = gateVerdictsFor(newest);
    const pass = replay.deterministic && gateVerdicts.machinePass;
    const reasons: string[] = [];
    if (!gateVerdicts.machinePass) reasons.push(gateVerdicts.note ?? 'objective gates did not pass');
    if (!replay.deterministic) reasons.push(replay.reason);
    return {
      pass,
      target,
      reason: reasons.length ? reasons.join('; ') : `objective machine gates pass and ${replay.reason}`,
      runIds: sameSeed.map((o) => o.runId),
      gates: { gates: gateVerdicts.checks },
      replay,
      canary: null,
      blockingFailures: [],
    };
  }

  // ─── canary / production: the newest-3-run window ────────────────────────
  const window = sameSeed.slice(0, CANARY_WINDOW_RUNS);
  const canary: LabCanaryWindowView = {
    runIds: window.map((o) => o.runId),
    spanMs:
      window.length >= 2
        ? window[0].createdAt.getTime() - window[window.length - 1].createdAt.getTime()
        : null,
    countOk: sameSeed.length >= CANARY_WINDOW_RUNS,
    spanOk: false, // set below
    allReproducible: window.every((o) => o.report!.reproducible),
    gatesOk: window.every((o) => gateVerdictsFor(o).machinePass),
  };
  canary.spanOk = canary.spanMs !== null && canary.spanMs >= CANARY_MIN_SPAN_MS;

  const replay = replayVerdict(sameSeed.map((o) => projectForDeterministicReplay(o.report!)));
  const gateVerdicts = gateVerdictsFor(newest);

  // blocking failures: rows from the window's runs for regions this org still
  // missed. unknown is unknown — a region absent from the org's simulation
  // (or a region-less failure) cannot be proven captured → blocks.
  const windowRunIds = new Set(canary.runIds);
  const blockingFailures: LabPromotionEvaluationView['blockingFailures'] = [];
  for (const row of failureRows) {
    if (!row.benchmarkRunId || !windowRunIds.has(row.benchmarkRunId)) continue;
    const run = window.find((o) => o.runId === row.benchmarkRunId);
    const conditions = parseJsonObj(row.inputConditions);
    const region = typeof conditions.region === 'string' ? conditions.region : null;
    let blocking: boolean;
    if (!region) {
      blocking = true; // unattributable failure inside the window — conservative
    } else {
      const entry = regionSimulationOf(run?.report?.detail ?? {}).find((r) => r.region === region);
      blocking = entry ? entry.captured !== true : true; // absent = unknown = block
    }
    if (blocking) {
      blockingFailures.push({ id: row.id, region, suspectedCause: row.suspectedCause });
    }
  }

  const canaryOk = canary.countOk && canary.spanOk && canary.allReproducible && canary.gatesOk;
  const canaryReasons: string[] = [];
  if (!canary.countOk) canaryReasons.push(`the canary window needs ${CANARY_WINDOW_RUNS} same-seed runs (found ${sameSeed.length})`);
  if (!canary.spanOk) canaryReasons.push('the newest-3-run window does not span ≥1h of real time');
  if (!canary.allReproducible) canaryReasons.push('not every run in the window reproduced');
  if (!canary.gatesOk) canaryReasons.push('objective gates do not pass on every run in the window');

  if (target === 'canary') {
    return {
      pass: canaryOk,
      target,
      reason: canaryOk
        ? `newest-${window.length}-run same-seed window spans ${Math.round((canary.spanMs ?? 0) / 60000)} min, all reproducible, gates passing`
        : canaryReasons.join('; '),
      runIds: sameSeed.map((o) => o.runId),
      gates: { gates: gateVerdicts.checks },
      replay,
      canary,
      blockingFailures,
    };
  }

  // production: canary evidence + zero blocking failures
  const pass = canaryOk && blockingFailures.length === 0;
  return {
    pass,
    target,
    reason: pass
      ? `canary evidence holds and no blocking failure sits inside the window (${blockingFailures.length})`
      : !canaryOk
        ? canaryReasons.join('; ')
        : `${blockingFailures.length} blocking failure(s) inside the canary window — regions this organization still missed (unknown is unknown)`,
    runIds: sameSeed.map((o) => o.runId),
    gates: { gates: gateVerdicts.checks },
    replay,
    canary,
    blockingFailures,
  };
}
