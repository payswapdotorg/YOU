// GET /api/v1/metrics — resilience metrics surface (P6.A6-FULL).
//
// ADMIN-GATED (operator session only, exactly like the maintenance routes:
// api keys are refused — actorType must be 'user').
//
// Exposes the honest resilience picture:
//   counters — in-process retry/dead-letter/rate-limit counters (per provider,
//              per job kind, per bucket; process-local, labeled as such)
//   breakers — circuit-breaker state per provider (zai / openrouter)
//   deadJobs — tenant-scoped dead-job count + oldest dead job + retention
//   jobs     — tenant-scoped job counts by status (dead included)
//
// Scope honesty: counters and breakers are PROCESS-LOCAL (single-instance
// truth); db counts are tenant-scoped to the operator's tenant (isolation
// law). No secrets, no payloads, no cross-tenant data.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, forbidden } from '@/lib/you/core/errors';
import { counterSnapshot } from '@/lib/you/core/metrics';
import { breakerSnapshot } from '@/lib/you/core/circuit-breaker';
import { deadJobRetentionDays } from '@/lib/you/core/deadletter';

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    if (auth.actorType !== 'user') {
      throw forbidden('metrics require an operator session (api keys are not permitted)');
    }

    const [oldestDead, jobsByStatus] = await Promise.all([
      db.job.findFirst({
        where: { tenantId: auth.tenantId, status: 'dead' },
        orderBy: { finishedAt: 'asc' },
        select: { id: true, kind: true, finishedAt: true },
      }),
      db.job.groupBy({
        by: ['status'],
        where: { tenantId: auth.tenantId },
        _count: { _all: true },
      }),
    ]);
    const deadCount = jobsByStatus.find((s) => s.status === 'dead')?._count._all ?? 0;

    const jobs: Record<string, number> = {};
    for (const row of jobsByStatus) jobs[row.status] = row._count._all;

    return Response.json(
      {
        scope: {
          tenantId: auth.tenantId,
          processUptimeSeconds: Math.round(process.uptime()),
          countersAndBreakers: 'process-local (single instance) — multi-instance deployments aggregate at the collector',
          jobCounts: 'tenant-scoped database truth',
        },
        counters: counterSnapshot(),
        breakers: breakerSnapshot(),
        deadJobs: {
          count: deadCount,
          oldest: oldestDead
            ? { id: oldestDead.id, kind: oldestDead.kind, finishedAt: oldestDead.finishedAt?.toISOString() ?? null }
            : null,
          retentionDays: deadJobRetentionDays(),
          inspection: 'GET /api/v1/maintenance/dead-jobs (list), POST {action:"replay"|"purge"}',
        },
        jobs,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  });
}
