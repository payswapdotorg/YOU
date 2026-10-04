// ═══════════════════════════════════════════════════════════════════════════
// YOU Develop — API playground operation inventory (P6.B9, Worker B lane).
//
// THE FROZEN v1 INVENTORY, VERBATIM. This array is generated from
// contracts/openapi/v1/openapi.yaml (the frozen contract surface — 106
// operations at the P6.B9 base) with the same text-parsing algorithm the
// contract-freeze gate uses (scripts/check-contracts-freeze.mjs §2), and
// tests/contract/b9-docs-playground.test.mjs asserts set equality against
// the spec on every run — the playground can never drift from the freeze.
//
// The frozen spec declares NO OpenAPI `tags:` — grouping here is DERIVED,
// deterministically, from the first path segment (tagOf), because the order
// asked for "grouped by tag (from the OpenAPI inventory)" and path-prefix
// grouping is the only derivation the inventory itself supports. Disclosed.
//
// Zero imports (pure module — the node:test law): importable from server
// routes, client components and contract tests alike.
// ═══════════════════════════════════════════════════════════════════════════

export type PlaygroundMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface PlaygroundOperation {
  /** Frozen spec method (lowercase, as written in openapi.yaml). */
  method: PlaygroundMethod;
  /** Frozen spec path, verbatim — e.g. "/twins/{id}/compile". */
  path: string;
  /** Summary line from the frozen spec (display only, never parsed). */
  summary: string;
}

