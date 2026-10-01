// POST /api/v1/performances/from-text — durable performance.fromText job
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { badRequest, handleRoute, readJsonBody, reqString, getIdempotencyKey } from '@/lib/you/core/errors';
import { createJob } from '@/lib/you/core/jobs';

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const body = await readJsonBody(request);

    const name = reqString(body, 'name', { max: 160 });
    const script = reqString(body, 'script', { max: 20000 });

    let twinId: string | null = null;
    if (body.twinId !== undefined && body.twinId !== null) {
      if (typeof body.twinId !== 'string') throw badRequest('twinId must be a string');
      const twin = await db.twin.findFirst({ where: { id: body.twinId, tenantId: auth.tenantId } });
      if (!twin) throw badRequest(`twin "${body.twinId}" not found`);
      twinId = twin.id;
    }

    const job = await createJob(
      auth.tenantId,
      'performance.fromText',
      { name, script, twinId },
      getIdempotencyKey(request),
    );

    return Response.json({ jobId: job.id }, { status: 202 });
  });
}
