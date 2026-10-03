// ═══════════════════════════════════════════════════════════════════════════
// YOU core — API error envelope + route wrapper (Worker A lane)
// Every route returns { error: { code, message } } with correct HTTP codes.
// Codes follow src/lib/you/contracts ERR map. No fake progress, no fake errors.
// ═══════════════════════════════════════════════════════════════════════════
import { ERR } from '../contracts';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
    /** Extra response headers (e.g. Retry-After on 429/503 envelopes). */
    public headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, ERR.VALIDATION, message, details);
export const unauthorized = (message = 'authentication required') =>
  new HttpError(401, ERR.UNAUTHENTICATED, message);
export const forbidden = (message = 'not allowed') =>
  new HttpError(403, ERR.FORBIDDEN, message);
export const consentRequired = (
  message = 'an active consent grant with the required scope is needed for this subject',
  details?: unknown,
) => new HttpError(403, ERR.CONSENT_REQUIRED, message, details);
export const serviceUnavailable = (
  message: string,
  details?: unknown,
  headers?: Record<string, string>,
) => new HttpError(503, ERR.SERVICE_UNAVAILABLE, message, details, headers);
export const notFound = (message = 'resource not found') =>
  new HttpError(404, ERR.NOT_FOUND, message);
export const conflict = (message: string, details?: unknown) =>
  new HttpError(409, ERR.CONFLICT, message, details);

/** Build the canonical error envelope. */
export function jsonError(
  code: string,
  message: string,
  status: number,
  details?: unknown,
  headers?: Record<string, string>,
): Response {
  return Response.json(
    { error: { code, message, ...(details !== undefined ? { details } : {}) } },
    { status, ...(headers ? { headers } : {}) },
  );
}

/**
 * Wrap a route handler body: HttpError → its envelope; unknown throw → 500
 * internal_error with the honest message (never swallow real errors).
 */
export async function handleRoute(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonError(err.code, err.message, err.status, err.details, err.headers);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('[you/api] unhandled route error:', message);
    return jsonError(ERR.INTERNAL, message, 500);
  }
}

/** Parse a JSON request body defensively; `{}` when no body was sent. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const ct = request.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    const text = await request.text().catch(() => '');
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw badRequest('request body is not valid JSON');
    }
  }
  try {
    const parsed = await request.json();
    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw badRequest('request body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw badRequest('request body is not valid JSON');
  }
}

/** Idempotency-Key header (client sends `x-idempotency-key`). */
export function getIdempotencyKey(request: Request): string | undefined {
  const v = request.headers.get('x-idempotency-key');
  return v && v.trim() ? v.trim() : undefined;
}

// ─── small body validators (honest 400s, no schema lib needed) ───────────────

export function reqString(body: Record<string, unknown>, field: string, opts?: { max?: number }): string {
  const v = body[field];
  if (typeof v !== 'string' || !v.trim()) {
    throw badRequest(`field "${field}" is required (non-empty string)`);
  }
  const trimmed = v.trim();
  if (opts?.max && trimmed.length > opts.max) {
    throw badRequest(`field "${field}" exceeds ${opts.max} characters`);
  }
  return trimmed;
}

export function optString(body: Record<string, unknown>, field: string, opts?: { max?: number }): string | undefined {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw badRequest(`field "${field}" must be a string`);
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  if (opts?.max && trimmed.length > opts.max) {
    throw badRequest(`field "${field}" exceeds ${opts.max} characters`);
  }
  return trimmed;
}

export function reqStringArray(body: Record<string, unknown>, field: string): string[] {
  const v = body[field];
  if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'string' || !x.trim())) {
    throw badRequest(`field "${field}" must be a non-empty array of strings`);
  }
  return (v as string[]).map((x) => x.trim());
}

export function optStringArray(body: Record<string, unknown>, field: string): string[] | undefined {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) {
    throw badRequest(`field "${field}" must be an array of strings`);
  }
  return (v as string[]).map((x) => x.trim());
}

export function optNumber(body: Record<string, unknown>, field: string): number | undefined {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw badRequest(`field "${field}" must be a number`);
  return v;
}
