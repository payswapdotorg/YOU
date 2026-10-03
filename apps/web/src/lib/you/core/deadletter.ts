// ═══════════════════════════════════════════════════════════════════════════
// YOU core — dead-letter strategy for durable jobs (Worker A lane, P6.A6-FULL).
//
// When a job's bounded retry budget is EXHAUSTED (core/retry.ts), the Job row
// transitions to the terminal `dead` status instead of staying `failed`:
//
//   failed — the executor failed in a way retrying cannot fix (non-retryable:
//            consent_required, validation, unknown provider config, …). The
//            verbatim error text lives in Job.error as before.
//   dead   — the job was RETRIED and still fails (retryable-class failures
//            that exhausted maxAttempts or the wall-clock budget). Job.error
//            holds a STRUCTURED dead-letter payload (JSON, shape below) so
//            operators can inspect what was attempted and when.
//
// Dead-letter payload (Job.error as JSON):
//   { code, attempts, stoppedBy, firstAttemptAt, lastErrorAt, lastError,
//     retryDelaysMs[] }
//
// Inspection / operations surface:
//   GET  /api/v1/maintenance/dead-jobs   — list dead jobs (operator session)
//   POST /api/v1/maintenance/dead-jobs   — { action: 'replay', jobId } re-queues
//                                          one dead job; { action: 'purge' }
//                                          deletes dead jobs past retention
//
// RETENTION POLICY (documented contract):
//   Dead jobs are kept for YOU_DEAD_JOB_RETENTION_DAYS days (default 30,
//   fail-safe: invalid/missing values fall back to 30) measured from
//   finishedAt. After that they are removable by the purge action; the purge
//   is OPERATOR-INITIATED (no background sweeper in this wave — disclosed:
//   a cron/scheduler adoption is future work). Replaying never deletes: the
//   pre-replay dead-letter record remains in the audit trail (job.dead event +
//   audit entry) even after the row re-queues.
//
// ZERO-RUNTIME-IMPORT MODULE (erasable TS only — the single import is
// `import type`, erased at runtime): imported directly by node:test unit
// suites under Node >= 23.6 type stripping.
// ═══════════════════════════════════════════════════════════════════════════
import type { RetryFailed } from './retry';

export const DEAD_JOB_STATUS = 'dead';
export const DEAD_LETTER_CODE = 'dead_letter';
export const DEFAULT_DEAD_JOB_RETENTION_DAYS = 30;

export interface DeadLetterPayload {
  code: typeof DEAD_LETTER_CODE;
  /** Total attempts made (>= 2 — dead jobs are always retried jobs). */
  attempts: number;
  /** Why the retry loop stopped: 'exhausted-attempts' | 'budget'. */
  stoppedBy: string;
  /** ISO timestamp of the first attempt. */
  firstAttemptAt: string;
  /** ISO timestamp of the last failure. */
  lastErrorAt: string;
  /** The verbatim last error message. */
  lastError: string;
}

/** Build the structured payload stored in Job.error for dead jobs. */
export function buildDeadLetterPayload(outcome: RetryFailed): DeadLetterPayload {
  const err = outcome.error;
  return {
    code: DEAD_LETTER_CODE,
    attempts: outcome.attempts,
    stoppedBy: outcome.stoppedBy,
    firstAttemptAt: new Date(outcome.firstAttemptAt).toISOString(),
    lastErrorAt: new Date(outcome.finishedAt).toISOString(),
    lastError: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Parse a Job.error string back into a dead-letter payload. Returns null for
 * anything that is not a dead-letter record (plain failed-job text stays
 * plain — never fabricate structure).
 */
export function parseDeadLetterError(error: string | null | undefined): DeadLetterPayload | null {
  if (!error) return null;
  const trimmed = error.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<DeadLetterPayload>;
    if (parsed.code !== DEAD_LETTER_CODE) return null;
    if (typeof parsed.attempts !== 'number' || typeof parsed.lastError !== 'string') return null;
    return {
      code: DEAD_LETTER_CODE,
      attempts: parsed.attempts,
      stoppedBy: typeof parsed.stoppedBy === 'string' ? parsed.stoppedBy : 'unknown',
      firstAttemptAt: typeof parsed.firstAttemptAt === 'string' ? parsed.firstAttemptAt : '',
      lastErrorAt: typeof parsed.lastErrorAt === 'string' ? parsed.lastErrorAt : '',
      lastError: parsed.lastError,
    };
  } catch {
    return null;
  }
}

/**
 * A job outcome is DEAD (not merely failed) when the retry budget was actually
 * spent: the job was retried (attempts > 1), or a retryable failure met a
 * one-attempt budget (maxAttempts=1) / was cut short by the wall-clock budget.
 * Single non-retryable failures stay `failed`.
 */
export function isDeadLetterOutcome(outcome: RetryFailed): boolean {
  return outcome.attempts > 1 || outcome.stoppedBy !== 'non-retryable';
}

/** Retention in days (fail-safe: garbage falls back to the 30-day default). */
export function deadJobRetentionDays(): number {
  const n = Number(process.env.YOU_DEAD_JOB_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DEAD_JOB_RETENTION_DAYS;
}

/** Purge cutoff: epoch-ms before which a dead job (finishedAt) is purgeable. */
export function deadJobCutoff(now: number = Date.now(), retentionDays: number = deadJobRetentionDays()): number {
  return now - retentionDays * 24 * 60 * 60 * 1000;
}
