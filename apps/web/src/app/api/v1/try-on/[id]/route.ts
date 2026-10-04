// GET /api/v1/try-on/:id — try-on job detail + the comparison artifact when
// complete (P6.C8). The comparison view carries the side-by-side refs
// (baseline | try-on output | garment identity reference — signed expiring
// URLs), the diff manifest, the identity-preservation report and the
// visual-only disclaimer (contract field; a mismatched disclaimer refuses
// honestly with a 500, never a fabricated one).
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, notFound } from '@/lib/you/core/errors';
import { parseJson } from '@/lib/you/core/views';
import { tryOnComparisonView, tryOnJobSummaryView, type TryOnComparisonView } from '@/lib/you/tryon/views';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;

    const row = await db.tryOnJob.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { twin: true, garmentAsset: true },
    });
    if (!row) throw notFound(`try-on job "${id}" not found`);

    let identityChecksPassed: boolean | null = null;
    let comparison: TryOnComparisonView | null = null;
    if (row.artifactId) {
      const artifact = await db.outputArtifact.findFirst({
        where: { id: row.artifactId, tenantId: auth.tenantId },
      });
      if (artifact) {
        const report = parseJson<{ identityReport?: { checksPassed?: unknown } }>(artifact.meta, {}).identityReport;
        if (report && typeof report.checksPassed === 'boolean') identityChecksPassed = report.checksPassed;
        comparison = tryOnComparisonView(artifact);
      }
    }

    const view = tryOnJobSummaryView({
      job: row,
      twinDisplayName: row.twin?.displayName ?? null,
      garmentDisplayName: row.garmentAsset?.displayName ?? null,
      productRef: row.garmentAsset?.productRef ?? null,
      identityChecksPassed,
    });
    return Response.json({ ...view, comparison });
  });
}
