// POST /api/v1/lab/pipelines/:id/mutate — the Pipeline Genome loop (P6.C10):
// create a durable lab.mutate job that deterministically mutates this
// pipeline's genome and benchmarks the offspring against the parent on the
// same seeded world. Mutation is recorded (parent, generation, diff); the
// benchmark-offspring path is a REAL job kind with progress + honest errors.
//
// Body (all optional):
//   mutationSeed  integer — the deterministic mutation seed (default: derived
//                from the parent id + the current generation counter, so
//                repeated calls explore; same seed → same child, natural-key
//                deduped by the deterministic child name)
//   worldSeed    integer — the benchmark world seed (default 42)
//   objectiveCode string — which objective's gates the offspring is
//                benchmarked under (default HUMAN-RECON-001)
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import {
  badRequest, conflict, getIdempotencyKey, handleRoute, notFound, optNumber, optString, readJsonBody,
} from '@/lib/you/core/errors';
import { emitEvent } from '@/lib/you/core/events';
import { createJob } from '@/lib/you/core/jobs';
import { hashString } from '@/lib/you/lab/determinism';

const DEFAULT_WORLD_SEED = 42;
const DEFAULT_OBJECTIVE = 'HUMAN-RECON-001';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const body = await readJsonBody(request);

    const pipeline = await db.pipelineCandidate.findUnique({ where: { id } });
    if (!pipeline) throw notFound(`pipeline candidate "${id}" not found`);
    if (pipeline.status === 'retired') {
      throw conflict('retired pipelines are not mutated — un-retire (revert) first if this lineage should continue');
    }

    let mutationSeed: number | undefined = optNumber(body, 'mutationSeed');
    if (mutationSeed !== undefined && (!Number.isInteger(mutationSeed) || Math.abs(mutationSeed) > 2 ** 31)) {
      throw badRequest('mutationSeed must be a 31-bit integer');
    }
    let worldSeed = DEFAULT_WORLD_SEED;
    const rawWorldSeed = optNumber(body, 'worldSeed');
    if (rawWorldSeed !== undefined) {
      if (!Number.isInteger(rawWorldSeed) || Math.abs(rawWorldSeed) > 2 ** 31) {
        throw badRequest('worldSeed must be a 31-bit integer');
      }
      worldSeed = rawWorldSeed;
    }
    const objectiveCode = (optString(body, 'objectiveCode', { max: 64 }) ?? DEFAULT_OBJECTIVE)
      .trim()
      .toUpperCase();

    // deterministic default exploration seed: parent id + generation counter
    // (count of existing children) — honest and recorded, never random
    if (mutationSeed === undefined) {
      const existingChildren = await db.pipelineCandidate.count({ where: { parentId: id } });
      mutationSeed = hashString(`${id}:${existingChildren + 1}`) % 2 ** 31;
    }

    const objective = await db.labObjective.findUnique({ where: { code: objectiveCode } });
    if (!objective) throw notFound(`lab objective "${objectiveCode}" not found`);

    const job = await createJob(
      auth.tenantId,
      'lab.mutate',
      {
        pipelineId: id,
        mutationSeed,
        worldSeed,
        objectiveCode,
      },
      getIdempotencyKey(request),
    );

    await emitEvent(auth.tenantId, 'lab.mutation.queued', 'pipeline_candidate', id, {
      jobId: job.id,
      pipelineId: id,
      mutationSeed,
      worldSeed,
      objectiveCode,
    });

    return Response.json({ jobId: job.id, mutationSeed, worldSeed, objectiveCode }, { status: 202 });
  });
}
