// ═══════════════════════════════════════════════════════════════════════════
// YOU core — durable job runner (Worker A lane, ADR-0005)
// Long-running work has ONE durable source of truth: the Job row. createJob
// commits the row first, then fires runJob without awaiting (the API returns
// {jobId} immediately). Executors live in @/lib/you/lab/executors (Worker C);
// when they are missing or throw, the failure is recorded VERBATIM — never
// fabricated progress or output.
//
// P6.A6 full — bounded retries + dead-letter:
// - executor attempts run through the shared retry helper (core/retry.ts):
//   exponential backoff + jitter, hard maxAttempts cap, optional wall-clock
//   budget. NEVER infinite.
// - transient errors (network/timeout/retryable-exhaustion) retry; permanent
//   errors (validation/consent/not-found/forbidden, a refusal from the
//   provider circuit breaker, unknown errors by default) fail terminal in
//   `failed` exactly like the baseline — no behavior change for them.
// - a job whose retryable errors EXHAUST the attempts transitions to the
//   terminal `dead` state with a structured deadLetter payload (attempts,
//   lastError, first/last/dead timestamps, replay history) + a `job.dead`
//   event. Inspection/replay: GET /api/v1/jobs/dead, POST .../replay.
// - retention: dead jobs are pruned lazily on inspection, after
//   YOU_DEAD_JOB_RETENTION_DAYS (default 30) — see pruneDeadJobs().
//
// In-process retry timers are lost on process death (jobs mid-retry stay in
// their last recorded state) — the same fire-and-forget limitation the
// baseline documents; the durable rows are the truth for inspection/replay.
// ═══════════════════════════════════════════════════════════════════════════
import type { Job } from '@prisma/client';
import { db } from '@/lib/db';
import { getExecutor } from '../lab/executors';
import type { JobContext, JobKind, JobStep, JobState } from '../contracts';
import { emitEvent, recordUsage } from './events';
import { parseJson } from './views';
import { retry, RetryExhaustedError, type RetryOptions } from './retry';
import { ProviderUnavailableError } from './breaker';
import { incrCounter } from './metrics';
import { conflict, notFound } from './errors';

/**
 * W2.A lane-local widening: the frozen contracts JobKind union (TL-owned,
 * src/lib/you/contracts/index.ts) does not yet include 'template.analyze'.
 * The value flows through Job.kind rows/views unchanged; TL should add the
 * union member at landing (see w2a-report.md compatibility notes).
 */
export type DurableJobKind = JobKind | 'template.analyze';

/**
 * P6.A6 lane-local widening: the frozen contracts JobState union does not yet
 * include the terminal 'dead' state (jobs that exhausted bounded retries —
 * see deadLetter). Rows/views carry it as a plain string; TL should add the
 * member to JOB_STATES + JobState at landing (same pattern as the note above).
 */
export type DurableJobState = JobState | 'dead';

/** Structured dead-letter payload (Job.deadLetter JSON). */
export interface DeadLetterPayload {
  attempts: number;
  lastError: string;
  firstAttemptAt: string; // ISO
  lastAttemptAt: string; // ISO
  deadAt: string; // ISO
  kind: string;
  stoppedBy: 'attempts' | 'budget';
  replays: { replayedAt: string; actorId?: string | null }[];
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback; // fail-closed safe default
  return n;
}

/** Durable-job retry knobs (see .env.example). */
export function jobRetryEnvOptions(): Pick<RetryOptions, 'maxAttempts' | 'baseDelayMs' | 'maxDelayMs'> {
  return {
    maxAttempts: envNum('YOU_JOB_MAX_ATTEMPTS', 3),
    baseDelayMs: envNum('YOU_JOB_RETRY_BASE_DELAY_MS', 2_000),
    maxDelayMs: envNum('YOU_JOB_RETRY_MAX_DELAY_MS', 30_000),
  };
}

