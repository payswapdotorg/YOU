// GET  /api/v1/lab/promotions — PromotionRecordView[] (list, newest first)
// POST /api/v1/lab/promotions — the promotion lifecycle (P6.C10).
//
// Server-enforced ladder transitions with per-stage EVIDENCE GATES:
//   promote  draft → benchmarked → validated → canary → production
//            (NO stage skipping; every gate machine-checked from real run
//            data; every transition writes a PromotionRecord with evidence
//            refs; decidedBy records the authenticated actor)
//   reject   records a refusal decision on the current stage (reason required)
//   revert   returns the pipeline to its prior status and records why
//            (computed from the promotion trail — nothing to revert to is an
//            honest 409)
//   retire   any stage → retired (terminal)
//
// The Lab research plane is GLOBAL (PipelineCandidate/PromotionRecord carry no
// tenant — the existing lab model); any authenticated caller acts as the
// deciding operator and is recorded verbatim in decidedBy.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import {
  badRequest, conflict, handleRoute, notFound, optString, optStringArray, readJsonBody, reqString,
} from '@/lib/you/core/errors';
import { emitEvent } from '@/lib/you/core/events';
import { pipelineCandidateView, promotionRecordView } from '@/lib/you/core/views';
import {
  canRetire, canRevert, isLabPipelineStatus, priorStatusForRevert, promoteTarget,
} from '@/lib/you/lab/ladder';
import { evaluatePromotionEvidence, failuresForRuns, runsForPipeline } from '@/lib/you/lab/promotion';

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    await requireApiAuth(request);
    const promotions = await db.promotionRecord.findMany({ orderBy: { createdAt: 'desc' } });
    return Response.json(promotions.map(promotionRecordView));
  });
}

type PromotionAction = 'promote' | 'reject' | 'revert' | 'retire';
const ACTIONS: readonly PromotionAction[] = ['promote', 'reject', 'revert', 'retire'] as const;

