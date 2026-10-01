// GET /api/v1/lab/pipelines — PipelineCandidateView[] (genome parsed)
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute } from '@/lib/you/core/errors';
import { pipelineCandidateView } from '@/lib/you/core/views';

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    await requireApiAuth(request);
    const pipelines = await db.pipelineCandidate.findMany({ orderBy: { createdAt: 'desc' } });
    return Response.json(pipelines.map(pipelineCandidateView));
  });
}