// Executor error classes that are never worth a retry (verbatim prefixes the
// executors already use) — a permanent failure must land terminal immediately.
const PERMANENT_JOB_ERROR =
  /^(validation_failed|not_found|forbidden|consent_required|policy_blocked|conflict|idempotency)/i;
// Transient signatures worth one more bounded attempt.
const TRANSIENT_JOB_ERROR =
  /network|econn|timeout|timed out|etimedout|enotfound|eai_again|socket|fetch failed|temporarily unavailable|502|503|504/i;

/**
 * Job-level retry classification:
 * - ProviderUnavailableError: the circuit breaker already refused the provider
 *   — retrying the job now would only hit the open breaker again. Terminal.
 * - RetryExhaustedError: a retryable class (typically a provider call) burned
 *   its per-call retries — a fresh executor run is the next tier up.
 * - verbatim permanent prefixes (validation/consent/not-found/…): terminal.
 * - transient network/timeout signatures: retry.
 * - DEFAULT IS TERMINAL: unknown errors fail like the baseline (no retry),
 *   preserving the pre-P6.A6 semantics for every existing failure mode.
 */
export function jobRetryDecision(err: unknown): boolean {
  if (err instanceof ProviderUnavailableError) return false;
  if (err instanceof RetryExhaustedError) return true;
  if (!(err instanceof Error)) return false;
  if (PERMANENT_JOB_ERROR.test(err.message)) return false;
  if (TRANSIENT_JOB_ERROR.test(err.message)) return true;
  return false;
}

/** Dead-job retention window in days (YOU_DEAD_JOB_RETENTION_DAYS, default 30). */
export function deadJobRetentionDays(): number {
  return envNum('YOU_DEAD_JOB_RETENTION_DAYS', 30);
}

/** Prune dead jobs past the retention window (lazy sweep on inspection). */
export async function pruneDeadJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - deadJobRetentionDays() * 86_400_000);
  const result = await db.job.deleteMany({ where: { status: 'dead', deadAt: { lt: cutoff } } });
  return result.count;
}

/** Per-kind step templates — honest stage maps executors advance via report(). */
const STEP_TEMPLATES: Record<DurableJobKind, { key: string; label: string }[]> = {
  'maintenance.gc-storage': [
    { key: 'enumerate', label: 'Enumerate stored objects' },
    { key: 'reference', label: 'Build the referenced-key set' },
    { key: 'sweep', label: 'Delete unreferenced objects' },
  ],
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
  // W2.A — async durable analyze job for POST /templates/:id/analyze
  'template.analyze': [
    { key: 'validate', label: 'Load and validate template' },
    { key: 'checklist', label: 'Analyze capture checklist coverage' },
    { key: 'scenes', label: 'Validate scene recipes' },
    { key: 'styles', label: 'Validate style presets' },
    { key: 'persist', label: 'Persist analysis on template' },
  ],
};

export function stepsForKind(kind: DurableJobKind): JobStep[] {
  return (STEP_TEMPLATES[kind] ?? []).map((s) => ({ key: s.key, label: s.label, status: 'pending' as const }));
}

/**
 * Create a durable Job (status queued) and fire-and-forget runJob.
 * Dedupes on idempotencyKey (globally unique): an existing job with the same
 * key is returned as-is.
 */
