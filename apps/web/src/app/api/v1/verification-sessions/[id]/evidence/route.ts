// POST /api/v1/verification-sessions/:id/evidence — submit existing evidence
// assets against the session's liveness challenge. Evidence is REFERENCED, not
// re-uploaded: every asset must belong to the tenant and come from a capture
// session of a twin whose subjectId equals the session's subjectId (evidence of
// the person being verified — no cross-subject evidence is accepted). Marks the
// challenge consumed and the session in_review.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { badRequest, conflict, handleRoute, notFound, readJsonBody } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { verificationSessionView } from '@/lib/you/core/verification';
import type { LivenessChallenge } from '@/lib/you/core/verification';
import { parseJson } from '@/lib/you/core/views';

const MAX_ASSETS = 16;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const body = await readJsonBody(request);

    const session = await db.verificationSession.findFirst({ where: { id, tenantId: auth.tenantId } });
    if (!session) throw notFound(`verification session "${id}" not found`);
    if (session.status !== 'pending' && session.status !== 'in_review') {
      throw conflict(`verification session "${id}" is already ${session.status}`);
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      const expired = await db.verificationSession.update({ where: { id: session.id }, data: { status: 'expired' } });
      throw conflict(`verification session "${id}" expired at ${expired.expiresAt.toISOString()}`);
    }

    const rawIds = body.evidenceAssetIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.some((x) => typeof x !== 'string' || !x.trim())) {
      throw badRequest('field "evidenceAssetIds" must be a non-empty array of evidence asset ids');
    }
    if (rawIds.length > MAX_ASSETS) {
      throw badRequest(`field "evidenceAssetIds" exceeds ${MAX_ASSETS} entries`);
    }
    const ids = [...new Set((rawIds as string[]).map((x) => x.trim()))];

    const assets = await db.evidenceAsset.findMany({
      where: { id: { in: ids }, tenantId: auth.tenantId },
      include: { captureSession: { include: { twin: true } } },
    });
    const found = new Set(assets.map((a) => a.id));
    const missing = ids.filter((x) => !found.has(x));
    if (missing.length > 0) {
      throw notFound(`evidence asset(s) not found in this tenant: ${missing.join(', ')}`);
    }
    const wrongSubject = assets.filter((a) => a.captureSession?.twin?.subjectId !== session.subjectId);
    if (wrongSubject.length > 0) {
      throw badRequest(
        `evidence asset(s) belong to a different subject: ${wrongSubject.map((a) => a.id).join(', ')} — only evidence of subject ${session.subjectId} may back this verification session`,
      );
    }

    // append (dedup) and mark the challenge consumed
    const existing = parseJson<string[]>(session.evidenceAssetIds, []);
    const merged = [...new Set([...existing, ...ids])];
    const challenge = parseJson<LivenessChallenge | null>(session.challenge, null);
    const consumedChallenge = challenge ? { ...challenge, consumedAt: new Date().toISOString() } : null;

    const updated = await db.verificationSession.update({
      where: { id: session.id },
      data: {
        status: 'in_review',
        evidenceAssetIds: JSON.stringify(merged),
        challenge: JSON.stringify(consumedChallenge),
        submittedAt: session.submittedAt ?? new Date(),
      },
    });

    await audit(auth.tenantId, auth, 'verification.session.evidence_submitted', 'verification_session', session.id, {
      addedAssetIds: ids,
      totalAssetIds: merged.length,
      challengeConsumedAt: consumedChallenge?.consumedAt ?? null,
    });
    await emitEvent(auth.tenantId, 'verification.session.evidence_submitted', 'verification_session', session.id, {
      sessionId: session.id,
      addedAssetIds: ids,
      totalAssetIds: merged.length,
    });

    return Response.json(verificationSessionView(updated));
  });
}
