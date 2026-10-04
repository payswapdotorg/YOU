// POST /api/v1/develop/playground/execute — the API playground's EXECUTE
// action (P6.B9, Worker B lane).
//
// Executes a FROZEN-INVENTORY operation against the REAL API on this origin,
// with the CALLER's session auth forwarded verbatim:
//   body: {
//     method:  "get" | "post" | "put" | "patch" | "delete",
//     path:    "/twins/{id}/compile"   (frozen spec path, verbatim),
//     pathParams: { id: "twin_…" },
//     query:     { key: "value" },     (optional, string values only),
//     body:      "…JSON text…",       (optional; post/put/patch only),
//     mutationAcknowledged: true,      (REQUIRED for any non-GET — the
//                                      "I understand this mutates" gate,
//                                      enforced HERE at the API level),
//     sandbox:   true                  (optional; refused honestly when the
//                                      sandbox mode is unavailable)
//   }
//
// Honesty laws:
// - the operation must be in the frozen inventory (no arbitrary paths, no
//   proxy-to-anywhere; path params are single segments — /storage/{key} is
//   the one documented catch-all);
// - mutations (non-GET) execute ONLY with mutationAcknowledged === true —
//   a typed 400 otherwise, with NO side effect;
// - a requested sandbox execute routes through the deterministic fixtures
//   seam WHEN PRESENT; today nothing registers it, so the honest answer is
//   a typed 409 sandbox_unavailable — never a fabricated response;
// - the response envelope carries the REAL inner status/statusText/headers/
//   body/duration; set-cookie is dropped (session tokens never render in
//   the response viewer); the inner x-request-id is preserved for support.
//
// NEW ROUTE, FLAGGED for the TL per the freeze law: this path is not yet in
// contracts/openapi/v1/openapi.yaml — the TL extends the freeze on merge
// (the P6.B6 artifacts-route precedent).
import { randomUUID } from 'crypto';
import { requireApiAuth } from '@/lib/you/core/auth';
import { badRequest, conflict, handleRoute, readJsonBody } from '@/lib/you/core/errors';
import { enforceRateLimit } from '@/lib/you/core/ratelimit';
import {
  type PlaygroundMethod,
  findOperation,
  isMutationMethod,
  operationExecutable,
  resolveSpecPath,
} from '@/lib/you/develop/playground-ops';
import {
  PLAYGROUND_SANDBOX_ENV_VAR,
  playgroundFixtures,
  playgroundFixturesPresent,
  resolveSandboxMode,
} from '@/lib/you/develop/sandbox';

const METHODS: readonly PlaygroundMethod[] = ['get', 'post', 'put', 'patch', 'delete'];
const MAX_BODY_BYTES = 262_144; // 256 KiB response-body cap for the viewer

