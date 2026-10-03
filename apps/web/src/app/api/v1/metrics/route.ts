// GET /api/v1/metrics — P6.A6 minimal metrics surface (admin-gated).
//
// Exposes the resilience counters an operator needs:
//   counters                     — retries / retry.<label> / exhausted, dead
//                                 jobs, breaker transitions + rejections,
//                                 rate-limit hits, webhook outcomes
//   breakers                     — per-provider circuit state (zai/openrouter)
//   jobs                          — dead-letter inventory + retention policy
//
// Admin gate = the maintenance precedent (POST /maintenance/gc-storage):
// operator SESSION only — API keys are refused (403), even with read scope.
// Metrics are process-wide (counters/breakers are per server instance — the
// same disclosed limitation as the interim rate limiter) and tenanted only
// where the underlying rows are (dead-job counts are platform-wide).
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { forbidden, handleRoute } from '@/lib/you/core/errors';
import { countersSnapshot } from '@/lib/you/core/metrics';
import { PROVIDER_NAMES, providerBreaker, providerBreakersSnapshot } from '@/lib/you/core/breaker';
import { deadJobRetentionDays } from '@/lib/you/core/jobs';

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    if (auth.actorType !== 'user') {
      // metrics are an operator surface — session auth only, never API keys
      throw forbidden('metrics require an operator session (api keys are not permitted)');
    }

    const grouped = await db.job.groupBy({ by: ['status'], _count: { _all: true } });
    const byStatus: Record<string, number> = {};
    for (const row of grouped) byStatus[row.status] = row._count._all;

    const counters = countersSnapshot();
    const rateLimitByBucket: Record<string, number> = {};
    for (const [name, value] of Object.entries(counters)) {
      if (name.startsWith('ratelimit.hits.')) rateLimitByBucket[name.slice('ratelimit.hits.'.length)] = value;
    }

    // every known provider is reported, even before its first call (a missing
    // breaker would hide provider state from the operator)
    const breakers = providerBreakersSnapshot();
    for (const name of PROVIDER_NAMES) breakers[name] = breakers[name] ?? providerBreaker(name).snapshot();

    return Response.json({
      counters,
      breakers,
      jobs: {
        byStatus,
        dead: byStatus['dead'] ?? 0,
        deadRetentionDays: deadJobRetentionDays(),
      },
      rateLimit: {
        hits: counters['ratelimit.hits'] ?? 0,
        byBucket: rateLimitByBucket,
      },
      generatedAt: new Date().toISOString(),
    });
  });
}
