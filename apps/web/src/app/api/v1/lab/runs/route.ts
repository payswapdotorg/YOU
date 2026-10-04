// POST /api/v1/lab/runs — create BenchmarkRun (queued) + durable
// lab.benchmark job carrying {objectiveCode, worldSeed, benchmarkRunId}.
// P6.C11:
//  - optional `rerunOf` — re-runs are NEW runs referencing their parent (the
//    write-once law: a completed run is never mutated);
//  - idempotent replay returns the ORIGINAL ids (C8 law): a replayed
//    idempotency key never creates a second run row.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { badRequest, getIdempotencyKey, handleRoute, notFound, readJsonBody } from '@/lib/you/core/errors';
import { emitEvent } from '@/lib/you/core/events';
import { createJob } from '@/lib/you/core/jobs';
import { parseJson } from '@/lib/you/core/views';

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

    // P6.C11: a re-run references its parent run — the parent stays immutable,
    // the re-run is a NEW BenchmarkRun row (rerunOfId) with its own manifest.
    let rerunOf: string | null = null;
    if (body.rerunOf !== undefined && body.rerunOf !== null) {
      if (typeof body.rerunOf !== 'string' || !body.rerunOf.trim()) {
        throw badRequest('rerunOf must be a benchmark run id (non-empty string)');
      }
      rerunOf = body.rerunOf.trim();
      const parent = await db.benchmarkRun.findUnique({ where: { id: rerunOf } });
      if (!parent) throw notFound(`parent benchmark run "${rerunOf}" not found (rerunOf)`);
    }

    const objective = await db.labObjective.findUnique({ where: { code: objectiveCode } });
    if (!objective) throw notFound(`lab objective "${objectiveCode}" not found`);

    // idempotent replay (the C8 law): BEFORE creating any row, an existing
    // lab.benchmark job with this key returns the ORIGINAL ids as-is.
    const idem = getIdempotencyKey(request);
    if (idem) {
      const existing = await db.job.findUnique({ where: { idempotencyKey: idem } });
      if (existing && existing.kind === 'lab.benchmark') {
        const existingInput = parseJson<Record<string, unknown>>(existing.input, {});
        const originalRunId = typeof existingInput.benchmarkRunId === 'string' ? existingInput.benchmarkRunId : null;
        return Response.json(
          {
            jobId: existing.id,
            ...(originalRunId ? { benchmarkRunId: originalRunId } : {}),
            replayed: true,
          },
          { status: 202 },
        );
      }
    }

    const run = await db.benchmarkRun.create({
      data: {
        objectiveId: objective.id,
        worldSeed,
        status: 'queued',
        organizations: '[]',
        ...(rerunOf ? { rerunOfId: rerunOf } : {}),
      },
    });

    const job = await createJob(
      auth.tenantId,
      'lab.benchmark',
      { objectiveCode, worldSeed, benchmarkRunId: run.id, objectiveId: objective.id, ...(rerunOf ? { rerunOf } : {}) },
      idem,
    );

    // race-window guard: if createJob returned a PREVIOUS job (concurrent
    // duplicate key), the just-created queued row is an orphan — remove it
    // and return the ORIGINAL ids, never a second run.
    const jobInput = parseJson<Record<string, unknown>>(job.input, {});
    if (job.kind === 'lab.benchmark' && jobInput.benchmarkRunId !== run.id) {
      await db.benchmarkRun.delete({ where: { id: run.id } }).catch(() => undefined);
      const originalRunId = typeof jobInput.benchmarkRunId === 'string' ? jobInput.benchmarkRunId : null;
      return Response.json(
        {
          jobId: job.id,
          ...(originalRunId ? { benchmarkRunId: originalRunId } : {}),
          replayed: true,
        },
        { status: 202 },
      );
    }

    await emitEvent(auth.tenantId, 'lab.run.created', 'benchmark_run', run.id, {
      runId: run.id,
      jobId: job.id,
      objectiveCode,
      worldSeed,
      ...(rerunOf ? { rerunOf } : {}),
    });

    return Response.json({ jobId: job.id, benchmarkRunId: run.id }, { status: 202 });
  });
}
