// ═══════════════════════════════════════════════════════════════════════════
// YOU client — degraded-state model (Worker B lane, P6.B8).
//
// Pure UI-side model for honest degraded/error states. Consumes the typed
// error envelopes the P6.A6-FULL backend emits (service_unavailable with
// details.retryAfterSeconds + a Retry-After header — apps/web/src/lib/you/
// core/errors.ts) and the terminal `dead` job state (core/deadletter.ts),
// and derives WHAT the user sees. Honest by construction: no fabricated
// progress, no invented retry estimates — retry guidance is derived from
// retryAfterMs the backend actually sent.
//
// ZERO-RUNTIME-IMPORT MODULE (erasable TS only): imported directly by
// node:test unit suites under Node >= 23.6 type stripping (the same pattern
// as core/circuit-breaker.ts / core/deadletter.ts). The visual surface lives
// in components/you/shared/degraded-state.tsx and consumes this model.
// Dead-letter payload PARSING stays in core/deadletter.ts (read-only
// consumption from the .tsx — no duplicated parser here).
// ═══════════════════════════════════════════════════════════════════════════

/** Envelope codes that mean "the service is degraded", not "you did wrong". */
export const DEGRADED_CODES: readonly string[] = ['service_unavailable', 'provider_unavailable'];

/** All terminal durable-job statuses (P6.A6-FULL added `dead`). */
export const TERMINAL_JOB_STATUSES: readonly string[] = [
  'succeeded', 'failed', 'cancelled', 'unavailable', 'dead',
];

export function isTerminalJobStatus(status: string): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

/** How a job ended — null while still queued/running (no fabricated outcome). */
export type JobEndKind = 'succeeded' | 'failed' | 'dead' | 'cancelled' | 'unavailable';

export function jobEndKind(status: string): JobEndKind | null {
  return isTerminalJobStatus(status) ? (status as JobEndKind) : null;
}

// ─── Typed envelope → degraded descriptor ────────────────────────────────────

/**
 * The minimal structural shape of a typed API error. Duck-typed on purpose:
 * the real class is YouApiError (client/api.ts) but tests and future callers
 * only need these fields — this model never depends on the class itself.
 */
export interface TypedApiErrorLike {
  code?: string;
  message?: string;
  status?: number;
  /** Envelope `details` (unknown shape — read defensively, never trust). */
  details?: unknown;
  /** Retry guidance in ms, already derived by the client layer. */
  retryAfterMs?: number;
  guidance?: string;
}

/** What the degraded surface renders — every field is backend truth. */
export interface DegradedDescriptor {
  /** Which user-facing flow is degraded (e.g. "Twin reconstruction"). */
  path: string;
  /** The typed envelope code (service_unavailable / provider_unavailable). */
  code: string;
  /** The honest backend message (shown verbatim — never paraphrased into optimism). */
  reason: string;
  /** Which provider is degraded, when the envelope says so. */
  provider?: string;
  /** Breaker state at refusal time, when the envelope says so. */
  breakerState?: string;
  /** When it is reasonable to retry, in ms from when the error was received. */
  retryAfterMs?: number;
  /** Backend/operator guidance string, when present. */
  guidance?: string;
}

function detailsRecord(details: unknown): Record<string, unknown> | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  return details as Record<string, unknown>;
}

/**
 * Derive retryAfterMs from a raw error envelope: the typed
 * `details.retryAfterSeconds` wins; the `Retry-After` response header (in
 * seconds) is the fallback. Returns undefined when neither is a sane
 * positive number — an absent hint must not become a fabricated one.
 */
export function retryAfterMsFromEnvelope(
  details: unknown,
  retryAfterHeaderSeconds?: string | null,
): number | undefined {
  const d = detailsRecord(details);
  const fromDetails = d && typeof d.retryAfterSeconds === 'number'
    && Number.isFinite(d.retryAfterSeconds) && d.retryAfterSeconds > 0
    ? d.retryAfterSeconds * 1000
    : undefined;
  if (fromDetails !== undefined) return fromDetails;
  if (retryAfterHeaderSeconds !== undefined && retryAfterHeaderSeconds !== null) {
    const n = Number(retryAfterHeaderSeconds);
    if (Number.isFinite(n) && n > 0) return n * 1000;
  }
  return undefined;
}

