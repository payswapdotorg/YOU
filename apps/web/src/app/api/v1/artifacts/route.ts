// GET /api/v1/artifacts — list SolutionArtifacts (newest first) with optional
// exact-match filters: ?twinVersionId= &renderJobId= &type= &performanceId=.
// P6.B6: the performanceId filter matches the manifest's performance slot
// (render-reviews driven by a performance and performance-review artifacts
// alike) — SolutionArtifact has no performance column, so the match happens
// on the parsed manifest (honest post-filter, tenant-scoped rows only).
// The list returns STORED manifests; live section enrichment happens only on
// the [id] detail route.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { badRequest, handleRoute } from '@/lib/you/core/errors';
import { solutionArtifactView } from '@/lib/you/core/views';
import type { SolutionArtifactManifest } from '@/lib/you/contracts';

const ARTIFACT_TYPES = [
  'twin-review', 'render-review', 'benchmark-report', 'avatar-session', 'performance-review',
] as const;

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const url = new URL(request.url);

    const twinVersionId = url.searchParams.get('twinVersionId')?.trim() || undefined;
    const renderJobId = url.searchParams.get('renderJobId')?.trim() || undefined;
    const type = url.searchParams.get('type')?.trim() || undefined;
    const performanceId = url.searchParams.get('performanceId')?.trim() || undefined;

    if (type && !(ARTIFACT_TYPES as readonly string[]).includes(type)) {
      throw badRequest(`type filter must be one of ${ARTIFACT_TYPES.join(' | ')}`);
    }

    const rows = await db.solutionArtifact.findMany({
      where: {
        tenantId: auth.tenantId,
        ...(twinVersionId ? { twinVersionId } : {}),
        ...(renderJobId ? { renderJobId } : {}),
        ...(type ? { type } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });

    const views = rows
      .map(solutionArtifactView)
      .filter((v): v is ReturnType<typeof solutionArtifactView> => {
        if (!performanceId) return true;
        const m = v.manifest as Partial<SolutionArtifactManifest>;
        return m?.performance?.id === performanceId;
      });

    return Response.json(views);
  });
}
