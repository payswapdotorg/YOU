// GET /api/v1/exports/:id — export job detail + the artifact bundle when
// complete (P6.C9). The artifact view carries the GLB/VRM binary reference
// (signed expiring URL), the machine-readable retargeting mapping table and
// the structural-vs-derived manifest (both as companion artifact references
// with signed URLs), the honest Unity/Unreal package manifest, and the
// verbatim honest-claims text (contract field; a mismatched claims statement
// refuses honestly with a 500, never a fabricated one).
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, notFound } from '@/lib/you/core/errors';
import { parseJson } from '@/lib/you/core/views';
import { exportArtifactView, exportJobSummaryView, type ExportArtifactView } from '@/lib/you/export/views';
import type { ExportManifest } from '@/lib/you/adapters/game-export';
import type { OutputArtifact } from '@prisma/client';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;

    const row = await db.exportJob.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { twin: true },
    });
    if (!row) throw notFound(`export job "${id}" not found`);

    let artifact: ExportArtifactView | null = null;
    let manifest: ExportManifest | null = null;
    if (row.artifactId) {
      const primary = await db.outputArtifact.findFirst({
        where: { id: row.artifactId, tenantId: auth.tenantId },
      });
      if (primary) {
        const meta = parseJson<{ manifest?: unknown; companionArtifacts?: unknown }>(primary.meta, {});
        const parsedManifest = meta.manifest ?? null;
        if (parsedManifest) manifest = parsedManifest as ExportManifest;
        // companion artifacts (mapping table + export manifest) — loaded by
        // the refs recorded on the primary artifact's meta at persist time
        const companionsMeta = Array.isArray(meta.companionArtifacts)
          ? (meta.companionArtifacts as Array<Record<string, unknown>>)
          : [];
        const companions: Array<{ role: 'retargeting-mapping' | 'export-manifest'; artifact: OutputArtifact }> = [];
        for (const c of companionsMeta) {
          const role = typeof c.role === 'string' ? c.role : '';
          const artifactId = typeof c.artifactId === 'string' ? c.artifactId : '';
          if ((role === 'retargeting-mapping' || role === 'export-manifest') && artifactId) {
            const companion = await db.outputArtifact.findFirst({
              where: { id: artifactId, tenantId: auth.tenantId },
            });
            if (companion) companions.push({ role, artifact: companion });
          }
        }
        const format = row.format === 'vrm' ? 'vrm' : 'glb';
        artifact = exportArtifactView(primary, { format, lodLevel: row.lodLevel, companions });
      }
    }

    const view = exportJobSummaryView({
      job: row,
      twinDisplayName: row.twin?.displayName ?? null,
      manifest,
    });
    return Response.json({ ...view, artifact });
  });
}
