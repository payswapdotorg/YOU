// POST /api/v1/jobs/dead/:id/replay — P6.A6 dead-letter replay (admin-gated).
//
// Re-queues the SAME durable job row (input preserved, fresh attempt
// lifecycle); the deadLetter payload keeps the full replay history. The
// response is 202 { jobId } — replay is fire-and-forget exactly like every
// other durable job submission; poll GET /api/v1/jobs/:id for the outcome.
//
// Admin gate = the maintenance precedent: operator SESSION only; API keys
// are refused (403).
import { requireApiAuth } from '@/lib/you/core/auth';
import { forbidden, handleRoute } from '@/lib/you/core/errors';
import { replayDeadJob } from '@/lib/you/core/jobs';
import { audit, emitEvent } from '@/lib/you/core/events';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    if (auth.actorType !== 'user') {
      // replaying dead jobs is an operator action — session auth only
      throw forbidden('dead-job replay requires an operator session (api keys are not permitted)');
    }
    const { id } = await params;

    const job = await replayDeadJob(auth.tenantId, id, auth.actorId);

    await audit(auth.tenantId, auth, 'job.replayed', 'job', job.id, { jobId: job.id, kind: job.kind });
    await emitEvent(auth.tenantId, 'job.replayed', 'job', job.id, { jobId: job.id, kind: job.kind });

    return Response.json({ jobId: job.id }, { status: 202 });
  });
}
