// POST /api/v1/lab/runs — create BenchmarkRun (queued) + durable
// lab.benchmark job carrying {objectiveCode, worldSeed, benchmarkRunId}.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { badRequest, getIdempotencyKey, handleRoute, notFound, readJsonBody } from '@/lib/you/core/errors';
import { emitEvent } from '@/lib/you/core/events';
import { createJob } from '@/lib/you/core/jobs';

const DEFAULT_WORLD_SEED = 42;

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const body = await readJsonBody(request);

    if (typeof body.objectiveCode !== 'string' || !body.objectiveCode.trim()) {
      throw badRequest('objectiveCode is required');
    }
    const objectiveCode = body.objectiveCode.trim().toUpperCase();

    let worldSeed = DEFAULT_WORLD_SEED;
    if (body.worldSeed !== undefined && body.worldSeed !== null) {
      if (typeof body.worldSeed !== 'number' || !Number.isInteger(body.worldSeed)) {
        throw badRequest('worldSeed must be an integer');
      }
      worldSeed = body.worldSeed;
    }

    const objective = await db.labObjective.findUnique({ where: { code: objectiveCode } });
    if (!objective) throw notFound(`lab objective "${objectiveCode}" not found`);

    const run = await db.benchmarkRun.create({
      data: {
        objectiveId: objective.id,
        worldSeed,
        status: 'queued',
        organizations: '[]',
      },
    });

    const job = await createJob(
      auth.tenantId,
      'lab.benchmark',
      { objectiveCode, worldSeed, benchmarkRunId: run.id, objectiveId: objective.id },
      getIdempotencyKey(request),
    );

    await emitEvent(auth.tenantId, 'lab.run.created', 'benchmark_run', run.id, {
      runId: run.id,
      jobId: job.id,
      objectiveCode,
      worldSeed,
    });

    return Response.json({ jobId: job.id }, { status: 202 });
  });
}
