// GET  /api/v1/maintenance/dead-jobs — dead-letter inspection (P6.A6-FULL).
// POST /api/v1/maintenance/dead-jobs — { action: 'replay', jobId } | { action: 'purge' }
//
// OPERATOR SESSION ONLY (same law as gc-storage: api keys are refused).
//
// Dead jobs are durable Job rows with status 'dead' whose bounded retry
// budget was exhausted; Job.error holds the structured dead-letter payload
// (attempts / stoppedBy / firstAttemptAt / lastErrorAt / lastError — see
// core/deadletter.ts). This is the query/inspection path + the replay action.
//
// RETENTION POLICY: dead jobs are retained YOU_DEAD_JOB_RETENTION_DAYS days
// (default 30) from finishedAt; the purge action deletes only dead jobs past
// that cutoff. Purge is operator-initiated by design (no background sweeper
// in this wave — a scheduled adoption is future work, disclosed). Replay
// re-queues the SAME row (status dead → queued) and fires runJob; the
// pre-replay dead-letter record stays in the event log + audit trail.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { runJob } from '@/lib/you/core/jobs';
import { badRequest, forbidden, handleRoute, notFound, readJsonBody } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { deadJobCutoff, deadJobRetentionDays, parseDeadLetterError } from '@/lib/you/core/deadletter';
import { parseEmbeddedCompute } from '@/lib/you/lab/compute-routing';

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    if (auth.actorType !== 'user') {
      throw forbidden('dead-job inspection requires an operator session (api keys are not permitted)');
    }

    const url = new URL(request.url);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));

    const rows = await db.job.findMany({
      where: { tenantId: auth.tenantId, status: 'dead' },
      orderBy: { finishedAt: 'desc' },
      take: limit,
      select: { id: true, kind: true, status: true, error: true, createdAt: true, startedAt: true, finishedAt: true, input: true },
    });

    return Response.json(
      {
        retentionDays: deadJobRetentionDays(),
        count: rows.length,
        jobs: rows.map((j) => ({
          id: j.id,
          kind: j.kind,
          status: j.status,
          createdAt: j.createdAt.toISOString(),
          firstAttemptAt: j.startedAt?.toISOString() ?? null,
          finishedAt: j.finishedAt?.toISOString() ?? null,
          // structured dead-letter payload when parseable; null never lies
          deadLetter: parseDeadLetterError(j.error),
          // P6.C3 (compute broker): the embedded routing record + quote for
          // broker-submitted jobs — a workload whose provider exhausted its
          // bounded retries lands here WITH its quote. null for plain
          // route-submitted jobs (structure is never fabricated).
          compute: parseEmbeddedCompute(j.input),
        })),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    if (auth.actorType !== 'user') {
      throw forbidden('dead-job operations require an operator session (api keys are not permitted)');
    }
    const body = await readJsonBody(request);
    const action = typeof body.action === 'string' ? body.action : '';

    if (action === 'replay') {
      const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : '';
      if (!jobId) throw badRequest('replay requires a jobId (string)');
      const job = await db.job.findFirst({ where: { id: jobId, tenantId: auth.tenantId } });
      if (!job) throw notFound(`dead job "${jobId}" not found`);
      if (job.status !== 'dead') throw badRequest(`job "${jobId}" is "${job.status}", not dead — only dead jobs replay`);

      // audit BEFORE the row mutates: the pre-replay dead-letter record is
      // preserved in the trail even though the row re-queues
      await audit(auth.tenantId, auth, 'job.replayed', 'job', job.id, {
        kind: job.kind,
        deadLetter: parseDeadLetterError(job.error),
      });

      await db.job.update({
        where: { id: job.id },
        data: { status: 'queued', error: null, startedAt: null, finishedAt: null, progress: 0 },
      });
      // durable re-queue first, then fire-and-forget execution (jobs.ts law)
      void runJob(job.id).catch((err) => {
        console.error(`[you/jobs] replay runJob(${job.id}) crashed:`, err instanceof Error ? err.message : err);
      });
      await emitEvent(auth.tenantId, 'job.replayed', 'job', job.id, { jobId: job.id, kind: job.kind });

      return Response.json({ jobId: job.id, replayed: true }, { status: 202 });
    }

    if (action === 'purge') {
      const cutoff = new Date(deadJobCutoff());
      const purged = await db.job.deleteMany({
        where: { tenantId: auth.tenantId, status: 'dead', finishedAt: { lt: cutoff } },
      });
      await audit(auth.tenantId, auth, 'dead_jobs.purged', 'job', null, {
        purged: purged.count,
        cutoff: cutoff.toISOString(),
        retentionDays: deadJobRetentionDays(),
      });
      return Response.json({
        purged: purged.count,
        retentionDays: deadJobRetentionDays(),
        cutoff: cutoff.toISOString(),
      });
    }

    throw badRequest('action must be "replay" (with jobId) or "purge"');
  });
}