export async function createJob(
  tenantId: string,
  kind: DurableJobKind,
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

  const kind = job.kind as DurableJobKind;
  const input = parseJson<Record<string, unknown>>(job.input, {});
  const firstAttemptAt = job.firstAttemptAt ?? new Date();

  await db.job.update({
    where: { id: job.id },
    data: { status: 'running', startedAt: job.startedAt ?? new Date(), firstAttemptAt },
  });

  const executeAttempt = async () => {
    // cast: getExecutor's parameter is the frozen contracts JobKind; the
    // lane-local 'template.analyze' member registers through the same seam
    const executor = getExecutor(kind as JobKind);
    if (!executor) {
      throw new Error(`No executor registered for "${kind}" (Worker C lane, task 2-c). Refusing to fabricate output.`);
    }
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
    return executor.execute(input, ctx);
  };

  try {
    const result = await retry(executeAttempt, `job.${kind}`, {
      ...jobRetryEnvOptions(),
      retryOn: jobRetryDecision,
      onAttempt: (info) => {
        if (info.attempt > 1) {
          incrCounter('retries');
          incrCounter(`retry.job.${kind}`);
        }
        // durable per-attempt bookkeeping (best-effort; the terminal write is authoritative)
        void db.job
          .update({ where: { id: job.id }, data: { attempts: info.attempt, lastAttemptAt: new Date() } })
          .catch(() => undefined);
      },
    });
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
    if (err instanceof RetryExhaustedError) {
      // P6.A6 dead-letter: the retryable class exhausted the bounded attempts.
      const deadAt = new Date();
      const payload: DeadLetterPayload = {
        attempts: err.attempts,
        lastError: message,
        firstAttemptAt: firstAttemptAt.toISOString(),
        lastAttemptAt: deadAt.toISOString(),
        deadAt: deadAt.toISOString(),
        kind,
        stoppedBy: err.stoppedBy,
        replays: [],
      };
      await db.job
        .update({
          where: { id: job.id },
          data: {
            status: 'dead',
            error: message,
            attempts: err.attempts,
            finishedAt: deadAt,
            deadAt,
            deadLetter: JSON.stringify(payload),
          },
        })
        .catch(() => undefined);
      incrCounter('jobs.dead');
      await emitEvent(job.tenantId, 'job.dead', 'job', job.id, {
        jobId: job.id,
        kind,
        attempts: err.attempts,
        lastError: message,
      });
      return;
    }
    // permanent failure — terminal `failed`, exactly like the baseline
    await db.job
      .update({ where: { id: job.id }, data: { status: 'failed', error: message, finishedAt: new Date() } })
      .catch(() => undefined);
    await emitEvent(job.tenantId, 'job.failed', 'job', job.id, { jobId: job.id, kind, error: message });
  }
}

/**
 * Replay a dead job (operator action — POST /api/v1/jobs/dead/:id/replay):
 * re-queue the SAME durable row (input preserved) with a fresh attempt
 * lifecycle; the deadLetter keeps the full replay history.
 */
export async function replayDeadJob(tenantId: string, jobId: string, actorId?: string): Promise<Job> {
  const job = await db.job.findFirst({ where: { id: jobId, tenantId } });
  if (!job) throw notFound(`dead job "${jobId}" not found`);
  if (job.status !== 'dead') {
    throw conflict(`only dead jobs can be replayed (job "${jobId}" status is "${job.status}")`);
  }

  const prior = parseJson<DeadLetterPayload>(job.deadLetter, {
    attempts: job.attempts,
    lastError: job.error ?? '',
    firstAttemptAt: '',
    lastAttemptAt: '',
    deadAt: '',
    kind: job.kind,
    stoppedBy: 'attempts',
    replays: [],
  });
  const replayedAt = new Date().toISOString();
  const deadLetter: DeadLetterPayload = {
    ...prior,
    replays: [...(prior.replays ?? []), { replayedAt, actorId: actorId ?? null }],
  };

  const updated = await db.job.update({
    where: { id: job.id },
    data: {
      status: 'queued',
      attempts: 0,
      error: null,
      output: null,
      progress: 0,
      steps: JSON.stringify(stepsForKind(job.kind as DurableJobKind)),
      firstAttemptAt: null,
      lastAttemptAt: null,
      deadAt: null,
      deadLetter: JSON.stringify(deadLetter),
      startedAt: null,
      finishedAt: null,
    },
  });

  // durable requeue first, then fire-and-forget the fresh run
  void runJob(updated.id).catch((err) => {
    console.error(`[you/jobs] replay runJob(${updated.id}) crashed:`, err instanceof Error ? err.message : err);
  });
  return updated;
}