export const PLAYGROUND_OPERATIONS: readonly PlaygroundOperation[] = [
  { method: "post", path: "/agent-avatar-sessions", summary: "Agent avatar sessions" },
  { method: "delete", path: "/agent-avatar-sessions/{id}", summary: "Agent avatar sessions item" },
  { method: "get", path: "/agent-avatar-sessions/{id}", summary: "Agent avatar sessions item" },
  { method: "post", path: "/agent-avatar-sessions/{id}/events", summary: "Agent avatar sessions — emit event" },
  { method: "get", path: "/agent-bodies", summary: "Agent bodies" },
  { method: "post", path: "/agent-bodies", summary: "Agent bodies" },
  { method: "post", path: "/agent-bodies/{id}/possessions", summary: "Agent bodies — attach possession" },
  { method: "get", path: "/agent-souls", summary: "Agent souls" },
  { method: "get", path: "/agent/bodies", summary: "Agent runtime bodies (P6.C6 production runtime)" },
  { method: "post", path: "/agent/bodies", summary: "Agent runtime bodies — create (draft; activate via PATCH)" },
  { method: "get", path: "/agent/bodies/{id}", summary: "Agent runtime bodies item (with immutable version snapshots)" },
  { method: "patch", path: "/agent/bodies/{id}", summary: "Agent runtime bodies — lifecycle action or versioned definition update" },
  { method: "get", path: "/agent/providers", summary: "Agent provider registry surface — available/unavailable + reason per provider (fail-closed; P6.B7)" },
  { method: "get", path: "/agent/sessions", summary: "Agent runtime sessions — list (newest first, bounded)" },
  { method: "post", path: "/agent/sessions", summary: "Agent runtime sessions — bind (Twin, Body, Soul) with consent provenance" },
  { method: "delete", path: "/agent/sessions/{id}", summary: "Agent runtime sessions — explicit teardown (live → ended; idempotent)" },
  { method: "get", path: "/agent/sessions/{id}", summary: "Agent runtime sessions item — real turn history with honest job-status join" },
  { method: "post", path: "/agent/sessions/{id}/interrupt", summary: "Interrupt a running agent session turn (honest interrupted state; P6.B7)" },
  { method: "post", path: "/agent/sessions/{id}/turns", summary: "Agent runtime sessions — submit a chat turn (durable agent.turn job; consent re-verified)" },
  { method: "get", path: "/agent/souls", summary: "Agent runtime souls (P6.C6 production runtime)" },
  { method: "post", path: "/agent/souls", summary: "Agent runtime souls — create (draft; activate via PATCH)" },
  { method: "get", path: "/agent/souls/{id}", summary: "Agent runtime souls item (with immutable version snapshots)" },
  { method: "patch", path: "/agent/souls/{id}", summary: "Agent runtime souls — lifecycle action or versioned definition update" },
  { method: "get", path: "/api-keys", summary: "API keys" },
  { method: "post", path: "/api-keys", summary: "API keys" },
  { method: "delete", path: "/api-keys/{id}", summary: "API keys item" },
  { method: "post", path: "/api-keys/{id}/rotate", summary: "API keys — rotate secret in place" },
  { method: "get", path: "/artifacts", summary: "Solution artifacts list — filter by twinVersionId/renderJobId/type/performanceId (P6.B6)" },
  { method: "get", path: "/artifacts/{id}", summary: "Solution artifacts item" },
  { method: "get", path: "/captures", summary: "Capture sessions" },
  { method: "get", path: "/captures/{id}", summary: "Capture sessions item" },
  { method: "post", path: "/captures/{id}/assets", summary: "Capture sessions — attach assets" },
  { method: "post", path: "/captures/{id}/complete", summary: "Capture sessions — complete" },
  { method: "delete", path: "/captures/{id}/f1", summary: "F1 guided capture flow — delete session honoring retention policy (P6.B3)" },
  { method: "post", path: "/captures/{id}/f1/complete", summary: "F1 guided capture flow — complete + content-addressed manifest (P6.B3)" },
  { method: "get", path: "/captures/{id}/f1/export", summary: "F1 guided capture flow — evidence export (P6.B3)" },
  { method: "post", path: "/captures/{id}/f1/review", summary: "F1 guided capture flow — review → TwinVersion promotion (P6.B3)" },
  { method: "post", path: "/captures/{id}/f1/steps/{stepId}/skip", summary: "F1 guided capture flow — skip step with reason (P6.B3)" },
  { method: "post", path: "/captures/{id}/f1/steps/{stepId}/submit", summary: "F1 guided capture flow — submit step asset (consent-gated, P6.B3)" },
  { method: "post", path: "/captures/{id}/reconstruct", summary: "Capture sessions — F1 reconstruction (consent-gated, P6.C4)" },
  { method: "get", path: "/consent-grants", summary: "Consent grants" },
  { method: "post", path: "/consent-grants", summary: "Consent grants" },
  { method: "delete", path: "/consent-grants/{id}", summary: "Consent grants item" },
  { method: "get", path: "/develop/playground", summary: "Develop playground — sandbox status + frozen-inventory count (P6.B9)" },
  { method: "post", path: "/develop/playground/execute", summary: "Develop playground — execute an operation against the real API (mutation-confirmation gated, rate-limited; P6.B9)" },
  { method: "get", path: "/events", summary: "Events" },
  { method: "get", path: "/evidence-requests", summary: "Evidence requests" },
  { method: "post", path: "/evidence-requests", summary: "Evidence requests" },
  { method: "post", path: "/evidence-requests/{id}/fulfill", summary: "Evidence requests — fulfill" },
  { method: "get", path: "/evidence/{id}/url", summary: "Evidence URLs — signed URL" },
  { method: "get", path: "/exports", summary: "Game/AR exports — list export jobs with honest claims text (P6.C9)" },
  { method: "post", path: "/exports", summary: "Game/AR exports — create GLB/VRM export (reconstruct-scope consent, durable export.glb/export.vrm job, idempotent replay; P6.C9)" },
  { method: "get", path: "/exports/{id}", summary: "Game/AR exports — job detail + artifact bundle (GLB/VRM signed URL, retargeting mapping, structural-vs-derived manifest, honest package manifest; P6.C9)" },
  { method: "post", path: "/feedback", summary: "Feedback" },
  { method: "get", path: "/health", summary: "Health — unauthenticated liveness + readiness (db probe)" },
  { method: "get", path: "/jobs/{id}", summary: "Jobs item" },
  { method: "get", path: "/lab/failures", summary: "lab — failure catalogue" },
  { method: "get", path: "/lab/objectives", summary: "lab — objectives" },
  { method: "post", path: "/lab/objectives", summary: "lab — objectives" },
  { method: "get", path: "/lab/pipelines", summary: "lab — pipelines" },
  { method: "get", path: "/lab/promotions", summary: "lab — promotions" },
  { method: "post", path: "/lab/runs", summary: "lab — runs" },
  { method: "get", path: "/lab/runs/{id}", summary: "lab item" },
  { method: "get", path: "/lab/technologies", summary: "lab — technologies" },
  { method: "get", path: "/live-sessions", summary: "Live sessions — list (P6.C7 realtime path; consent-scoped)" },
  { method: "post", path: "/live-sessions", summary: "Live sessions — create (consent-enforced, returns signaling token; P6.C7)" },
  { method: "get", path: "/live-sessions/{id}", summary: "Live session detail (signaling state; P6.C7)" },
  { method: "post", path: "/live-sessions/{id}/end", summary: "End a live session (terminal; P6.C7)" },
  { method: "get", path: "/live-sessions/{id}/signal", summary: "Live signaling — poll relayed SDP/ICE (HTTP polling v1; P6.C7)" },
  { method: "post", path: "/live-sessions/{id}/signal", summary: "Live signaling — relay SDP offer/answer + ICE candidates (honest 409 on wrong state; P6.C7)" },
  { method: "post", path: "/live-sessions/{id}/state", summary: "Live performance state events (idempotent, bounded ring; P6.C7)" },
  { method: "get", path: "/maintenance/dead-jobs", summary: "Maintenance — list dead-lettered jobs (operator session)" },
  { method: "post", path: "/maintenance/dead-jobs", summary: "Maintenance — replay or purge dead-lettered jobs (operator session)" },
  { method: "post", path: "/maintenance/expire-evidence-requests", summary: "Maintenance — expire open evidence requests past the TTL (P6.B5; active fulfillment captures are skipped)" },
  { method: "post", path: "/maintenance/gc-storage", summary: "Maintenance — sweep unreferenced storage objects (durable job)" },
  { method: "get", path: "/maintenance/provider-breaker", summary: "Maintenance — provider circuit-breaker state snapshot (operator session)" },
  { method: "post", path: "/maintenance/provider-breaker", summary: "Maintenance — reset or trip a provider circuit breaker (operator session)" },
  { method: "get", path: "/metrics", summary: "Operational metrics — retry/dead-job/breaker/rate-limit counters (operator session)" },
  { method: "get", path: "/overview", summary: "Overview" },
  { method: "get", path: "/performances", summary: "Performances" },
  { method: "post", path: "/performances", summary: "Performances" },
  { method: "get", path: "/performances/{id}", summary: "Performances item" },
  { method: "post", path: "/performances/from-text", summary: "Performances — create from text" },
  { method: "get", path: "/renders", summary: "Renders" },
  { method: "post", path: "/renders", summary: "Renders" },
  { method: "get", path: "/renders/{id}", summary: "Renders item" },
  { method: "get", path: "/session", summary: "Client session" },
  { method: "post", path: "/session", summary: "Client session" },
  { method: "get", path: "/storage/{key}", summary: "Storage read-through item" },
  { method: "get", path: "/subjects/{id}/export", summary: "Subjects — portable data export (rows + expiring evidence capabilities)" },
  { method: "get", path: "/templates", summary: "Templates" },
  { method: "post", path: "/templates", summary: "Templates" },
  { method: "get", path: "/templates/{id}", summary: "Templates item" },
  { method: "post", path: "/templates/{id}/analyze", summary: "Templates — analyze" },
  { method: "get", path: "/try-on", summary: "Virtual try-on — list try-on jobs (consent-enforced; P6.C8)" },
  { method: "post", path: "/try-on", summary: "Virtual try-on — create try-on render (durable tryon.render job, idempotent; P6.C8)" },
  { method: "get", path: "/try-on/{id}", summary: "Virtual try-on — job detail + comparison artifact with signed URLs (P6.C8)" },
  { method: "get", path: "/try-on/garments", summary: "Try-on garments — list garment assets (P6.C8)" },
  { method: "post", path: "/try-on/garments", summary: "Try-on garments — multipart garment upload (content-addressed, merchant provenance; P6.C8)" },
  { method: "get", path: "/try-on/garments/{id}", summary: "Try-on garments — garment detail (P6.C8)" },
  { method: "get", path: "/twins", summary: "Twins" },
  { method: "post", path: "/twins", summary: "Twins" },
  { method: "delete", path: "/twins/{id}", summary: "Twins item" },
  { method: "get", path: "/twins/{id}", summary: "Twins item" },
  { method: "post", path: "/twins/{id}/capture-sessions", summary: "Twins — capture-sessions" },
  { method: "post", path: "/twins/{id}/capture-sessions/f1", summary: "F1 guided capture session — create (consent-gated, P6.B3)" },
  { method: "post", path: "/twins/{id}/compile", summary: "Twins — compile" },
  { method: "get", path: "/twins/{id}/deficiencies", summary: "Twin deficiency report — per-capability honest states (ok/deficient/unknown) with sources and remedy payloads (P6.B4)" },
  { method: "get", path: "/twins/{id}/versions", summary: "Twins — list versions" },
  { method: "get", path: "/usage", summary: "Usage metering" },
  { method: "get", path: "/verification-sessions", summary: "Verification sessions" },
  { method: "post", path: "/verification-sessions", summary: "Verification sessions" },
  { method: "get", path: "/verification-sessions/{id}", summary: "Verification sessions item" },
  { method: "post", path: "/verification-sessions/{id}/evaluate", summary: "Verification sessions — evaluate" },
  { method: "post", path: "/verification-sessions/{id}/evidence", summary: "Verification sessions — attach evidence" },
  { method: "get", path: "/webhooks", summary: "Webhooks" },
  { method: "post", path: "/webhooks", summary: "Webhooks" },
  { method: "delete", path: "/webhooks/{id}", summary: "Webhooks item" },
];

