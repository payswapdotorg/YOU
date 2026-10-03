// GET    /api/v1/agent/sessions/:id — session detail with the real turn
//         history (states = emitted performance events; per-turn seed, model,
//         latency + the honest turn-job status join)
// DELETE /api/v1/agent/sessions/:id — EXPLICIT teardown (live → ended).
//         Idempotent: an already-ended session returns 204 unchanged.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, notFound } from '@/lib/you/core/errors';
import { endRuntimeSession, runtimeSessionView, toHttpError } from '@/lib/you/agent/runtime';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const session = await db.agentRuntimeSession.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { twin: true, body: true, soul: true, turns: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) throw notFound(`agent session "${id}" not found`);

    // honest turn-job status join (bounded to the turns on this session)
    const jobIds = [...new Set(session.turns.map((t) => t.jobId).filter((j): j is string => !!j))];
    const jobs = jobIds.length ? await db.job.findMany({ where: { id: { in: jobIds } } }) : [];
    const jobsById = new Map(jobs.map((j) => [j.id, j]));

    return Response.json(runtimeSessionView(session, session.turns, jobsById));
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    try {
      await endRuntimeSession(auth.tenantId, id);
      return new Response(null, { status: 204 });
    } catch (err) {
      throw toHttpError(err);
    }
  });
}