/**
 * Map a thrown client error to a degraded descriptor — or null when the
 * error is NOT degradation (404s, validation, auth… stay ordinary errors;
 * never dress them up as provider outages, and never fabricate one).
 */
export function degradedFromApiError(err: unknown, path: string): DegradedDescriptor | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as TypedApiErrorLike;
  const code = typeof e.code === 'string' ? e.code : '';
  const status = typeof e.status === 'number' ? e.status : 0;
  const degraded = status === 503 || DEGRADED_CODES.includes(code);
  if (!degraded) return null;
  const d = detailsRecord(e.details);
  const provider = d && typeof d.provider === 'string' && d.provider ? d.provider : undefined;
  const breakerState = d && typeof d.breakerState === 'string' && d.breakerState ? d.breakerState : undefined;
  const retryAfterMs = typeof e.retryAfterMs === 'number' && Number.isFinite(e.retryAfterMs) && e.retryAfterMs > 0
    ? e.retryAfterMs
    : (d ? retryAfterMsFromEnvelope(d) : undefined);
  const guidance = typeof e.guidance === 'string' && e.guidance ? e.guidance : undefined;
  return {
    path,
    code: code || 'service_unavailable',
    reason: typeof e.message === 'string' && e.message ? e.message : 'the backend reported a degraded state',
    ...(provider !== undefined ? { provider } : {}),
    ...(breakerState !== undefined ? { breakerState } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(guidance !== undefined ? { guidance } : {}),
  };
}

// ─── Retry countdown math (pure; the .tsx owns the ticking timer) ────────────

/** Remaining full seconds of a cooldown: ceil, floored at 0, never negative. */
export function countdownSecondsFrom(retryAfterMs: number, receivedAtMs: number, nowMs: number): number {
  const remainingMs = receivedAtMs + retryAfterMs - nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / 1000);
}

/** Honest human label for a countdown in seconds (0 means "now"). */
export function formatRetrySeconds(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s === 0) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM ? `${h}h ${remM}m` : `${h}h`;
}

// ─── Dead-letter (terminal `dead` jobs) — UI explanation ─────────────────────

/**
 * Structural dead-letter payload (the parsed shape core/deadletter.ts owns).
 * Repeated here as a TYPE-only mirror so this zero-import module can shape
 * the UI explanation; parsing itself stays in core (single source of truth).
 */
export interface DeadLetterLike {
  code: string;
  attempts: number;
  stoppedBy: string;
  firstAttemptAt: string;
  lastErrorAt: string;
  lastError: string;
}

/** Operator-worded pointer to the dead-letter maintenance path (no links —
 *  dead-job replay/purge is an operator action, not a studio-user action). */
export const DEAD_LETTER_MAINTENANCE_POINTER =
  'This job was moved to the dead-letter queue after its bounded retry budget was exhausted. ' +
  'Operators can inspect and replay it from the maintenance console (GET /api/v1/maintenance/dead-jobs).';

export interface DeadJobExplanation {
  title: string;
  summary: string;
  /** The verbatim last error — shown honestly, never summarized away. */
  lastError: string;
  maintenance: string;
}

/** Derive the honest dead-job explanation the studio renders. */
export function deadJobExplanation(
  dead: DeadLetterLike,
  kindLabel: string,
): DeadJobExplanation {
  const attempts = Number.isFinite(dead.attempts) && dead.attempts > 0 ? dead.attempts : 0;
  const stoppedBy = dead.stoppedBy || 'unknown';
  return {
    title: `${kindLabel} is dead — retry budget exhausted`,
    summary: `It was retried ${attempts} time${attempts === 1 ? '' : 's'} before being stopped by "${stoppedBy}". Nothing is still running and no progress is being made.`,
    lastError: dead.lastError || 'the backend recorded no last error',
    maintenance: DEAD_LETTER_MAINTENANCE_POINTER,
  };
}
