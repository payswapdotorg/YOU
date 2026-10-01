// POST /api/v1/captures/:id/complete — kick the durable capture.quality job.
// Session moves to "analyzing"; the executor advances it to complete/failed.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, notFound, conflict, getIdempotencyKey } from '@/lib/you/core/errors';
import { createJob } from '@/lib/you/core/jobs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;

    const session = await db.captureSession.findFirst({ where: { id, tenantId: auth.tenantId } });
    if (!session) throw notFound(`capture session "${id}" not found`);
    if (session.status === 'analyzing' || session.status === 'complete') {
      throw conflict(`capture session "${id}" is already ${session.status}`);
    }
    if (session.status === 'failed') throw conflict(`capture session "${id}" failed — start a new session`);

    await db.captureSession.update({ where: { id: session.id }, data: { status: 'analyzing' } });

    const job = await createJob(
      auth.tenantId,
      'capture.quality',
      { captureSessionId: session.id, twinId: session.twinId },
      getIdempotencyKey(request),
    );

    return Response.json({ jobId: job.id }, { status: 202 });
  });
}
