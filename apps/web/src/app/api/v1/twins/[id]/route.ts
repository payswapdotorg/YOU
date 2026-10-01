// GET /api/v1/twins/:id — twin with versions (parsed HTIR) + captures
// DELETE /api/v1/twins/:id — cascade delete + audit (evidence bytes in the
// object store are content-addressed and intentionally retained).
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, notFound } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { captureSessionView, twinView, twinVersionView } from '@/lib/you/core/views';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const twin = await db.twin.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: {
        versions: { orderBy: { version: 'desc' } },
        captureSessions: { orderBy: { createdAt: 'desc' }, include: { assets: true } },
      },
    });
    if (!twin) throw notFound(`twin "${id}" not found`);

    return Response.json({
      ...twinView(twin),
      versions: twin.versions.map(twinVersionView),
      captures: twin.captureSessions.map((c) => captureSessionView(c, c.assets)),
    });
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const twin = await db.twin.findFirst({ where: { id, tenantId: auth.tenantId } });
    if (!twin) throw notFound(`twin "${id}" not found`);

    await audit(auth.tenantId, auth, 'twin.deleted', 'twin', twin.id, {
      displayName: twin.displayName,
      subjectId: twin.subjectId,
      currentVersion: twin.currentVersion,
    });

    // cascade: FK order matters on SQLite
    const versionIds = await db.twinVersion.findMany({ where: { twinId: twin.id }, select: { id: true } });
    const captureIds = await db.captureSession.findMany({ where: { twinId: twin.id }, select: { id: true } });
    const renderIds = await db.renderJob.findMany({ where: { twinId: twin.id }, select: { id: true } });
    await db.agentAvatarSession.deleteMany({ where: { twinId: twin.id } });
    await db.solutionArtifact.deleteMany({
      where: { OR: [{ twinVersionId: { in: versionIds.map((v) => v.id) } }, { renderJobId: { in: renderIds.map((r) => r.id) } }] },
    });
    await db.renderJob.deleteMany({ where: { twinId: twin.id } });
    await db.evidenceRequest.deleteMany({
      where: { OR: [{ twinVersionId: { in: versionIds.map((v) => v.id) } }, { captureSessionId: { in: captureIds.map((c) => c.id) } }] },
    });
    await db.feedbackRequest.deleteMany({ where: { twinVersionId: { in: versionIds.map((v) => v.id) } } });
    await db.representation.deleteMany({ where: { twinVersionId: { in: versionIds.map((v) => v.id) } } });
    await db.twinVersion.deleteMany({ where: { twinId: twin.id } });
    await db.evidenceAsset.deleteMany({ where: { captureSessionId: { in: captureIds.map((c) => c.id) } } });
    await db.captureSession.deleteMany({ where: { twinId: twin.id } });
    await db.performance.deleteMany({ where: { twinId: twin.id } });
    await db.twin.delete({ where: { id: twin.id } });

    await emitEvent(auth.tenantId, 'twin.deleted', 'twin', twin.id, {
      twinId: twin.id,
      displayName: twin.displayName,
    });

    return new Response(null, { status: 204 });
  });
}
