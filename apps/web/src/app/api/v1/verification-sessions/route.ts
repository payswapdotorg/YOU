// POST /api/v1/verification-sessions — open a verification session (A4, §Trust).
// Server-enforced consent: an ACTIVE grant with the "capture" scope for the
// subject is required (the frozen ConsentScope union has no 'verify' member —
// see w2a-report.md compatibility note). Creates an ACTIVE liveness challenge
// (SECURITY_PRIVACY control 1) and returns the session view.
// GET  /api/v1/verification-sessions — list for the tenant (additive read
// route, consistent with the established list-route pattern).
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { requireConsent } from '@/lib/you/core/consent';
import { badRequest, handleRoute, notFound, readJsonBody, reqString } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import {
  generateChallenge, sessionExpiry, verificationSessionView,
} from '@/lib/you/core/verification';

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const sessions = await db.verificationSession.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return Response.json(sessions.map(verificationSessionView));
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const body = await readJsonBody(request);

    const subjectId = reqString(body, 'subjectId', { max: 80 });
    const purpose = reqString(body, 'purpose', { max: 400 });

    // optional twin linkage: must belong to the tenant AND to the same subject
    let twinId: string | null = null;
    if (body.twinId !== undefined && body.twinId !== null) {
      if (typeof body.twinId !== 'string') throw badRequest('twinId must be a string');
      const twin = await db.twin.findFirst({ where: { id: body.twinId, tenantId: auth.tenantId } });
      if (!twin) throw notFound(`twin "${body.twinId}" not found`);
      if (twin.subjectId !== subjectId) {
        throw badRequest(
          `twin "${twin.id}" belongs to subject ${twin.subjectId}, not ${subjectId} — a verification session can only attest a twin of the same subject`,
        );
      }
      twinId = twin.id;
    }

    // server-enforced consent BEFORE any session is opened
    const grant = await requireConsent(auth.tenantId, subjectId, 'capture');

    const challenge = generateChallenge();
    const session = await db.verificationSession.create({
      data: {
        tenantId: auth.tenantId,
        subjectId,
        twinId,
        purpose,
        method: 'liveness-challenge',
        status: 'pending',
        challenge: JSON.stringify(challenge),
        evidenceAssetIds: '[]',
        consentGrantId: grant.id,
        expiresAt: sessionExpiry(),
      },
    });

    await audit(auth.tenantId, auth, 'verification.session.created', 'verification_session', session.id, {
      subjectId,
      twinId,
      purpose,
      method: session.method,
      challengeVariant: challenge.variant,
      consentGrantId: grant.id,
      expiresAt: session.expiresAt.toISOString(),
    });
    await emitEvent(auth.tenantId, 'verification.session.created', 'verification_session', session.id, {
      sessionId: session.id,
      subjectId,
      twinId,
      purpose,
      challengeVariant: challenge.variant,
      requiredRegions: challenge.requiredRegions,
      consentGrantId: grant.id,
    });

    return Response.json(verificationSessionView(session), { status: 201 });
  });
}
