// POST /api/v1/captures/:id/f1/review — the review step of the F1 acceptance
// chain (P6.B3): capture → consent → liveness → quality → reconstruction →
// TwinVersion → REVIEW → deletion/export.
//
// APPROVE promotes the capture to its TwinVersion LINKAGE: the TwinVersion
// reconstructed from this capture's evidence (matched via its persisted
// evidenceAssetIds) is recorded on the capture together with the full
// acceptance chain (provenance: covering consent grant + statements, the
// persisted protocol with skipped-required disclosures, checkpoint summary,
// reconstruction reference, review verdict). A still-DRAFT version is
// published by the promotion (draft → published); an already-published
// version is linked untouched — historical TwinVersions are immutable.
// REJECT records the verdict + note without linkage (the evidence quality
// concern travels with the capture; versions stay immutable either way).
//
// Honest refusals: not a guided session (400), not complete (409), already
// reviewed (409), no reconstructed TwinVersion to link (409 with guidance).
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import {
  buildF1AcceptanceChain, grantF1Statements, parseF1Protocol, parseF1Review,
} from '@/lib/you/core/f1-flow';
import { badRequest, conflict, handleRoute, notFound, optString, readJsonBody } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { captureSessionView, parseJson } from '@/lib/you/core/views';
import type { F1ReviewState, HTIR } from '@/lib/you/contracts';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;

    const body = await readJsonBody(request);
    const verdict = body.verdict;
    if (verdict !== 'approve' && verdict !== 'reject') {
      throw badRequest('field "verdict" must be "approve" or "reject"');
    }
    const note = optString(body, 'note', { max: 400 });

    const session = await db.captureSession.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { twin: true, assets: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) throw notFound(`capture session "${id}" not found`);

    const protocol = parseF1Protocol(session);
    if (!protocol) {
      throw badRequest(`capture session "${id}" is not a guided F1 session (no persisted protocol)`);
    }
    if (session.status !== 'complete') {
      throw conflict(
        `capture session "${id}" status is "${session.status}" — review runs on a COMPLETE session (POST /api/v1/captures/${id}/f1/complete first)`,
        { captureSessionId: session.id, status: session.status, requiredStatus: 'complete' },
      );
    }
    const existingReview = parseF1Review(session);
    if (existingReview.status !== 'none') {
      throw conflict(
        `capture session "${id}" was already reviewed (${existingReview.status}${existingReview.twinVersionId ? ` → TwinVersion ${existingReview.twinVersionId}` : ''}) at ${existingReview.decidedAt ?? 'unknown time'} — the review is immutable`,
        { captureSessionId: session.id, review: existingReview },
      );
    }

    // the covering grant carries the statements the subject actually consented
    // to — historical record for the chain even if revoked since completion
    const grant = session.consentGrantId
      ? await db.consentGrant.findFirst({ where: { id: session.consentGrantId, tenantId: auth.tenantId } })
      : null;
    const statements = grant ? grantF1Statements(grant) : null;

    const decidedAt = new Date().toISOString();

    // ── APPROVE: promote to the TwinVersion linkage ─────────────────────────
    if (verdict === 'approve') {
      const sessionAssetIds = new Set(session.assets.map((a) => a.id));
      const versions = await db.twinVersion.findMany({
        where: { twinId: session.twinId },
        orderBy: { version: 'desc' },
      });
      const linked = versions.find((v) =>
        parseJson<string[]>(v.evidenceAssetIds, []).some((aid) => sessionAssetIds.has(aid)),
      );
      if (!linked) {
        throw conflict(
          `no TwinVersion reconstructed from capture session "${id}" yet — run reconstruction first (POST /api/v1/captures/${id}/reconstruct, or POST /api/v1/twins/${session.twinId}/compile with captureSessionId) and then approve the review`,
          {
            captureSessionId: session.id,
            hint: 'the F1 acceptance chain is capture → … → reconstruction → TwinVersion → review; the review links the version that used this evidence',
          },
        );
      }

      const htir = parseJson<HTIR>(linked.htir, {} as HTIR);
      if (linked.status === 'draft') {
        await db.twinVersion.update({
          where: { id: linked.id },
          data: { status: 'published' },
        });
      }

      const review: F1ReviewState = {
        status: 'promoted',
        verdict,
        ...(note ? { note } : {}),
        reviewerActorType: auth.actorType,
        reviewerActorId: auth.actorId,
        decidedAt,
        twinVersionId: linked.id,
        twinVersionNumber: linked.version,
      };
      // per-ASSET checkpoint accounting from the persisted manifest (honest:
      // a failed submission's report is never overwritten by a retry)
      const manifest = parseJson<{ assets?: { checkpointPassed?: boolean | null }[] } | null>(session.manifest, null);
      const manifestAssets = manifest?.assets ?? [];
      const assetCheckpoints = {
        checked: manifestAssets.filter((a) => a.checkpointPassed !== null && a.checkpointPassed !== undefined).length,
        failed: manifestAssets.filter((a) => a.checkpointPassed === false).length,
      };
      const chain = statements && grant
        ? buildF1AcceptanceChain({
            session,
            protocol,
            statements,
            grantId: grant.id,
            assetCheckpoints,
            twinVersion: {
              id: linked.id,
              version: linked.version,
              compiledBy: htir?.provenance?.compiledBy,
              pipelineId: linked.pipelineId,
            },
            review: { verdict, ...(note ? { note } : {}), decidedAt },
          })
        : undefined;

      await db.captureSession.update({
        where: { id: session.id },
        data: { review: JSON.stringify(chain ? { ...review, chain } : review) },
      });

      await audit(auth.tenantId, auth, 'capture.f1_reviewed', 'capture_session', session.id, {
        verdict,
        twinVersionId: linked.id,
        twinVersionStatusBefore: linked.status,
        reviewerActorId: auth.actorId,
        ...(note ? { note } : {}),
      });
      await emitEvent(auth.tenantId, 'capture.f1_promoted', 'capture_session', session.id, {
        captureSessionId: session.id,
        twinId: session.twinId,
        twinVersionId: linked.id,
        version: linked.version,
        verdict,
      });

      const refreshed = await db.captureSession.findUnique({
        where: { id: session.id },
        include: { assets: { orderBy: { createdAt: 'asc' } } },
      });
      return Response.json({
        ...captureSessionView(refreshed ?? session, refreshed?.assets ?? session.assets),
        review: chain ? { ...review, chain } : review,
      });
    }

    // ── REJECT: record the verdict, no linkage ──────────────────────────────
    const review: F1ReviewState = {
      status: 'rejected',
      verdict,
      ...(note ? { note } : {}),
      reviewerActorType: auth.actorType,
      reviewerActorId: auth.actorId,
      decidedAt,
    };
    await db.captureSession.update({
      where: { id: session.id },
      data: { review: JSON.stringify(review) },
    });

    await audit(auth.tenantId, auth, 'capture.f1_reviewed', 'capture_session', session.id, {
      verdict,
      reviewerActorId: auth.actorId,
      ...(note ? { note } : {}),
    });
    await emitEvent(auth.tenantId, 'capture.f1_rejected', 'capture_session', session.id, {
      captureSessionId: session.id,
      twinId: session.twinId,
      verdict,
    });

    const refreshed = await db.captureSession.findUnique({
      where: { id: session.id },
      include: { assets: { orderBy: { createdAt: 'asc' } } },
    });
    return Response.json({
      ...captureSessionView(refreshed ?? session, refreshed?.assets ?? session.assets),
      review,
    });
  });
}
