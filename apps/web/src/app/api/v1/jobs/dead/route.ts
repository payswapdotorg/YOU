// GET /api/v1/jobs/dead — P6.A6 dead-letter inspection (admin-gated).
//
// Lists this tenant's dead jobs (retryable errors exhausted the bounded
// attempts) with their structured deadLetter payload, newest death first.
// RETENTION POLICY (documented, env-tunable): dead jobs are pruned lazily on
// inspection once older than YOU_DEAD_JOB_RETENTION_DAYS (default 30) after
// deadAt — the sweep runs here, reports the pruned count in the response.
// Replay: POST /api/v1/jobs/dead/:id/replay.
//
// Admin gate = the maintenance precedent: operator SESSION only; API keys
// are refused (403).
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { forbidden, handleRoute } from '@/lib/you/core/errors';
import { deadJobRetentionDays, pruneDeadJobs } from '@/lib/you/core/jobs';
import { deadJobView } from '@/lib/you/core/views';

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    if (auth.actorType !== 'user') {
      // dead-letter inspection is an operator action — session auth only
      throw forbidden('dead-letter inspection requires an operator session (api keys are not permitted)');
    }

    // documented retention sweep (lazy on inspection)
    const pruned = await pruneDeadJobs();

    const dead = await db.job.findMany({
      where: { tenantId: auth.tenantId, status: 'dead' },
      orderBy: { deadAt: 'desc' },
      take: 100,
    });

    return Response.json({
      jobs: dead.map(deadJobView),
      retentionDays: deadJobRetentionDays(),
      prunedNow: pruned,
    });
  });
}
