// GET  /api/v1/twins — list | POST /api/v1/twins — create (draft, new subjectId)
import { randomBytes } from 'crypto';
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, readJsonBody, reqString, optString } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { twinView } from '@/lib/you/core/views';

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const twins = await db.twin.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return Response.json(twins.map(twinView));
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const body = await readJsonBody(request);
    const displayName = reqString(body, 'displayName', { max: 120 });
    const personName = optString(body, 'personName', { max: 120 });

    const twin = await db.twin.create({
      data: {
        tenantId: auth.tenantId,
        displayName,
        personName: personName ?? null,
        subjectId: `subj_${randomBytes(12).toString('hex')}`, // opaque, 24 hex
        status: 'draft',
        currentVersion: 0,
      },
    });

    await audit(auth.tenantId, auth, 'twin.created', 'twin', twin.id, { displayName, subjectId: twin.subjectId });
    await emitEvent(auth.tenantId, 'twin.created', 'twin', twin.id, {
      twinId: twin.id,
      displayName,
      subjectId: twin.subjectId,
    });

    return Response.json(twinView(twin), { status: 201 });
  });
}