/** The auditable actor string recorded in decidedBy. */
function actorLabel(auth: { actorType: string; actorId: string }): string {
  return `${auth.actorType}:${auth.actorId}`;
}

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const body = await readJsonBody(request);

    const pipelineId = reqString(body, 'pipelineId');
    const action = reqString(body, 'action') as PromotionAction;
    if (!(ACTIONS as readonly string[]).includes(action)) {
      throw badRequest(`action must be one of ${ACTIONS.join(' | ')}`);
    }
    const reason = optString(body, 'reason', { max: 2000 });
    const note = optString(body, 'note', { max: 2000 });
    const benchmarkRunIds = optStringArray(body, 'benchmarkRunIds');

    const pipeline = await db.pipelineCandidate.findUnique({ where: { id: pipelineId } });
    if (!pipeline) throw notFound(`pipeline candidate "${pipelineId}" not found`);
    if (!isLabPipelineStatus(pipeline.status)) {
      throw conflict(`pipeline has unknown status "${pipeline.status}" — refusing to act on it`);
    }

    // cited evidence refs must all exist and include this pipeline
    let observations = await runsForPipeline(db, pipelineId, benchmarkRunIds);
    if (benchmarkRunIds && benchmarkRunIds.length > 0) {
      const found = new Set(observations.map((o) => o.runId));
      for (const id of benchmarkRunIds) {
        if (!found.has(id)) {
          throw notFound(`cited benchmark run "${id}" does not exist or does not include pipeline "${pipelineId}"`);
        }
      }
    }

    const decidedBy = actorLabel(auth);
    const from = pipeline.status;

    if (action === 'promote') {
      const target = promoteTarget(from);
      if (!target) {
        throw conflict(
          from === 'production'
            ? 'production is the top of the ladder — only retire (or revert) applies from here'
            : `"${from}" has no promote target (retired is terminal)`,
          { reason: 'illegal_transition', from },
        );
      }
      if (body.to !== undefined && body.to !== target) {
        throw badRequest(`the only legal promote target from "${from}" is "${target}" — got "${String(body.to)}"`);
      }
      const failureRows = await failuresForRuns(db, observations.map((o) => o.runId));
      const evaluation = evaluatePromotionEvidence(observations, target, failureRows);
      if (!evaluation.pass) {
        throw conflict(
          `promotion to "${target}" refused — ${evaluation.reason}`,
          { reason: 'gate_failed', target, evaluation },
        );
      }
      const record = await db.promotionRecord.create({
        data: {
          pipelineId,
          fromStatus: from,
          toStatus: target,
          decision: 'promoted',
          evidence: JSON.stringify({
            evaluation,
            reason: reason ?? null,
            note: note ?? null,
            citedRunIds: benchmarkRunIds ?? null,
            simulated: true,
            simulationNote:
              'Lab evidence is simulated research truth — deterministic seeded worlds + labeled measurements; never production human truth',
          }),
          decidedBy,
        },
      });
      const updated = await db.pipelineCandidate.update({
        where: { id: pipelineId },
        data: { status: target },
      });
      await emitEvent(auth.tenantId, 'lab.promotion.recorded', 'pipeline_candidate', pipelineId, {
        promotionId: record.id,
        pipelineId,
        fromStatus: from,
        toStatus: target,
        decision: 'promoted',
        decidedBy,
        runIds: evaluation.runIds,
      });
      return Response.json({
        promotion: promotionRecordView(record),
        pipeline: pipelineCandidateView(updated),
        evaluation,
      });
    }

    if (action === 'reject') {
      if (!reason || !reason.trim()) throw badRequest('reject requires a reason (the refusal must be auditable)');
      if (from === 'retired') throw conflict('a retired pipeline cannot be rejected — it is terminal');
      const record = await db.promotionRecord.create({
        data: {
          pipelineId,
          fromStatus: from,
          toStatus: from,
          decision: 'rejected',
          evidence: JSON.stringify({
            reason,
            note: note ?? null,
            citedRunIds: benchmarkRunIds ?? null,
            simulated: true,
          }),
          decidedBy,
        },
      });
      await emitEvent(auth.tenantId, 'lab.promotion.recorded', 'pipeline_candidate', pipelineId, {
        promotionId: record.id,
        pipelineId,
        fromStatus: from,
        toStatus: from,
        decision: 'rejected',
        decidedBy,
      });
      return Response.json({
        promotion: promotionRecordView(record),
        pipeline: pipelineCandidateView(pipeline),
      });
    }

    if (action === 'revert') {
      if (!reason || !reason.trim()) throw badRequest('revert requires a reason (why the pipeline goes back)');
      const trail = await db.promotionRecord.findMany({ where: { pipelineId } });
      const prior = priorStatusForRevert(
        trail.map((t) => ({
          decision: t.decision,
          fromStatus: t.fromStatus,
          toStatus: t.toStatus,
          createdAt: t.createdAt,
        })),
      );
      if (!prior) {
        throw conflict(
          'nothing to revert to — this pipeline has no recorded forward transition',
          { reason: 'no_prior_status' },
        );
      }
      if (from === prior) {
        throw conflict(
          `the pipeline already sits at its prior status "${prior}"`,
          { reason: 'already_at_prior_status', prior },
        );
      }
      if (!canRevert(from, prior)) {
        // the trail must be a real backward step on the ladder (or an
        // un-retire) — refuse anything incoherent instead of writing a weird status
        throw conflict(
          `incoherent revert target "${prior}" from "${from}" — refusing`,
          { reason: 'incoherent_revert', prior, from },
        );
      }
      const record = await db.promotionRecord.create({
        data: {
          pipelineId,
          fromStatus: from,
          toStatus: prior,
          decision: 'reverted',
          evidence: JSON.stringify({
            reason,
            note: note ?? null,
            simulated: true,
          }),
          decidedBy,
        },
      });
      const updated = await db.pipelineCandidate.update({
        where: { id: pipelineId },
        data: { status: prior },
      });
      await emitEvent(auth.tenantId, 'lab.promotion.recorded', 'pipeline_candidate', pipelineId, {
        promotionId: record.id,
        pipelineId,
        fromStatus: from,
        toStatus: prior,
        decision: 'reverted',
        decidedBy,
      });
      return Response.json({
        promotion: promotionRecordView(record),
        pipeline: pipelineCandidateView(updated),
      });
    }

    // retire
    if (!canRetire(from)) throw conflict('retired is terminal — nothing to retire');
    const record = await db.promotionRecord.create({
      data: {
        pipelineId,
        fromStatus: from,
        toStatus: 'retired',
        decision: 'retired',
        evidence: JSON.stringify({
          reason: reason ?? null,
          note: note ?? null,
          simulated: true,
        }),
        decidedBy,
      },
    });
    const updated = await db.pipelineCandidate.update({
      where: { id: pipelineId },
      data: { status: 'retired' },
    });
    await emitEvent(auth.tenantId, 'lab.promotion.recorded', 'pipeline_candidate', pipelineId, {
      promotionId: record.id,
      pipelineId,
      fromStatus: from,
      toStatus: 'retired',
      decision: 'retired',
      decidedBy,
    });
    return Response.json({
      promotion: promotionRecordView(record),
      pipeline: pipelineCandidateView(updated),
    });
  });
}
