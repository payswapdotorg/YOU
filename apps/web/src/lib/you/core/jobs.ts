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
import { withRetries, type RetryOutcome } from './retry';
import { buildDeadLetterPayload, isDeadLetterOutcome, DEAD_JOB_STATUS } from './deadletter';
import { bumpCounter } from './metrics';

/**
 * W2.A lane-local widening: the frozen contracts JobKind union (TL-owned,
 * src/lib/you/contracts/index.ts) does not yet include 'template.analyze'.
 * The value flows through Job.kind rows/views unchanged; TL should add the
 * union member at landing (see w2a-report.md compatibility notes).
 */
export type DurableJobKind =
  | JobKind
  | 'template.analyze'
  | 'f1.reconstruct'
  | 'agent.turn'
  | 'tryon.render' // P6.C8 lane-local widening — same law; TL adds it at landing
  | 'export.glb' // P6.C9 lane-local widening — same law; TL adds it at landing
  | 'export.vrm' // P6.C9 lane-local widening — same law; TL adds it at landing
  | 'lab.mutate'; // P6.C10 lane-local widening — the Pipeline Genome loop; same law; TL adds it at landing

/**
 * P6.A6-FULL lane-local widening: the frozen JobState union does not yet
 * include 'dead' (the terminal dead-letter state for jobs that exhausted
 * their bounded retry budget). The value flows through Job.status rows/views
 * unchanged; TL should add the union member at landing.
 */
