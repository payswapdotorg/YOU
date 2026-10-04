// GET /api/v1/artifacts/:id — SolutionArtifactView. The stored manifest is
// the portable record; expiring signed URLs inside artifacts[]/evidence[]
// are REFRESHED at read time via signStorageUrl (looked up from
// OutputArtifact / EvidenceAsset rows by id).
//
// P6.B6 — LIVE SECTION ENRICHMENT (read-time only; the stored manifest is
// never rewritten): the feedback / evidenceRequests / improve sections
// accrue AFTER creation, so the detail route merges the live rows into the
// returned view —
//   feedback:       FeedbackRequests linked to THIS artifact (newest first)
//   evidenceRequests + improve: targeted requests referencing the artifact's
//                   TwinVersion, their fulfillment capture sessions, and
//                   follow-up versions linked by REAL evidence-asset overlap
//                   (never timestamps alone).
// Legacy v1 manifests (no sections key) skip enrichment — the UI degrades
// honestly instead of inventing a section surface.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, notFound } from '@/lib/you/core/errors';
import { solutionArtifactView, feedbackRequestView, evidenceRequestView } from '@/lib/you/core/views';
import { signStorageUrl } from '@/lib/you/core/storage';
import { enrichSectionsLive, linkFollowUpVersions } from '@/lib/you/core/artifact-sections';
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

    // ── P6.B6 live section enrichment (v2 manifests only) ───────────────────
    if (manifest && manifest.sections) {
      const feedbackRows = await db.feedbackRequest.findMany({
        where: { solutionArtifactId: solution.id, tenantId: auth.tenantId },
        orderBy: { createdAt: 'desc' },
      });

      let evidenceRequestViews = [] as ReturnType<typeof evidenceRequestView>[];
      let followUpVersions: ReturnType<typeof linkFollowUpVersions> = [];
      const twinVersionRef = manifest.twinVersion ?? null;
      if (twinVersionRef) {
        // requests targeting THIS artifact's TwinVersion (chronological)
        const requestRows = await db.evidenceRequest.findMany({
          where: { twinVersionId: twinVersionRef.id, tenantId: auth.tenantId },
          orderBy: { createdAt: 'asc' },
        });
        evidenceRequestViews = requestRows.map(evidenceRequestView);

        // follow-up versions of the same twin (newer than this one)
        const currentVersionRow = await db.twinVersion.findFirst({
          where: { id: twinVersionRef.id, twin: { tenantId: auth.tenantId } },
        });
        if (currentVersionRow) {
          const newerVersions = await db.twinVersion.findMany({
            where: { twinId: currentVersionRow.twinId, version: { gt: currentVersionRow.version } },
            orderBy: { version: 'asc' },
          });
          // their artifacts (the twin-review of each version, when one exists)
          const versionIds = newerVersions.map((v) => v.id);
          const newerSolutions = versionIds.length
            ? await db.solutionArtifact.findMany({
                where: { tenantId: auth.tenantId, twinVersionId: { in: versionIds }, type: 'twin-review' },
                orderBy: { createdAt: 'desc' },
              })
            : [];
          const artifactByVersion = new Map<string, string>();
          for (const s of newerSolutions) {
            if (s.twinVersionId && !artifactByVersion.has(s.twinVersionId)) {
              artifactByVersion.set(s.twinVersionId, s.id);
            }
          }
          // the fulfillment sessions' evidence assets (for causal linking)
          const sessionIds = [
            ...new Set(requestRows.map((r) => r.captureSessionId).filter((s): s is string => !!s)),
          ];
          const sessionAssets: Record<string, string[]> = {};
          if (sessionIds.length) {
            const sessionAssetRows = await db.evidenceAsset.findMany({
              where: { captureSessionId: { in: sessionIds }, tenantId: auth.tenantId },
            });
            for (const a of sessionAssetRows) {
              (sessionAssets[a.captureSessionId] ??= []).push(a.id);
            }
          }
          followUpVersions = linkFollowUpVersions({
            requests: requestRows.map((r) => ({
              requestId: r.id,
              captureSessionId: r.captureSessionId ?? null,
            })),
            sessionAssets,
            versions: newerVersions.map((v) => ({
              twinVersionId: v.id,
              version: v.version,
              evidenceAssetIds: JSON.parse(v.evidenceAssetIds || '[]') as string[],
              artifactId: artifactByVersion.get(v.id) ?? null,
            })),
          });
        }
      }

      manifest.sections = enrichSectionsLive(manifest.sections, {
        feedbackRequests: feedbackRows.map(feedbackRequestView),
        evidenceRequests: evidenceRequestViews,
        followUpVersions,
        capabilities: manifest.evidence_request_schema?.capabilities ?? [],
      });
    }

    view.manifest = manifest;
    return Response.json(view);
  });
}
