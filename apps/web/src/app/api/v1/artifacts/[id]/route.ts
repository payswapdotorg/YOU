// GET /api/v1/artifacts/:id — SolutionArtifactView. The stored manifest is
// the portable record; expiring signed URLs inside artifacts[]/evidence[]
// are REFRESHED at read time via signStorageUrl (looked up from
// OutputArtifact / EvidenceAsset rows by id).
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, notFound } from '@/lib/you/core/errors';
import { solutionArtifactView } from '@/lib/you/core/views';
import { signStorageUrl } from '@/lib/you/core/storage';
import type { SolutionArtifactManifest } from '@/lib/you/contracts';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;

    const solution = await db.solutionArtifact.findFirst({ where: { id, tenantId: auth.tenantId } });
    if (!solution) throw notFound(`solution artifact "${id}" not found`);

    const view = solutionArtifactView(solution);
    const manifest: SolutionArtifactManifest = view.manifest;

    if (manifest && Array.isArray(manifest.artifacts)) {
      const refreshed = await Promise.all(
        manifest.artifacts.map(async (entry) => {
          const artifact = await db.outputArtifact.findFirst({
            where: { id: entry.artifactId, tenantId: auth.tenantId },
          });
          return artifact ? { ...entry, url: signStorageUrl(artifact.storageKey) } : entry;
        }),
      );
      manifest.artifacts = refreshed;
    }

    if (manifest && Array.isArray(manifest.evidence)) {
      const refreshed = await Promise.all(
        manifest.evidence.map(async (entry) => {
          const asset = await db.evidenceAsset.findFirst({
            where: { id: entry.assetId, tenantId: auth.tenantId },
          });
          return asset ? { ...entry, url: signStorageUrl(asset.storageKey) } : entry;
        }),
      );
      manifest.evidence = refreshed;
    }

    view.manifest = manifest;
    return Response.json(view);
  });
}
