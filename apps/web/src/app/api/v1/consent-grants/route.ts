// GET  /api/v1/consent-grants — list (revoked/expired included, states visible)
// POST /api/v1/consent-grants — grant (subjectId, purpose, scopes, ttlHours…)
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { isValidScopeList } from '@/lib/you/core/consent';
import { badRequest, handleRoute, optNumber, optStringArray, readJsonBody, reqString } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { consentGrantView } from '@/lib/you/core/views';

const DEFAULT_TTL_HOURS = 24;
const MAX_TTL_HOURS = 720;

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const grants = await db.consentGrant.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return Response.json(grants.map(consentGrantView));
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const body = await readJsonBody(request);

    const subjectId = reqString(body, 'subjectId', { max: 80 });
    const purpose = reqString(body, 'purpose', { max: 400 });

    if (!isValidScopeList(body.scopes)) {
      throw badRequest('scopes must be a non-empty subset of ["capture","reconstruct","render","embodiment"]');
    }
    const scopes = body.scopes;

    let operations: string[] | undefined = optStringArray(body, 'operations');
    if (operations === undefined) operations = [...scopes]; // default: the scopes themselves

    let outputs: string[] | undefined = optStringArray(body, 'outputs');
    if (outputs === undefined) outputs = ['derived']; // raw evidence never included by default

    let ttlHours = optNumber(body, 'ttlHours');
    if (ttlHours === undefined) ttlHours = DEFAULT_TTL_HOURS;
    if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > MAX_TTL_HOURS) {
      throw badRequest(`ttlHours must be an integer between 1 and ${MAX_TTL_HOURS}`);
    }

    const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);
    const grant = await db.consentGrant.create({
      data: {
        tenantId: auth.tenantId,
        subjectId,
        granteeId: `tenant:${auth.tenantId}`,
        purpose,
        scopes: JSON.stringify(scopes),
        operations: JSON.stringify(operations),
        outputs: JSON.stringify(outputs),
        expiresAt,
      },
    });

    await audit(auth.tenantId, auth, 'consent.granted', 'consent_grant', grant.id, {
      subjectId,
      purpose,
      scopes,
      outputs,
      expiresAt: expiresAt.toISOString(),
    });
    await emitEvent(auth.tenantId, 'consent.granted', 'consent_grant', grant.id, {
      grantId: grant.id,
      subjectId,
      purpose,
      scopes,
      expiresAt: expiresAt.toISOString(),
    });

    return Response.json(consentGrantView(grant), { status: 201 });
  });
}