// ─── derived surfaces ────────────────────────────────────────────────────────

/** Deterministic tag derivation from the frozen spec paths (no `tags:` exist). */
export function tagOf(path: string): string {
  const seg = path.split('/')[1] ?? '';
  return seg || 'root';
}

/** Human label for a derived tag (display only). */
export function tagLabel(tag: string): string {
  return tag
    .split('-')
    .map((w) => (w === 'api' ? 'API' : w === 'lab' ? 'Lab' : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** The ordered, unique tag list covering the whole inventory. */
export const PLAYGROUND_TAGS: readonly string[] = [...new Set(PLAYGROUND_OPERATIONS.map((o) => tagOf(o.path)))].sort();

/** GET is read-only; everything else mutates (the playground's confirmation law). */
export function isMutationMethod(method: PlaygroundMethod): boolean {
  return method !== 'get';
}

/** Canonical key of an operation ("method /spec/path"). */
export function operationKey(method: PlaygroundMethod, path: string): string {
  return `${method} ${path}`;
}

/**
 * Operations whose request body is multipart file upload — the JSON playground
 * cannot build them honestly. EXECUTE refuses them with the documented reason
 * instead of silently sending a malformed request. Derived from the real
 * routes' body parsing (captures/[id]/assets, captures/[id]/f1/steps/[stepId]/submit).
 */
const MULTIPART_OPS: ReadonlySet<string> = new Set([
  'post /captures/{id}/assets',
  'post /captures/{id}/f1/steps/{stepId}/submit',
]);

/** Look up a frozen operation exactly (method + spec path). */
export function findOperation(method: PlaygroundMethod, path: string): PlaygroundOperation | null {
  const m = method.toLowerCase() as PlaygroundMethod;
  return PLAYGROUND_OPERATIONS.find((o) => o.method === m && o.path === path) ?? null;
}

/** Honest executability of an operation from the JSON playground. */
export function operationExecutable(op: PlaygroundOperation): { executable: boolean; reason?: string } {
  if (MULTIPART_OPS.has(operationKey(op.method, op.path))) {
    return {
      executable: false,
      reason: 'multipart asset upload — build it with the Studio Captures view or a curl -F request, not the JSON playground',
    };
  }
  return { executable: true };
}

/**
 * Known query parameter names per frozen operation (pre-seeded request-builder
 * hints from the real client surface — the frozen spec declares no parameter
 * schemas, so the builder stays free-form beyond these hints).
 */
export const QUERY_HINTS: Readonly<Record<string, readonly string[]>> = {
  'get /events': ['type', 'limit'],
  'get /evidence-requests': ['status', 'capability'],
  'get /maintenance/dead-jobs': ['limit'],
  'get /live-sessions/{id}/signal': ['since'],
  'get /twins/{id}/deficiencies': ['versionId', 'baselineVersionId'],
};

// ─── path resolution ──────────────────────────────────────────────────────────

export type PathParamValues = Record<string, string>;

export type ResolvePathResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * Substitute {param} placeholders with concrete values under the honest rules:
 * - every placeholder must be provided (non-empty after trim);
 * - a value may not traverse ('..' segments) or smuggle query/fragment syntax;
 * - placeholder segments are single path segments — '/' is only allowed for a
 *   trailing catch-all ({key} of /storage/{key}, the one multi-segment param);
 * - the result must contain no leftover brace (unsubstituted placeholder).
 */
export function resolveSpecPath(specPath: string, params: PathParamValues): ResolvePathResult {
  const placeholders = [...specPath.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]);
  const unique = [...new Set(placeholders)];
  for (const name of unique) {
    const raw = params[name];
    if (typeof raw !== 'string' || !raw.trim()) {
      return { ok: false, error: `path parameter "${name}" is required` };
    }
    const value = raw.trim();
    const isCatchAll = specPath.endsWith(`{${name}}`) && specPath.startsWith('/storage/');
    if (value.includes('..')) {
      return { ok: false, error: `path parameter "${name}" must not contain ".."` };
    }
    if (!isCatchAll && value.includes('/')) {
      return { ok: false, error: `path parameter "${name}" must be a single path segment (no "/")` };
    }
    if (/[?#]/.test(value)) {
      return { ok: false, error: `path parameter "${name}" must not contain "?" or "#"` };
    }
    if (!/^[\x21-\x7E]+$/.test(value)) {
      return { ok: false, error: `path parameter "${name}" must be printable ASCII without spaces` };
    }
  }
  let resolved = specPath;
  for (const name of unique) {
    resolved = resolved.replaceAll(`{${name}}`, encodeURIComponent(params[name].trim()).replaceAll('%2F', '/'));
  }
  if (/\{[a-zA-Z0-9_]+\}/.test(resolved)) {
    return { ok: false, error: 'unsubstituted path parameter remained' };
  }
  return { ok: true, path: resolved };
}
