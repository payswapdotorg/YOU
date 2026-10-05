// GET /api/v1/overview — dashboard aggregate (counts, recent events, pipeline)
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute } from '@/lib/you/core/errors';
import { eventView } from '@/lib/you/core/views';
import type { OverviewStats } from '@/lib/you/contracts';

export async function GET(request: Request): Promise<Response> {
  // P6.C12: observed under the declared 'api.read' SLO (docs/COST_LATENCY.md).
  const observedRoute = (fn: () => Promise<Response>) => handleRoute(fn, { request, slo: 'api.read' });
  return observedRoute(async () => {
    const auth = await requireApiAuth(request);
    const tenantId = auth.tenantId;
    const now = new Date();

    const [
      twins, twinsReady, captures, evidenceAssets, versions, renders,
      activeGrants, openEvidenceRequests, labRuns, recentEventRows,
      draftTwins, activeCaptures, reconstructedTwins, performances, activeRenders, solutions,
    ] = await Promise.all([
      db.twin.count({ where: { tenantId } }),
      db.twin.count({ where: { tenantId, status: 'ready' } }),
      db.captureSession.count({ where: { tenantId } }),
      db.evidenceAsset.count({ where: { tenantId } }),
      db.twinVersion.count({ where: { twin: { tenantId } } }),
      db.renderJob.count({ where: { tenantId } }),
      db.consentGrant.count({ where: { tenantId, revokedAt: null, expiresAt: { gt: now } } }),
      db.evidenceRequest.count({ where: { tenantId, status: 'open' } }),
      db.benchmarkRun.count(), // lab plane is research-scoped, not tenant-scoped
      db.eventRecord.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 12,
      }),
      db.twin.count({ where: { tenantId, status: 'draft' } }),
      db.captureSession.count({ where: { tenantId, status: { in: ['pending', 'uploading', 'analyzing'] } } }),
      db.twin.count({ where: { tenantId, status: 'reconstructed' } }),
      db.performance.count({ where: { tenantId } }),
      db.renderJob.count({ where: { tenantId, status: { in: ['queued', 'running'] } } }),
      db.solutionArtifact.count({ where: { tenantId } }),
    ]);

    const overview: OverviewStats = {
      twins,
      twinsReady,
      captures,
      evidenceAssets,
      versions,
      renders,
      activeGrants,
      openEvidenceRequests,
      labRuns,
      recentEvents: recentEventRows.map(eventView),
      pipeline: [
        { stage: 'Create Twin', count: draftTwins, hint: 'Draft twins awaiting first capture' },
        { stage: 'Capture', count: activeCaptures, hint: 'Capture sessions in progress' },
        { stage: 'Reconstruct', count: reconstructedTwins, hint: 'Reconstructed, pending readiness review' },
        { stage: 'Perform', count: performances, hint: 'Performance streams (text, audio, video, motion)' },
        { stage: 'Render', count: activeRenders, hint: 'Render jobs in flight' },
        { stage: 'Artifact', count: solutions, hint: 'Portable solution artifacts' },
      ],
    };

    return Response.json(overview);
  });
}
