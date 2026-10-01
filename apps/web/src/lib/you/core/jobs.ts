// ═══════════════════════════════════════════════════════════════════════════
// YOU core — durable job runner (Worker A lane, ADR-0005)
// Long-running work has ONE durable source of truth: the Job row. createJob
// commits the row first, then fires runJob without awaiting (the API returns
// {jobId} immediately). Executors live in @/lib/you/lab/executors (Worker C);
// when they are missing or throw, the failure is recorded VERBATIM — never
// fabricated progress or output.
// ═══════════════════════════════════════════════════════════════════════════
import type { Job } from '@prisma/client';
import { db } from '@/lib/db';
import { getExecutor } from '../lab/executors';
import type { JobContext, JobKind, JobStep, JobState } from '../contracts';
import { emitEvent, recordUsage } from './events';
import { parseJson } from './views';

/** Per-kind step templates — honest stage maps executors advance via report(). */
const STEP_TEMPLATES: Record<JobKind, { key: string; label: string }[]> = {
  'capture.quality': [
    { key: 'validate', label: 'Validate evidence set' },
    { key: 'analyze', label: 'Analyze quality and coverage' },
    { key: 'record', label: 'Record deficiencies' },
  ],
  'twin.compile': [
    { key: 'consent', label: 'Validate consent' },
    { key: 'evidence', label: 'Load evidence' },
    { key: 'reconstruct', label: 'Run reconstruction' },
    { key: 'persist', label: 'Persist TwinVersion' },
    { key: 'artifact', label: 'Build solution artifact' },
  ],
  'render.image': [
    { key: 'validate', label: 'Validate inputs' },
    { key: 'render', label: 'Render image' },
    { key: 'persist', label: 'Persist artifact' },
  ],
  'render.video': [
    { key: 'validate', label: 'Validate inputs' },
    { key: 'submit', label: 'Submit to provider' },
    { key: 'await', label: 'Await provider' },
    { key: 'download', label: 'Download result' },
    { key: 'persist', label: 'Persist artifact' },
  ],
  'performance.fromText': [
    { key: 'parse', label: 'Parse script' },
    { key: 'generate', label: 'Generate performance tracks' },
    { key: 'persist', label: 'Persist performance' },
  ],
  'lab.benchmark': [
    { key: 'world', label: 'Generate world' },
    { key: 'compile', label: 'Compile organizations' },
    { key: 'generalist', label: 'Run generalist baseline' },
    { key: 'hand-designed', label: 'Run hand-designed baseline' },
    { key: 'searched', label: 'Run searched pipeline' },
    { key: 'evaluate', label: 'Evaluate organizations' },
    { key: 'failures', label: 'Record failure cases' },
    { key: 'promote', label: 'Promote draft pipeline' },
  ],
};

export function stepsForKind(kind: JobKind): JobStep[] {
  return (STEP_TEMPLATES[kind] ?? []).map((s) => ({ key: s.key, label: s.label, status: 'pending' as const }));
}

/**
 * Create a durable Job (status queued) and fire-and-forget runJob.
 * Dedupes on idempotencyKey (globally unique): an existing job with the same
 * key is returned as-is.
 */
export async function createJob(
  tenantId: string,
  kind: JobKind,
  input: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<Job> {
  if (idempotencyKey) {
    const existing = await db.job.findUnique({ where: { idempotencyKey } });
    if (existing) return existing;
  }

  let job: Job;
  try {
    job = await db.job.create({
      data: {
        tenantId,
        kind,
        status: 'queued',
        input: JSON.stringify(input),
        steps: JSON.stringify(stepsForKind(kind)),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
    });
  } catch (err) {
    // concurrent duplicate idempotency-key insert → return the winner
    if (idempotencyKey && (err as { code?: string }).code === 'P2002') {
      const existing = await db.job.findUnique({ where: { idempotencyKey } });
      if (existing) return existing;
    }
    throw err;
  }

  // durable first, then async execution — the API never waits for the work
  void runJob(job.id).catch((err) => {
    console.error(`[you/jobs] runJob(${job.id}) crashed:`, err instanceof Error ? err.message : err);
  });
  return job;
}

/** Execute a queued job through the registered executor, recording honest state. */
export async function runJob(jobId: string): Promise<void> {
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job) return;
  if (job.status !== 'queued') return; // already picked up or terminal

  const kind = job.kind as JobKind;
  const input = parseJson<Record<string, unknown>>(job.input, {});

  await db.job.update({ where: { id: job.id }, data: { status: 'running', startedAt: new Date() } });

  const ctx: JobContext = {
    jobId: job.id,
    tenantId: job.tenantId,
    report: async (update) => {
      const data: Record<string, unknown> = {};
      if (typeof update.progress === 'number') {
        data.progress = Math.min(1, Math.max(0, update.progress));
      }
      if (update.steps) data.steps = JSON.stringify(update.steps);
      if (update.status) data.status = update.status satisfies JobState;
      if (Object.keys(data).length === 0) return;
      await db.job.update({ where: { id: job.id }, data }).catch(() => undefined);
    },
  };

  try {
    const executor = getExecutor(kind);
    if (!executor) {
      throw new Error(`No executor registered for "${kind}" (Worker C lane, task 2-c). Refusing to fabricate output.`);
    }
    const result = await executor.execute(input, ctx);
    await db.job.update({
      where: { id: job.id },
      data: {
        status: 'succeeded',
        progress: 1,
        output: JSON.stringify(result.output ?? {}),
        finishedAt: new Date(),
      },
    });
    await emitEvent(job.tenantId, 'job.succeeded', 'job', job.id, {
      jobId: job.id,
      kind,
      entities: result.entities ?? [],
    });
    await recordUsage(job.tenantId, `job.${kind}`, 1, { jobId: job.id });
  } catch (err) {
    // keep the honest error text verbatim (e.g. "not implemented yet (Worker C lane)")
    const message = err instanceof Error ? err.message : String(err);
    await db.job
      .update({ where: { id: job.id }, data: { status: 'failed', error: message, finishedAt: new Date() } })
      .catch(() => undefined);
    await emitEvent(job.tenantId, 'job.failed', 'job', job.id, { jobId: job.id, kind, error: message });
  }
}
