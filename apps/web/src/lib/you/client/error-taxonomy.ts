// ═══════════════════════════════════════════════════════════════════════════
// YOU client — error taxonomy (Worker B lane, P6.B8).
//
// Pure UI-side classification of client API errors into honest, actionable
// classes. Consumes the typed YouApiError envelope (client/api.ts) and maps:
//
//   rate-limited   429 / rate_limited            → "backoff active" + window
//   provider-down  503 / service_unavailable /
//                  provider_unavailable          → DegradedState surface
//   validation     400 / validation_failed       → fix-your-input guidance
//   consent        403 / consent_required        → grant the missing scope
//   auth           401/403 / unauthenticated,
//                  forbidden                     → session/permission truth
//   not-found      404 / not_found               → the id is real-shaped but
//                                                  absent (never "provider down")
//   conflict       409 / conflict                → state changed underneath
//   unknown        anything else                 → HONEST "unknown" — no
//                                                  misleading guesses
//
// The class drives WHICH surface renders (degraded-state.tsx) and WHAT the
// toasts say (describeApiError). Nothing here fabricates causes: an error
// without a recognizable envelope is "unknown" by construction.
//
// IMPORT SHAPE: ZERO runtime imports — this module is directly importable
// by node:test unit suites under Node >= 23.6 type stripping, same pattern as
// core/circuit-breaker.ts and client/degraded.ts. (It deliberately does NOT
// import degraded.ts: extensionless relative imports do not resolve under
// node ESM. The degraded DESCRIPTOR is derived by the consumer via
// degraded.ts's degradedFromApiError — the taxonomy only classifies.)
// ═══════════════════════════════════════════════════════════════════════════

/** Honest error classes the Studio can act on (order = specificity). */
export type ApiErrorKind =
  | 'rate-limited'
  | 'provider-down'
  | 'validation'
  | 'consent'
  | 'auth'
  | 'not-found'
  | 'conflict'
  | 'unknown';

/** Structural shape needed to classify (duck-typed — tests avoid the class). */
interface ClassifiableErrorLike {
  code?: string;
  message?: string;
  status?: number;
  retryAfterMs?: number;
}

/** The classification result — every field is derived, none invented. */
export interface ApiErrorClassification {
  kind: ApiErrorKind;
  /** Short actionable headline (e.g. "Rate-limited — backoff active"). */
  title: string;
  /** The honest detail line (backend message verbatim when present). */
  detail: string;
  /** Retry window in ms when the error carried one (429/503 envelopes). */
  retryAfterMs?: number;
}

function asClassifiable(err: unknown): ClassifiableErrorLike | null {
  if (!err || typeof err !== 'object') return null;
  return err as ClassifiableErrorLike;
}

/**
 * Classify a client API error. Pure: same error in, same classification out.
 * Unknown stays honestly unknown — never dressed up as a provider outage.
 */
export function classifyApiError(err: unknown): ApiErrorClassification {
  const e = asClassifiable(err);
  const code = e && typeof e.code === 'string' ? e.code : '';
  const status = e && typeof e.status === 'number' ? e.status : 0;
  const message = e && typeof e.message === 'string' && e.message ? e.message : '';
  const retryAfterMs = e && typeof e.retryAfterMs === 'number'
    && Number.isFinite(e.retryAfterMs) && e.retryAfterMs > 0
    ? e.retryAfterMs
    : undefined;

  // provider-down (degraded) — the ONLY class that fabricates nothing about
  // cause: the backend's typed envelope says the provider is unavailable.
  if (status === 503 || code === 'service_unavailable' || code === 'provider_unavailable') {
    return {
      kind: 'provider-down',
      title: 'Provider cooling down',
      detail: message || 'the backend reported a degraded state',
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }

  if (status === 429 || code === 'rate_limited') {
    return {
      kind: 'rate-limited',
      title: 'Rate-limited — backoff active',
      detail: message || 'too many requests in the current window; the limit resets on its own',
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }

  if (status === 400 || code === 'validation_failed') {
    return {
      kind: 'validation',
      title: 'Check your input',
      detail: message || 'the request was rejected as invalid',
    };
  }

  if (code === 'consent_required') {
    return {
      kind: 'consent',
      title: 'Consent required',
      detail: message || 'an active consent grant with the required scope is needed',
    };
  }

  if (status === 401 || code === 'unauthenticated' || status === 403 || code === 'forbidden') {
    return {
      kind: 'auth',
      title: 'Not allowed',
      detail: message || 'this action requires a session with the right permissions',
    };
  }

  if (status === 404 || code === 'not_found') {
    return {
      kind: 'not-found',
      title: 'Not found',
      detail: message || 'the requested resource does not exist (it may have been deleted)',
    };
  }

  if (status === 409 || code === 'conflict') {
    return {
      kind: 'conflict',
      title: 'State changed underneath',
      detail: message || 'the resource changed since you loaded it — refresh and retry',
    };
  }

  return {
    kind: 'unknown',
    title: 'Something failed — cause unknown',
    detail: message || 'the request failed without a recognizable error envelope; no cause is being guessed',
  };
}

/**
 * One-line honest description for toasts: class hint first (so users can tell
 * rate-limiting from provider trouble at a glance), then the backend message.
 */
export function describeApiError(err: unknown): string {
  const c = classifyApiError(err);
  const retry = c.retryAfterMs !== undefined ? ` — retry in ${Math.max(1, Math.ceil(c.retryAfterMs / 1000))}s` : '';
  switch (c.kind) {
    case 'rate-limited':
      return `Rate-limited (backoff active)${retry} — ${c.detail}`;
    case 'provider-down':
      return `Provider cooling down${retry} — ${c.detail}`;
    case 'validation':
      return `Invalid input — ${c.detail}`;
    case 'consent':
      return `Consent required — ${c.detail}`;
    case 'auth':
      return `Not allowed — ${c.detail}`;
    case 'not-found':
      return `Not found — ${c.detail}`;
    case 'conflict':
      return `Conflict — ${c.detail}`;
    default:
      return `Unknown failure — ${c.detail}`;
  }
}
