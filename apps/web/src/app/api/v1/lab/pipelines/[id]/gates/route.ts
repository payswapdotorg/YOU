// GET /api/v1/lab/pipelines/:id/gates — the honest promotion preview
// (P6.C10): for the pipeline's CURRENT status, evaluate the next promote
// target's evidence gates from the real run data — what passes, what fails,
// what evidence exists. The UI renders this before any promotion attempt.
// Research-plane global (the pipeline model carries no tenant); auth required.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, notFound } from '@/lib/you/core/errors';
import { pipelineCandidateView } from '@/lib/you/core/views';
import { isLabPipelineStatus, PROMOTION_STAGE_REQUIREMENTS, promoteTarget } from '@/lib/you/lab/ladder';
import { evaluatePromotionEvidence, failuresForRuns, runsForPipeline } from '@/lib/you/lab/promotion';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    await requireApiAuth(request);
    const { id } = await params;

    const pipeline = await db.pipelineCandidate.findUnique({ where: { id } });
    if (!pipeline) throw notFound(`pipeline candidate "${id}" not found`);
    if (!isLabPipelineStatus(pipeline.status)) {
      throw notFound(`pipeline has unknown status "${pipeline.status}"`);
    }

    const target = promoteTarget(pipeline.status);
    const observations = await runsForPipeline(db, id);
    const trail = await db.promotionRecord.findMany({
      where: { pipelineId: id },
      orderBy: { createdAt: 'desc' },
    });

    const base = {
      pipeline: pipelineCandidateView(pipeline),
      status: pipeline.status,
      target,
      requirement: target ? PROMOTION_STAGE_REQUIREMENTS[target] : null,
      succeededRunIds: observations.map((o) => o.runId),
      promotionCount: trail.length,
    };

    if (!target) {
      return Response.json({
        ...base,
        evaluation: null,
        note:
          pipeline.status === 'production'
            ? 'production is the top of the ladder — only retire (or revert) applies from here'
            : 'retired is terminal — nothing to promote or revert',
      });
    }

    const failureRows = await failuresForRuns(db, observations.map((o) => o.runId));
    const evaluation = evaluatePromotionEvidence(observations, target, failureRows);
    return Response.json({ ...base, evaluation });
  });
}
