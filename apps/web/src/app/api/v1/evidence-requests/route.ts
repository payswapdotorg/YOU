// GET  /api/v1/evidence-requests — list (newest first)
// POST /api/v1/evidence-requests — request targeted additional evidence
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { badRequest, handleRoute, notFound, readJsonBody, reqString, optString } from '@/lib/you/core/errors';
import { emitEvent } from '@/lib/you/core/events';
import { evidenceRequestView } from '@/lib/you/core/views';

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const requests = await db.evidenceRequest.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return Response.json(requests.map(evidenceRequestView));
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const body = await readJsonBody(request);

    const reason = reqString(body, 'reason', { max: 1000 });
    const capability = reqString(body, 'capability', { max: 60 });
    const instructions = reqString(body, 'instructions', { max: 2000 });
    const expectedSignal = reqString(body, 'expectedSignal', { max: 500 });
    const scope = optString(body, 'scope', { max: 300 }) ?? 'single additional capture for the stated deficiency; derived outputs only';

    let twinVersionId: string | null = null;
    if (body.twinVersionId !== undefined && body.twinVersionId !== null) {
      if (typeof body.twinVersionId !== 'string') throw badRequest('twinVersionId must be a string');
      const twinVersion = await db.twinVersion.findFirst({
        where: { id: body.twinVersionId, twin: { tenantId: auth.tenantId } },
      });
      if (!twinVersion) throw notFound(`twin version "${body.twinVersionId}" not found`);
      twinVersionId = twinVersion.id;
    }

    const evidenceRequest = await db.evidenceRequest.create({
      data: {
        tenantId: auth.tenantId,
        twinVersionId,
        reason,
        capability,
        instructions,
        expectedSignal,
        scope,
        status: 'open',
      },
    });

    await emitEvent(auth.tenantId, 'evidence.requested', 'evidence_request', evidenceRequest.id, {
      requestId: evidenceRequest.id,
      capability,
      twinVersionId,
      reason,
    });

    return Response.json(evidenceRequestView(evidenceRequest), { status: 201 });
  });
}