function asStringRecord(v: unknown, field: string): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw badRequest(`field "${field}" must be an object of strings`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== 'string') throw badRequest(`field "${field}.${k}" must be a string`);
    out[k] = val;
  }
  return out;
}

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);

    // The playground proxy gets a conservative explicit ceiling (the A6
    // interim limiter — rule passed inline, no shared-bucket edit).
    enforceRateLimit('playground-execute', auth.tenantId, { limit: 60, windowMs: 60_000 });

    const payload = await readJsonBody(request);

    const methodRaw = typeof payload.method === 'string' ? payload.method.trim().toLowerCase() : '';
    if (!METHODS.includes(methodRaw as PlaygroundMethod)) {
      throw badRequest('field "method" must be one of get | post | put | patch | delete');
    }
    const method = methodRaw as PlaygroundMethod;

    if (typeof payload.path !== 'string' || !payload.path.trim()) {
      throw badRequest('field "path" is required (a frozen spec path, e.g. "/twins/{id}/compile")');
    }
    const op = findOperation(method, payload.path.trim());
    if (!op) {
      throw badRequest(`unknown operation "${method.toUpperCase()} ${payload.path.trim()}" — the playground executes only the frozen v1 inventory`);
    }

    const exec = operationExecutable(op);
    if (!exec.executable) {
      throw badRequest(`operation "${method.toUpperCase()} ${op.path}" is not executable from the JSON playground: ${exec.reason}`);
    }

    const pathParams = asStringRecord(payload.pathParams, 'pathParams');
    const resolved = resolveSpecPath(op.path, pathParams);
    if (!resolved.ok) throw badRequest(resolved.error);

    const query = asStringRecord(payload.query, 'query');
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      const value = v.trim();
      if (value) search.set(k, value);
    }

    // ── mutation confirmation (API-level, per call) ────────────────────────
    const mutation = isMutationMethod(method);
    const acknowledged = payload.mutationAcknowledged === true;
    if (mutation && !acknowledged) {
      throw badRequest(
        `${method.toUpperCase()} ${op.path} mutates data — set mutationAcknowledged: true after the explicit per-call confirmation`,
        { reason: 'mutation_confirmation_required', method: method.toUpperCase(), path: op.path },
      );
    }

    // ── request body (JSON text; validated before executing) ──────────────
    let bodyText: string | undefined;
    if (typeof payload.body === 'string' && payload.body.trim()) {
      if (method === 'get' || method === 'delete') {
        throw badRequest(`field "body" is not accepted for ${method.toUpperCase()} operations`);
      }
      try {
        JSON.parse(payload.body);
      } catch {
        throw badRequest('field "body" is not valid JSON');
      }
      bodyText = payload.body;
    }

    // ── sandbox routing (fail-closed, honest) ──────────────────────────────
    const sandboxState = resolveSandboxMode({ raw: process.env[PLAYGROUND_SANDBOX_ENV_VAR] }, playgroundFixturesPresent());
    const wantsSandbox = payload.sandbox === true;
    if (wantsSandbox) {
      if (!sandboxState.available) {
        throw conflict(`sandbox mode is unavailable — ${sandboxState.reason}`, {
          reason: 'sandbox_unavailable',
          sandbox: sandboxState,
        });
      }
      const fixtures = playgroundFixtures();
      if (!fixtures) {
        // Defensive twin of the availability check (fail-closed either way).
        throw conflict('sandbox mode is unavailable — the deterministic fixtures seam disappeared', {
          reason: 'sandbox_unavailable',
          sandbox: sandboxState,
        });
      }
      return await fixtures({ method: method.toUpperCase(), specPath: op.path, resolvedPath: resolved.path, query, body: bodyText });
    }

    // ── LIVE execution: the real API, this origin, the caller's auth ───────
    const origin = new URL(request.url).origin;
    const target = new URL(`/api/v1${resolved.path}${search.toString() ? `?${search.toString()}` : ''}`, origin);

    const headers: Record<string, string> = {};
    const cookie = request.headers.get('cookie');
    if (cookie) headers.cookie = cookie;
    const authorization = request.headers.get('authorization');
    if (authorization) headers.authorization = authorization;
    if (bodyText) headers['content-type'] = 'application/json';
    if (mutation) headers['x-idempotency-key'] = randomUUID();

    const startedAt = performance.now();
    let inner: Response;
    try {
      inner = await fetch(target, {
        method: method.toUpperCase(),
        headers,
        ...(bodyText ? { body: bodyText } : {}),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw conflict(`the real API call failed at the transport level: ${message}`, { reason: 'upstream_unreachable' });
    }
    const durationMs = Math.round(performance.now() - startedAt);

    let text = await inner.text();
    let truncated = false;
    if (text.length > MAX_BODY_BYTES) {
      text = text.slice(0, MAX_BODY_BYTES);
      truncated = true;
    }

    const responseHeaders: { name: string; value: string }[] = [];
    inner.headers.forEach((value, name) => {
      if (name.toLowerCase() === 'set-cookie') return; // session tokens never render in the viewer
      responseHeaders.push({ name, value });
    });

    return Response.json({
      operation: { method: method.toUpperCase(), path: op.path },
      resolvedPath: resolved.path + (search.toString() ? `?${search.toString()}` : ''),
      sandbox: false,
      status: inner.status,
      statusText: inner.statusText,
      durationMs,
      headers: responseHeaders,
      body: text,
      ...(truncated ? { bodyTruncated: true } : {}),
    });
  });
}
