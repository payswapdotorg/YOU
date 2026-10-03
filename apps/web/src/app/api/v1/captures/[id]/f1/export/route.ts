// GET /api/v1/captures/:id/f1/export — the F1 capture export path (P6.B3),
// documented and tested. A portable, honest JSON bundle of everything the
// guided flow recorded for this capture:
//   - the capture record (status, timestamps, covering grant id);
//   - the PERSISTED protocol — the 8 steps with their actual instruction
//     text, per-step state (done / skipped-with-reason) and checkpoints;
//   - the content-addressed evidence manifest (sha256 per asset, verified
//     flags, provenance, deletion policy);
//   - the overall checkpoint summary;
//   - the consent statements the subject agreed to (from the covering grant);
//   - the review verdict + the full acceptance chain when promoted, and the
//     TwinVersion linkage (hash-only — versions are immutable).
// Short-lived signed download URLs are included for the raw evidence bytes
// (the capability scheme IS the access grant — same law as the subject
// export, GET /api/v1/subjects/:id/export). Nothing is invented: absent
// legs render as null/empty with their honest state.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { grantF1Statements, parseF1Protocol, parseF1Review } from '@/lib/you/core/f1-flow';
import { badRequest, handleRoute, notFound } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { signStorageUrl, STORAGE_DEFAULT_TTL_SECONDS } from '@/lib/you/core/storage';
import { parseJson } from '@/lib/you/core/views';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;

    const session = await db.captureSession.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { twin: true, assets: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) throw notFound(`capture session "${id}" not found`);

    const protocol = parseF1Protocol(session);
    if (!protocol) {
      throw badRequest(`capture session "${id}" is not a guided F1 session (no persisted protocol) — use GET /api/v1/subjects/:subjectId/export for the subject-level bundle`);
    }

    const grant = session.consentGrantId
      ? await db.consentGrant.findFirst({ where: { id: session.consentGrantId, tenantId: auth.tenantId } })
      : null;
    const statements = grant ? grantF1Statements(grant) : null;

    const sessionAssetIds = new Set(session.assets.map((a) => a.id));
    const versions = await db.twinVersion.findMany({
      where: { twinId: session.twinId },
      orderBy: { version: 'desc' },
    });
    const linkedVersions = versions.filter((v) =>
      parseJson<string[]>(v.evidenceAssetIds, []).some((aid) => sessionAssetIds.has(aid)),
    );

    const bundle = {
      export: 'f1-capture-export/v1',
      capturedVia: 'f1-guided-flow/v1',
      exportedAt: new Date().toISOString(),
      captureSession: {
        id: session.id,
        twinId: session.twinId,
        twinDisplayName: session.twin.displayName,
        subjectId: session.twin.subjectId,
        status: session.status,
        consentGrantId: session.consentGrantId ?? null,
        createdAt: session.createdAt.toISOString(),
        completedAt: session.completedAt ? session.completedAt.toISOString() : null,
      },
      protocol, // the persisted 8-step protocol with the actual instruction text
      checkpoints: parseJson<Record<string, unknown> | null>(session.checkpoints, null),
      manifest: parseJson<Record<string, unknown> | null>(session.manifest, null),
      consent: statements
        ? {
            grantId: grant?.id ?? null,
            revokedAt: grant?.revokedAt ? grant.revokedAt.toISOString() : null,
            expiresAt: grant?.expiresAt ? grant.expiresAt.toISOString() : null,
            statements,
          }
        : {
            grantId: session.consentGrantId ?? null,
            statements: null,
            note: 'the covering grant no longer resolves — statements unavailable (honest absence, never reconstructed)',
          },
      review: parseF1Review(session),
      twinVersions: linkedVersions.map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status,
        // hash-only: versions are immutable; their provenance is the record
        evidenceAssetIds: parseJson<string[]>(v.evidenceAssetIds, []),
        createdAt: v.createdAt.toISOString(),
      })),
      evidenceAssets: session.assets.map((a) => ({
        id: a.id,
        kind: a.kind,
        mime: a.mime,
        bytes: a.bytes,
        contentHash: a.contentHash,
        regions: parseJson<string[]>(a.regions, []),
        // expiring capability for the raw bytes (same scheme as the subject export)
        downloadUrl: signStorageUrl(a.storageKey),
        downloadUrlExpiresInSeconds: STORAGE_DEFAULT_TTL_SECONDS,
      })),
      scope: 'one guided F1 capture session and everything it recorded',
    };

    await audit(auth.tenantId, auth, 'capture.f1_exported', 'capture_session', session.id, {
      twinId: session.twinId,
      assets: session.assets.length,
      reviewStatus: bundle.review.status,
      linkedVersions: linkedVersions.length,
    });
    await emitEvent(auth.tenantId, 'capture.f1_exported', 'capture_session', session.id, {
      captureSessionId: session.id,
      twinId: session.twinId,
      assets: session.assets.length,
    });

    return Response.json(bundle, {
      headers: {
        'content-disposition': `attachment; filename="you-f1-capture-${session.id}-export.json"`,
        'cache-control': 'no-store',
      },
    });
  });
}