export type DurableJobStatus = JobState | 'dead';

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
    { key: 'manifest', label: 'Build the write-once run manifest (P6.C11)' },
    { key: 'failures', label: 'Record failure cases (taxonomy v1 codes)' },
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
  // P6.C4 — real-human F1 reconstruction (consent-gated; fail-closed
  // liveness/quality checkpoints; registry-resolved per-asset VLM analysis;
  // honest F1ReconstructionReport; TwinVersion with F1 provenance)
  'f1.reconstruct': [
    { key: 'load', label: 'Load capture session and twin' },
    { key: 'consent', label: 'Verify reconstruct consent (server-enforced)' },
    { key: 'checkpoints', label: 'Liveness and quality checkpoints (fail-closed)' },
    { key: 'analyze', label: 'Per-asset VLM analysis (registry-resolved)' },
    { key: 'report', label: 'Aggregate F1 reconstruction report' },
    { key: 'persist', label: 'Publish TwinVersion with F1 provenance' },
  ],
  // P6.C6 — Agent Body/Soul production runtime: one chat turn. Short-lived
  // per-LLM-call retries + breaker live inside the chat seam (ai/zai.ts);
  // this job-level retry wraps the whole turn and dead-letters exhausted
  // retryable failures (the honest 'retry then deadletter' path).
  'agent.turn': [
    { key: 'load', label: 'Load session, pinned Body/Soul snapshots and history' },
    { key: 'consent', label: 'Re-verify embodiment consent (server-enforced, fail-closed)' },
    { key: 'enforce', label: 'Capability manifests (server-side enforcement)' },
    { key: 'reply', label: 'Run the Soul (LLM turns + bounded tool rounds)' },
    { key: 'persist', label: 'Persist agent turn with events, seed and latency' },
  ],
  // P6.C8 — virtual try-on: provider fail-closed → baseline render → hosted
  // try-on → comparison artifact + identity report. The provider step is a
  // REAL gate: no configured provider → the job fails honestly there.
  'tryon.render': [
    { key: 'validate', label: 'Load try-on job, twin version and garment' },
    { key: 'consent', label: 'Verify render consent (server-enforced)' },
    { key: 'provider', label: 'Resolve the try-on provider (fail-closed)' },
    { key: 'baseline', label: 'Render the twin baseline image (body-aware base)' },
    { key: 'tryon', label: 'Run the hosted virtual try-on' },
    { key: 'comparison', label: 'Build diff manifest + identity-preservation report' },
    { key: 'persist', label: 'Persist comparison artifact with the visual-only disclaimer' },
  ],
  // P6.C9 — game/AR export: the deterministic local emitter (no provider).
  // Fail-closed geometry gate BEFORE any emission; every artifact carries
  // the structural-vs-derived manifest + the verbatim honest-claims text.
  'export.glb': [
    { key: 'validate', label: 'Load export job, twin version and HTIR' },
    { key: 'consent', label: 'Verify reconstruct consent (server-enforced)' },
    { key: 'geometry', label: 'Check HTIR geometry usability (fail-closed)' },
    { key: 'emit', label: 'Emit the deterministic GLB bundle (LODs + mapping)' },
    { key: 'persist', label: 'Persist export artifacts with the honest manifest' },
  ],
  'export.vrm': [
    { key: 'validate', label: 'Load export job, twin version and HTIR' },
    { key: 'consent', label: 'Verify reconstruct consent (server-enforced)' },
    { key: 'geometry', label: 'Check HTIR geometry usability (fail-closed)' },
    { key: 'emit', label: 'Emit the deterministic VRM bundle (LODs + mapping)' },
    { key: 'persist', label: 'Persist export artifacts with the honest manifest' },
  ],
  // P6.C10 — the Pipeline Genome loop: deterministic mutation + a REAL
  // parent-vs-offspring benchmark on the same seeded world (2 grounding
  // calls attempted — honest modeled-only degrade when the provider is
  // unavailable), the honest comparison on the documented weighted
  // formula, auto-draft only when the offspring wins.
  'lab.mutate': [
    { key: 'load', label: 'Load the parent pipeline and genome' },
    { key: 'mutate', label: 'Deterministically mutate the genome' },
    { key: 'offspring', label: 'Create the child pipeline (natural key)' },
    { key: 'benchmark', label: 'Benchmark parent vs offspring on the seeded world' },
    { key: 'compare', label: 'Compare on the documented weighted formula' },
    { key: 'persist', label: 'Record lineage, failures and the honest verdict' },
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
    // cast: getExecutor's parameter is the frozen contracts JobKind; the
    // lane-local 'template.analyze' member registers through the same seam
    const executor = getExecutor(kind as JobKind);
    if (!executor) {
      throw new Error(`No executor registered for "${kind}" (Worker C lane, task 2-c). Refusing to fabricate output.`);
    }
    // P6.A6-FULL — bounded retries: the executor runs under the shared retry
    // engine (maxAttempts + wall-clock budget, exponential backoff + jitter,
    // retry-after respected, fail-closed classification). A retried execution
    // re-runs the executor from its first step; executors persist only on
    // success paths, so a failed attempt leaves no partial output behind.
    const outcome: RetryOutcome<{ output?: Record<string, unknown>; entities?: unknown[] }> = await withRetries(
      () => executor.execute(input, ctx),
      jobRetryOptions(kind),
    );
    if (outcome.ok) {
      await db.job.update({
        where: { id: job.id },
        data: {
          status: 'succeeded',
          progress: 1,
          output: JSON.stringify(outcome.value.output ?? {}),
          finishedAt: new Date(),
        },
      });
      await emitEvent(job.tenantId, 'job.succeeded', 'job', job.id, {
        jobId: job.id,
        kind,
        entities: outcome.value.entities ?? [],
      });
      await recordUsage(job.tenantId, `job.${kind}`, 1, { jobId: job.id, attempts: outcome.attempts });
      return;
    }
    // failure path — dead-letter or plain failed, by retry classification
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    if (isDeadLetterOutcome(outcome)) {
      // terminal dead: the bounded retry budget was spent and the job still
      // fails — structured payload for operator inspection + replay
      const payload = buildDeadLetterPayload(outcome);
      await db.job
        .update({
          where: { id: job.id },
          data: { status: DEAD_JOB_STATUS, error: JSON.stringify(payload), finishedAt: new Date() },
        })
        .catch(() => undefined);
      bumpCounter('dead_jobs', { kind });
      await emitEvent(job.tenantId, 'job.dead', 'job', job.id, {
        jobId: job.id,
        kind,
        attempts: payload.attempts,
        stoppedBy: payload.stoppedBy,
        error: message,
      });
      return;
    }
    // keep the honest error text verbatim (e.g. "not implemented yet (Worker C lane)")
    await db.job
      .update({ where: { id: job.id }, data: { status: 'failed', error: message, finishedAt: new Date() } })
      .catch(() => undefined);
    await emitEvent(job.tenantId, 'job.failed', 'job', job.id, { jobId: job.id, kind, error: message });
  } catch (err) {
    // runner-level failures (executor lookup, db writes) — honest, immediate
    const message = err instanceof Error ? err.message : String(err);
    await db.job
      .update({ where: { id: job.id }, data: { status: 'failed', error: message, finishedAt: new Date() } })
      .catch(() => undefined);
    await emitEvent(job.tenantId, 'job.failed', 'job', job.id, { jobId: job.id, kind, error: message });
  }
}

/**
 * Job-level retry policy (P6.A6-FULL): bounded by YOU_JOB_MAX_ATTEMPTS (total
 * attempts, default 3) and YOU_JOB_RETRY_BUDGET_MS (wall clock, default 30s);
 * backoff knobs shared with the provider seam unless the YOU_JOB_* overrides
 * are set. Fail-closed classification (core/retry.ts) — non-retryable
 * executor failures (consent, validation, missing executor) fail immediately.
 */
function jobRetryOptions(kind: DurableJobKind) {
  const num = (name: string, fallback: number): number => {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    maxAttempts: num('YOU_JOB_MAX_ATTEMPTS', 3),
    baseDelayMs: num('YOU_JOB_RETRY_BASE_DELAY_MS', num('YOU_RETRY_BASE_DELAY_MS', 500)),
    budgetMs: num('YOU_JOB_RETRY_BUDGET_MS', num('YOU_RETRY_BUDGET_MS', 30_000)),
    onRetry: (info: { attempt: number; delayMs: number }) => {
      bumpCounter('job_retries', { kind });
      console.warn(
        `[you/jobs] ${kind} attempt ${info.attempt} failed — retrying in ${info.delayMs}ms (bounded: max attempts + wall-clock budget; see /api/v1/metrics)`,
      );
    },
  };
}
