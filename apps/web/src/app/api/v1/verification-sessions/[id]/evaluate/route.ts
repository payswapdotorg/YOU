// POST /api/v1/verification-sessions/:id/evaluate — deterministic synchronous
// evaluation (A4 finish, docs/API_CONTRACTS.md §Trust). State machine:
//   pending            → 409 (no evidence submitted against the challenge yet)
//   expired            → 409 (lazily transitioned when expiresAt elapsed, so
//                            the durable state never lies about freshness)
//   evaluated          → 409 (the VerificationResult is IMMUTABLE — never
//                            recomputed, never overwritten)
//   in_review          → evaluate now via core evaluateVerification()
// The computation is deterministic and honest per docs/SECURITY_PRIVACY.md
// controls 2–3: ownership confidence only from real machine quality scores;
// identityMatch and visualSimilarity are NEVER claimed (null by contract).
// NOTE on §API rules "mutating requests support Idempotency-Key": this route
// is a state-machine transition, and the contract pins the replay answer — a
// repeat POST on an evaluated session returns 409 (the persisted immutable
// result stays authoritative), so no idempotency-replay shortcut is taken.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { conflict, handleRoute, notFound } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { evaluateVerification, verificationSessionView } from '@/lib/you/core/verification';
import { parseJson } from '@/lib/you/core/views';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;

    const session = await db.verificationSession.findFirst({ where: { id, tenantId: auth.tenantId } });
    if (!session) throw notFound(`verification session "${id}" not found`);

    if (session.status === 'evaluated') {
      throw conflict(
        `verification session "${id}" is already evaluated (at ${session.evaluatedAt?.toISOString() ?? 'unknown time'}) — the verification result is immutable and is never recomputed`,
      );
    }
    if (session.status === 'expired') {
      throw conflict(`verification session "${id}" expired at ${session.expiresAt.toISOString()} — start a new session`);
    }
    if (session.status === 'pending') {
      throw conflict(
        `verification session "${id}" is still pending — submit evidence against the liveness challenge (POST /api/v1/verification-sessions/${id}/evidence) before evaluating`,
      );
    }
    // remaining legal state: in_review
    if (session.expiresAt.getTime() <= Date.now()) {
      const expired = await db.verificationSession.update({
        where: { id: session.id },
        data: { status: 'expired' },
      });
      throw conflict(`verification session "${id}" expired at ${expired.expiresAt.toISOString()} — start a new session`);
    }

    // load the submitted evidence in the session's stored (submission) order —
    // deterministic result shape; tenant filter is defense in depth (assets
    // were already tenant+subject validated at submission time)
    const assetIds = parseJson<string[]>(session.evidenceAssetIds, []);
    const found = assetIds.length
      ? await db.evidenceAsset.findMany({ where: { id: { in: assetIds }, tenantId: auth.tenantId } })
      : [];
    const byId = new Map(found.map((a) => [a.id, a]));
    const assets = assetIds.map((aid) => byId.get(aid)).filter((a) => a !== undefined);

    const result = evaluateVerification(session, assets);

    const updated = await db.verificationSession.update({
      where: { id: session.id },
      data: {
        status: 'evaluated',
        result: JSON.stringify(result),
        evaluatedAt: new Date(result.evaluatedAt),
      },
    });

    await audit(auth.tenantId, auth, 'verification.session.evaluated', 'verification_session', session.id, {
      subjectId: session.subjectId,
      twinId: session.twinId,
      outcome: result.outcome,
      livenessStatus: result.liveness.status,
      onTime: result.liveness.onTime,
      coveredRegions: result.liveness.coveredRegions,
      missingRegions: result.liveness.missingRegions,
      ownershipConfidence: result.ownershipConfidence,
      identityMatch: result.identityMatch,
      visualSimilarity: result.visualSimilarity,
      evidenceAssetIds: result.evidenceAssetIds,
      submittedAt: session.submittedAt?.toISOString() ?? null,
    });
    await emitEvent(auth.tenantId, 'verification.session.evaluated', 'verification_session', session.id, {
      sessionId: session.id,
      subjectId: session.subjectId,
      twinId: session.twinId,
      outcome: result.outcome,
      livenessStatus: result.liveness.status,
      ownershipConfidence: result.ownershipConfidence,
      evidenceAssetIds: result.evidenceAssetIds,
    });

    return Response.json(verificationSessionView(updated));
  });
}
