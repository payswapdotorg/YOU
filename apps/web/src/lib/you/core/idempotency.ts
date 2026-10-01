// ═══════════════════════════════════════════════════════════════════════════
// YOU core — idempotency body-fingerprint binding (Worker A lane, W4.A F-01)
//
// Contract (TL-adjudicated, W4.A): a replay with the same X-Idempotency-Key
// and the SAME body returns the existing record (200 template / 202 jobId);
// a replay with the same key but a DIFFERENT body returns
// 409 `idempotency_conflict` — the existing record is NEVER returned for a
// different payload. Fingerprints are sha256 over the canonical JSON body
// (stable key order), so trivially-equivalent JSON (reordered keys) replays
// cleanly while any semantic change conflicts.
//
// Storage note: no schema change — the fingerprint is DERIVED at replay time
// from what the idempotency record already persists (the Template row's
// normalized create projection; the Job row's stored `input` JSON).
// ═══════════════════════════════════════════════════════════════════════════
import { createHash } from 'crypto';
import { HttpError } from './errors';

/** Stable machine code for the 409 body-mismatch replay (API_CONTRACTS §API rules). */
export const IDEMPOTENCY_CONFLICT_CODE = 'idempotency_conflict';

/**
 * Canonical JSON serialization: object keys sorted lexicographically (stable
 * key order), arrays keep their order, `undefined` object members are dropped
 * (they are not representable in JSON). Two JSON bodies that differ only in
 * key order canonicalize identically.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** sha256 hex digest of the canonical JSON form — the body fingerprint. */
export function bodyFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** 409 idempotency_conflict error naming the key and both fingerprints. */
export function idempotencyConflictError(
  key: string,
  context: string,
  storedFingerprint: string,
  receivedFingerprint: string,
): HttpError {
  return new HttpError(
    409,
    IDEMPOTENCY_CONFLICT_CODE,
    `idempotency key "${key}" was already used with a different ${context} — ` +
      `the existing record is bound to body fingerprint sha256:${storedFingerprint}, ` +
      `this request carries sha256:${receivedFingerprint}; ` +
      `replay the original body or use a new idempotency key`,
  );
}

/**
 * Compare the stored payload's fingerprint with the received one and throw
 * the 409 idempotency_conflict envelope on mismatch (no-op when equal).
 */
export function assertSameBodyFingerprint(
  key: string,
  context: string,
  storedPayload: unknown,
  receivedPayload: unknown,
): void {
  const storedFingerprint = bodyFingerprint(storedPayload);
  const receivedFingerprint = bodyFingerprint(receivedPayload);
  if (storedFingerprint !== receivedFingerprint) {
    throw idempotencyConflictError(key, context, storedFingerprint, receivedFingerprint);
  }
}
