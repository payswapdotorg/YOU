// GET /api/v1/subjects/:id/export — subject data export (P6.A4 export leg).
//
// GDPR-style portable export for a consent subject: every row this platform
// holds about `subjectId`, plus short-lived signed URLs for the raw evidence
// bytes (the capability scheme IS the access grant — the export contains no
// secrets, only expiring capabilities). Honest scope: the bundle lists what
// EXISTS; nothing is invented, nothing is omitted from the queried models.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { signStorageUrl, STORAGE_DEFAULT_TTL_SECONDS } from '@/lib/you/core/storage';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id: subjectId } = await params;

    const twins = await db.twin.findMany({ where: { tenantId: auth.tenantId, subjectId } });
    const twinIds = twins.map((t) => t.id);

    const versions = twinIds.length
      ? await db.twinVersion.findMany({ where: { twinId: { in: twinIds } } })
      : [];

    const captures = twinIds.length
      ? await db.captureSession.findMany({ where: { twinId: { in: twinIds } } })
      : [];
    const captureIds = captures.map((c) => c.id);

    const assets = captureIds.length
      ? await db.evidenceAsset.findMany({ where: { captureSessionId: { in: captureIds } } })
      : [];

    const consentGrants = await db.consentGrant.findMany({
      where: { tenantId: auth.tenantId, subjectId },
    });

    const verificationSessions = await db.verificationSession.findMany({
      where: { tenantId: auth.tenantId, subjectId },
    });

    // evidence requests hang off versions/captures (no direct subjectId)
    const evidenceRequests = await db.evidenceRequest.findMany({
      where: {
        tenantId: auth.tenantId,
        OR: [
          ...(versions.length ? [{ twinVersionId: { in: versions.map((v) => v.id) } }] : []),
          ...(captureIds.length ? [{ captureSessionId: { in: captureIds } }] : []),
        ],
      },
    });

    const bundle = {
      subjectId,
      exportedAt: new Date().toISOString(),
      scope: 'all rows held for this subject under this tenant',
      twins: twins.map((t) => ({
        id: t.id,
        displayName: t.displayName,
        personName: t.personName,
        status: t.status,
        currentVersion: t.currentVersion,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
      twinVersions: versions.map((v) => ({
        id: v.id,
        twinId: v.twinId,
        version: v.version,
        createdAt: v.createdAt,
        htir: v.htir,
      })),
      captureSessions: captures.map((c) => ({
        id: c.id,
        twinId: c.twinId,
        status: c.status,
        checklist: c.checklist,
        createdAt: c.createdAt,
      })),
      evidenceAssets: assets.map((a) => ({
        id: a.id,
        captureSessionId: a.captureSessionId,
        kind: a.kind,
        mime: a.mime,
        bytes: a.bytes,
        contentHash: a.contentHash,
        regions: a.regions,
        quality: a.quality,
        createdAt: a.createdAt,
        // expiring capability for the raw bytes — the export grants access,
        // it does not embed the media (bundle stays portable + secret-free)
        downloadUrl: signStorageUrl(a.storageKey),
        downloadUrlExpiresInSeconds: STORAGE_DEFAULT_TTL_SECONDS,
      })),
      consentGrants: consentGrants.map((g) => ({
        id: g.id,
        purpose: g.purpose,
        scopes: g.scopes,
        operations: g.operations,
        outputs: g.outputs,
        createdAt: g.createdAt,
        expiresAt: g.expiresAt,
        revokedAt: g.revokedAt,
      })),
      verificationSessions: verificationSessions.map((v) => ({
        id: v.id,
        purpose: v.purpose,
        method: v.method,
        status: v.status,
        result: v.result,
        createdAt: v.createdAt,
      })),
      evidenceRequests: evidenceRequests.map((r) => ({
        id: r.id,
        // P6.A6-FULL tsc fix: EvidenceRequest carries `capability` (schema), not
        // `regions` — the old key read a non-existent column (undefined).
        capability: r.capability,
        status: r.status,
        createdAt: r.createdAt,
      })),
    };

    await audit(auth.tenantId, auth, 'subject.exported', 'subject', subjectId, {
      twins: twins.length,
      evidenceAssets: assets.length,
      consentGrants: consentGrants.length,
      verificationSessions: verificationSessions.length,
    });
    await emitEvent(auth.tenantId, 'subject.exported', 'subject', subjectId, { subjectId });

    return Response.json(bundle, {
      headers: { 'content-disposition': `attachment; filename="you-subject-${subjectId}-export.json"` },
    });
  });
}
