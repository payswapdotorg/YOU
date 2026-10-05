// YOU Studio API client (TL-owned). Worker B consumes; Worker A implements
// the server routes to match exactly. Drift = integration bug.
import type {
  AgentAvatarSessionView, AgentBodyView, AgentSoulView, ApiKeySecret, ApiKeyView,
  BenchmarkRunView, CaptureSessionView, ConsentGrantView, EventRecordView,
  EvidenceAssetView, EvidenceRequestView, FailureAtlasView, FailureCaseView, FeedbackRequestView,
  F1ConsentStatements, F1EvidenceManifest, F1ReviewState, F1StepCheckpoint,
  JobView, LabObjectiveView, OverviewStats, PerformanceView, PipelineCandidateView,
  PromotionRecordView, RenderJobView, RenderStyle, RunCompareView, SessionInfo, SolutionArtifactView,
  TechnologyCandidateView, TwinVersionView, TwinView, UsageSummary, CostUsageSection, OptimizationEvidenceView,
  WebhookEndpointView, ConsentScope, CaptureRegion,
} from '../contracts';
// Template view types are lane-owned by core/templates (W2.B) — type-only
// import keeps the client drift-free against the server's templateView shape
// and is fully erased at compile time (no server code reaches the bundle).
import type { TemplateView } from '../core/templates';
// P6.C6 — Agent Body/Soul production runtime view types (lane-owned by
// lib/you/agent/runtime-core, the core/templates.ts TemplateView precedent:
// type-only import keeps the client drift-free against the server's view
// shapes and is fully erased at compile time — no server code in the bundle).
import type {
  AgentRuntimeBodyView,
  AgentRuntimeSessionSummaryView,
  AgentRuntimeSessionView,
  AgentRuntimeSoulView,
  AgentRuntimeTurnView,
} from '../agent/runtime-core';
// P6.B4 — deficiency report/delta view types (lane-owned by
// lib/you/core/deficiency.ts — pure module; this type-only import is fully
// erased at compile time, so no aggregation code reaches the client bundle;
// the pure half IS unit-tested server-side in tests/contract).
import type { DeficiencyDelta, DeficiencyReport } from '../core/deficiency';
// P6.C7 — Live session view types (lane-owned by lib/you/live/live-core, the
// runtime-core precedent: type-only import keeps the client drift-free
// against the server's view shapes and is fully erased at compile time —
// no node builtin (the HMAC seam) reaches the browser bundle).
import type {
  LiveSessionSummaryView,
  LiveSessionView,
  LiveSignalingPollView,
} from '../live/live-core';
// P6.B7 — Soul provider status rows (lane-owned by lib/you/agent/
// soul-providers, type-only import keeps the client drift-free against the
// server's provider surface; fully erased at compile time).
import type { SoulProviderStatusRow } from '../agent/soul-providers';
// P6.C8 — try-on view types (lane-owned by lib/you/tryon/views, the same
// type-only-import precedent: erased at compile time, no storage/db code
// reaches the browser bundle; the contract surface lives in
// adapters/try-on.ts where the node:test suite enforces it).
import type {
  GarmentAssetView,
  TryOnComparisonView,
  TryOnJobSummaryView,
} from '../tryon/views';

const BASE = '/api/v1';

/** GET /api/v1/twins/:id/deficiencies envelope (P6.B4).
 * `baselineReport` + `delta` are present only when `baselineVersionId` was
 * requested — honest absence otherwise (never a fabricated delta). */
export interface DeficiencyReportEnvelope {
  report: DeficiencyReport;
  baselineReport?: DeficiencyReport;
  delta?: DeficiencyDelta;
}

async function call<T>(path: string, init?: RequestInit & { idempotencyKey?: string }): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.idempotencyKey) headers['x-idempotency-key'] = init.idempotencyKey;
  const res = await fetch(BASE + path, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let code = 'internal_error', message = res.statusText;
    let details: unknown;
    try {
      const body = await res.json();
      code = body?.error?.code ?? code;
      message = body?.error?.message ?? message;
      details = body?.error?.details;
    } catch { /* keep default */ }
    // P6.B8: propagate the TYPED envelope (code/details/guidance) plus the
    // Retry-After header instead of flattening everything to strings — the
    // degraded surfaces (shared/degraded-state.tsx) derive honest retry
    // guidance from these fields. Never fabricated, never dropped.
    throw new YouApiError(code, message, res.status, {
      details,
      retryAfterHeaderSeconds: res.headers.get('retry-after'),
    });
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export class YouApiError extends Error {
  /** Envelope `details` verbatim (degraded: provider, breakerState, guidance…). */
  readonly details?: unknown;
  /** Retry guidance in ms (envelope details first, Retry-After header fallback). */
  readonly retryAfterMs?: number;
  /** Backend/operator guidance string from the envelope, when present. */
  readonly guidance?: string;

  constructor(
    public code: string,
    message: string,
    public status: number,
    opts?: { details?: unknown; retryAfterHeaderSeconds?: string | null },
  ) {
    super(message);
    this.name = 'YouApiError';
    const d = opts?.details;
    const rec = d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : null;
    // P6.B8: retry-window derivation mirrors client/degraded.ts
    // retryAfterMsFromEnvelope() 1:1 (details.retryAfterSeconds first, then
    // the Retry-After header). Deliberately INLINED, not imported: this module
    // uses constructor parameter properties (not erasable TS), so it is NOT
    // node:test-importable — the pure twin in degraded.ts is the unit-tested
    // source of these semantics (P6.B8 disclosure in the report).
    const fromDetails = rec && typeof rec.retryAfterSeconds === 'number'
      && Number.isFinite(rec.retryAfterSeconds) && rec.retryAfterSeconds > 0
      ? rec.retryAfterSeconds * 1000
      : undefined;
    const headerSeconds = Number(opts?.retryAfterHeaderSeconds);
    const fromHeader = opts?.retryAfterHeaderSeconds !== undefined && opts?.retryAfterHeaderSeconds !== null
      && Number.isFinite(headerSeconds) && headerSeconds > 0
      ? headerSeconds * 1000
      : undefined;
    this.details = d;
    this.retryAfterMs = fromDetails ?? fromHeader;
    this.guidance = rec && typeof rec.guidance === 'string' && rec.guidance ? rec.guidance : undefined;
  }
}

function qs(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

export const uid = () => (globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`);

// ─── Operator surface view types (P6.A6-FULL routes, P6.B8 client mirror) ───

/** Dead-letter payload as the maintenance route parses it (core/deadletter.ts). */
export interface DeadLetterView {
  code: 'dead_letter';
  attempts: number;
  stoppedBy: string;
  firstAttemptAt: string;
  lastErrorAt: string;
  lastError: string;
}

/** ── P6.B5 — B4 deficiencies (OPPORTUNISTIC surface) ────────────────────────
 * GET /api/v1/twins/:id/deficiencies is a PARALLEL lane's deliverable and may
 * not be deployed; a 404 means "not present" and the UI hides the delta panel
 * with an honest pending note. The payload is read TOLERANTLY (top-level
 * array or { deficiencies: [...] }) because B4's contract is frozen
 * independently of this lane — unrecognized shapes render as unavailable,
 * never fabricated. */
export interface DeficiencyRecordView {
  id?: string;
  capability?: string;
  region?: string;
  status?: string;
  note?: string;
  [key: string]: unknown;
}
export type DeficienciesPayload = DeficiencyRecordView[] | { deficiencies?: DeficiencyRecordView[]; [key: string]: unknown };

/** GET /api/v1/maintenance/dead-jobs response (operator-gated). */
export interface DeadJobsView {
  retentionDays: number;
  count: number;
  jobs: {
    id: string;
    kind: string;
    status: 'dead';
    createdAt: string;
    firstAttemptAt: string | null;
    finishedAt: string | null;
    /** Structured dead-letter payload when parseable; null never lies. */
    deadLetter: DeadLetterView | null;
  }[];
}

/** One provider's circuit-breaker snapshot (GET /api/v1/metrics). */
export interface BreakerStatusView {
  state: 'closed' | 'open' | 'half-open';
  failuresInWindow: number;
  failureThreshold: number;
  windowMs: number;
  cooldownMs: number;
  openedAt: string | null;
  openedReason: string | null;
  lastError: string | null;
  lastFailureAt: string | null;
  /** Remaining cooldown in ms while open (0 otherwise). */
  retryAfterMs: number;
  successCount: number;
  failureCount: number;
}

/** GET /api/v1/usage response — P6.C12 extended the shape ADDITIVELY: the
 * legacy metrics/totals fields are unchanged; cost + optimizations are
 * OPTIONAL so older deployments (pre-C12) still parse for the legacy
 * consumers (tolerant client law — absent sections render as honest
 * unavailable states, never fabricated). */
export type UsageSummaryView = UsageSummary & {
  cost?: CostUsageSection;
  optimizations?: OptimizationEvidenceView[];
};

/** GET /api/v1/metrics response (operator-gated). */
export interface MetricsView {
  scope: {
    tenantId: string;
    processUptimeSeconds: number;
    countersAndBreakers: string;
    jobCounts: string;
  };
  /** Process-local counters (labeled as such by the route). */
  counters: Record<string, number>;
  breakers: Record<string, BreakerStatusView>;
  deadJobs: {
    count: number;
    oldest: { id: string; kind: string; finishedAt: string | null } | null;
    retentionDays: number;
    inspection: string;
  };
  /** Tenant-scoped job counts by status (dead included). */
  jobs: Record<string, number>;
  /** P6.C12: declared SLOs + observed latency stats (absent pre-C12). */
  latency?: {
    slos: SloStatView[];
    scope: string;
    honesty: string[];
  };
}

/** One SLO's declared target + observed stats (GET /api/v1/metrics latency). */
export interface SloStatView {
  id: string;
  label: string;
  covers: string;
  targetP95Ms: number;
  basis: string;
  observations: number;
  totalObservations: number;
  breaches: number;
  p50Ms: number | null;
  p95Ms: number | null;
  percentileMethod: string;
  lastObservation: {
    requestId: string | null;
    route: string;
    method: string;
    status: number;
    durationMs: number;
    at: string;
  } | null;
}

// ─── P6.B9 — API playground surfaces (the Develop playground routes) ────────

/** Sandbox/test-mode resolution as GET /api/v1/develop/playground reports it. */
export interface PlaygroundSandboxState {
  configured: boolean;
  requested: boolean;
  available: boolean;
  mode: 'live' | 'sandbox';
  reason: string;
}

/** GET /api/v1/develop/playground response. */
export interface PlaygroundStatusView {
  sandbox: PlaygroundSandboxState;
  envVar: string;
  inventoryCount: number;
}

/** POST /api/v1/develop/playground/execute success envelope. */
export interface PlaygroundExecuteResult {
  operation: { method: string; path: string };
  resolvedPath: string;
  sandbox: boolean;
  status: number;
  statusText: string;
  durationMs: number;
  headers: { name: string; value: string }[];
  body: string;
  bodyTruncated?: boolean;
}

// ─── Session ─────────────────────────────────────────────────────────────────
export const api = {
  session: {
    get: () => call<SessionInfo>('/session'),
    create: () => call<SessionInfo>('/session', { method: 'POST' }),
  },

  overview: () => call<OverviewStats>('/overview'),

  // ─── Twins ────────────────────────────────────────────────────────────────
  twins: {
    list: () => call<TwinView[]>('/twins'),
    create: (body: { displayName: string; personName?: string }, idem?: string) =>
      call<TwinView>('/twins', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    get: (id: string) => call<TwinView & { versions: TwinVersionView[]; captures: CaptureSessionView[] }>(`/twins/${id}`),
    versions: (id: string) => call<TwinVersionView[]>(`/twins/${id}/versions`),
    compile: (id: string, body: { captureSessionId?: string; style?: RenderStyle } = {}, idem?: string) =>
      call<{ jobId: string }>(`/twins/${id}/compile`, { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    remove: (id: string) => call<void>(`/twins/${id}`, { method: 'DELETE' }),
    // P6.B4 — honest quality-deficiency report (+ optional version delta)
    deficiencies: (id: string, params?: { versionId?: string; baselineVersionId?: string }) =>
      call<DeficiencyReportEnvelope>(`/twins/${id}/deficiencies${qs({ versionId: params?.versionId, baselineVersionId: params?.baselineVersionId })}`),
  },

  // ─── Captures / evidence ─────────────────────────────────────────────────
  captures: {
    start: (twinId: string, body: { fulfillRequestId?: string } = {}, idem?: string) =>
      call<CaptureSessionView>(`/twins/${twinId}/capture-sessions`, { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    list: () => call<CaptureSessionView[]>('/captures'),
    get: (id: string) => call<CaptureSessionView>(`/captures/${id}`),
    upload: async (id: string, file: File, regions: CaptureRegion[]) => {
      const form = new FormData();
      form.append('file', file);
      form.append('regions', JSON.stringify(regions));
      return call<EvidenceAssetView>(`/captures/${id}/assets`, { method: 'POST', body: form });
    },
    complete: (id: string, idem?: string) =>
      call<{ jobId: string }>(`/captures/${id}/complete`, { method: 'POST', idempotencyKey: idem }),
    signEvidence: (assetId: string) => call<{ url: string; expiresAt: string }>(`/evidence/${assetId}/url`),
    // ── P6.B3 — the guided F1 operator capture flow ──────────────────
    f1: {
      start: (twinId: string, idem?: string) =>
        call<CaptureSessionView>(`/twins/${twinId}/capture-sessions/f1`, { method: 'POST', body: '{}', idempotencyKey: idem }),
      submitStep: (id: string, stepId: string, file: File) => {
        const form = new FormData();
        form.append('file', file);
        return call<CaptureSessionView & {
          submitted: { stepId: string; assetId: string; contentHash: string; checkpoint: F1StepCheckpoint };
          consent: { grantId: string; trainingPermitted: boolean };
        }>(`/captures/${id}/f1/steps/${stepId}/submit`, { method: 'POST', body: form });
      },
      skipStep: (id: string, stepId: string, reason: string) =>
        call<CaptureSessionView & { skipped: { stepId: string; reason: string; required: boolean } }>(
          `/captures/${id}/f1/steps/${stepId}/skip`,
          { method: 'POST', body: JSON.stringify({ reason }) },
        ),
      complete: (id: string, idem?: string) =>
        call<CaptureSessionView & { summary: Record<string, unknown>; manifest: F1EvidenceManifest }>(
          `/captures/${id}/f1/complete`, { method: 'POST', idempotencyKey: idem },
        ),
      review: (id: string, body: { verdict: 'approve' | 'reject'; note?: string }, idem?: string) =>
        call<CaptureSessionView & { review: F1ReviewState }>(`/captures/${id}/f1/review`, {
          method: 'POST', body: JSON.stringify(body), idempotencyKey: idem,
        }),
      remove: (id: string) => call<{
        deleted: boolean; captureSessionId: string; assetsDeleted: number;
        objectsDeleted: number; objectsRetained: number; retainedKeys: string[];
        twinVersionsRemain: { id: string; version: number }[]; disclosure: string;
      }>(`/captures/${id}/f1`, { method: 'DELETE' }),
      exportUrl: (id: string) => `/api/v1/captures/${id}/f1/export`,
    },
  },

  // ─── Consent ──────────────────────────────────────────────────────────────
  consent: {
    list: () => call<ConsentGrantView[]>('/consent-grants'),
    grant: (body: {
      subjectId: string; purpose: string; scopes: ConsentScope[];
      operations?: string[]; outputs?: string[]; ttlHours?: number;
      /** P6.B3 — optional F1 operator-capture statements (guided-flow gate). */
      statements?: F1ConsentStatements;
    }, idem?: string) =>
      call<ConsentGrantView>('/consent-grants', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    revoke: (id: string) => call<void>(`/consent-grants/${id}`, { method: 'DELETE' }),
  },

  // ─── Performances ─────────────────────────────────────────────────────────
  performances: {
    list: () => call<PerformanceView[]>('/performances'),
    fromText: (body: { name: string; script: string; twinId?: string }, idem?: string) =>
      call<{ jobId: string }>('/performances/from-text', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    get: (id: string) => call<PerformanceView>(`/performances/${id}`),
  },

  // ─── Renders ──────────────────────────────────────────────────────────────
  renders: {
    list: () => call<RenderJobView[]>('/renders'),
    create: (body: {
      twinId: string; twinVersionId: string; performanceId?: string;
      kind: 'image' | 'video'; style: RenderStyle; adapter?: 'svg-portrait-1' | 'ai-image-1' | 'ai-video-1';
    }, idem?: string) =>
      call<{ jobId: string }>('/renders', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    get: (id: string) => call<RenderJobView>(`/renders/${id}`),
  },

  // ─── Virtual try-on (P6.C8 — e-commerce, honest claims) ──────────────────
  // Garment/product assets (merchant surface: productRef rides the garment,
  // preserved verbatim through artifacts + the 'tryon.completed' signed
  // webhook callback). Try-on jobs are durable tryon.render jobs; without a
  // configured provider they FAIL honestly with the verbatim reason.
  tryOn: {
    garments: () => call<GarmentAssetView[]>('/try-on/garments'),
    getGarment: (id: string) => call<GarmentAssetView>(`/try-on/garments/${id}`),
    uploadGarment: (file: File, meta: { displayName: string; productRef?: string; productUrl?: string }) => {
      const form = new FormData();
      form.append('file', file);
      form.append('displayName', meta.displayName);
      if (meta.productRef) form.append('productRef', meta.productRef);
      if (meta.productUrl) form.append('productUrl', meta.productUrl);
      return call<GarmentAssetView>('/try-on/garments', { method: 'POST', body: form });
    },
    jobs: () => call<TryOnJobSummaryView[]>('/try-on'),
    getJob: (id: string) => call<TryOnJobSummaryView & { comparison: TryOnComparisonView | null }>(`/try-on/${id}`),
    create: (
      body: { twinId: string; twinVersionId: string; garmentAssetId: string; style?: 'photorealistic' | 'stylized-portrait' | 'anime' | 'illustration' },
      idem?: string,
    ) =>
      call<{ jobId: string; tryOnJobId: string }>('/try-on', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
  },

  // ─── Templates ────────────────────────────────────────────────────────────
  // docs/API_CONTRACTS.md §Templates and scenes (W2.B persistence + analyze).
  templates: {
    list: () => call<TemplateView[]>('/templates'),
    get: (id: string) => call<TemplateView>(`/templates/${id}`),
    create: (body: {
      name: string; description?: string; status?: 'draft' | 'published'; notes?: string;
      captureChecklist?: { item: string; capability: string; region: CaptureRegion; optional?: boolean }[];
      scenes?: { name: string; parameters?: Record<string, unknown> }[];
      stylePresets?: { name: string; style: RenderStyle; params?: Record<string, unknown> }[];
    }, idem?: string) =>
      call<TemplateView>('/templates', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    analyze: (id: string, idem?: string) =>
      call<{ jobId: string }>(`/templates/${id}/analyze`, { method: 'POST', body: JSON.stringify({}), idempotencyKey: idem }),
  },

  // ─── Agent avatars ────────────────────────────────────────────────────────
  agents: {
    bodies: () => call<AgentBodyView[]>('/agent-bodies'),
    souls: () => call<AgentSoulView[]>('/agent-souls'),
    createBody: (body: { name: string; role: string; capabilities?: string[]; tools?: string[]; permissions?: string[] }, idem?: string) =>
      call<AgentBodyView>('/agent-bodies', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    possess: (bodyId: string, soulKey: string, idem?: string) =>
      call<AgentBodyView>(`/agent-bodies/${bodyId}/possessions`, { method: 'POST', body: JSON.stringify({ soulKey }), idempotencyKey: idem }),
    startSession: (body: { bodyId: string; soulKey: string; twinId?: string }, idem?: string) =>
      call<AgentAvatarSessionView>('/agent-avatar-sessions', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    getSession: (id: string) => call<AgentAvatarSessionView>(`/agent-avatar-sessions/${id}`),
    sendTurn: (id: string, message: string) =>
      call<{ turn: AgentAvatarSessionView['turns'][number]; events: AgentAvatarSessionView['turns'][number]['states'] }>(
        `/agent-avatar-sessions/${id}/events`, { method: 'POST', body: JSON.stringify({ message }) }),
    endSession: (id: string) => call<void>(`/agent-avatar-sessions/${id}`, { method: 'DELETE' }),
  },

  // ─── Agent Body/Soul production runtime (P6.C6) ───────────────────────────
  // Bodies: visual/physical avatar assets bound to a TwinVersion. Souls:
  // personality/behavior configuration bound to a Twin. Sessions bind
  // (Twin, Body, Soul) with consent provenance; turns run as durable
  // agent.turn jobs through the resilience stack.
  agentRuntime: {
    bodies: () => call<AgentRuntimeBodyView[]>('/agent/bodies'),
    createBody: (
      body: { name: string; role: string; description?: string; twinId?: string; tools?: string[]; capabilities?: string[] },
      idem?: string,
    ) => call<AgentRuntimeBodyView>('/agent/bodies', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    getBody: (id: string) => call<AgentRuntimeBodyView & { versions: { version: number; createdAt: string; snapshot: Record<string, unknown> }[] }>(`/agent/bodies/${id}`),
    updateBody: (
      id: string,
      body: { action?: 'activate' | 'deactivate'; name?: string; role?: string; description?: string | null; twinId?: string | null; tools?: string[]; capabilities?: string[] },
      idem?: string,
    ) => call<AgentRuntimeBodyView>(`/agent/bodies/${id}`, { method: 'PATCH', body: JSON.stringify(body), idempotencyKey: idem }),

    souls: () => call<AgentRuntimeSoulView[]>('/agent/souls'),
    createSoul: (
      body: {
        name: string; description?: string; twinId: string;
        persona?: { tagline?: string; traits?: string[]; speakingStyle?: string; additionalInstructions?: string };
        provider?: string; model: string; params?: { thinking?: boolean; temperature?: number };
        capabilities?: string[];
      },
      idem?: string,
    ) => call<AgentRuntimeSoulView>('/agent/souls', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    getSoul: (id: string) => call<AgentRuntimeSoulView & { versions: { version: number; createdAt: string; snapshot: Record<string, unknown> }[] }>(`/agent/souls/${id}`),
    updateSoul: (
      id: string,
      body: { action?: 'activate' | 'deactivate'; name?: string; description?: string | null; persona?: Record<string, unknown>; params?: Record<string, unknown>; capabilities?: string[] },
      idem?: string,
    ) => call<AgentRuntimeSoulView>(`/agent/souls/${id}`, { method: 'PATCH', body: JSON.stringify(body), idempotencyKey: idem }),

    sessions: () => call<AgentRuntimeSessionSummaryView[]>('/agent/sessions'),
    createSession: (body: { bodyId: string; soulId: string }, idem?: string) =>
      call<AgentRuntimeSessionView>('/agent/sessions', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    getSession: (id: string) => call<AgentRuntimeSessionView>(`/agent/sessions/${id}`),
    sendTurn: (id: string, message: string, idem?: string) =>
      call<{ jobId: string; turn: AgentRuntimeTurnView; replayed?: boolean }>(
        `/agent/sessions/${id}/turns`, { method: 'POST', body: JSON.stringify({ message }), idempotencyKey: idem }),
    endSession: (id: string) => call<void>(`/agent/sessions/${id}`, { method: 'DELETE' }),
    // P6.B7 — Soul provider wiring + user interrupt of an in-flight turn.
    providers: () => call<SoulProviderStatusRow[]>('/agent/providers'),
    interruptTurn: (id: string, idem?: string) =>
      call<{ jobId: string; effective: boolean; note: string }>(
        `/agent/sessions/${id}/interrupt`, { method: 'POST', body: '{}', idempotencyKey: idem }),
  },

  // ─── Live sessions — realtime performance / WebRTC path (P6.C7) ──────
  // Live sessions are the LOW-LATENCY surface, fully separate from the
  // offline rendering loop. Create is consent-enforced server-side and
  // mints a short-lived signaling token; signal exchange is HTTP polling
  // in v1 (documented); state events are idempotent (x-idempotency-key).
  live: {
    sessions: () => call<LiveSessionSummaryView[]>('/live-sessions'),
    create: (body: { twinId?: string; agentSessionId?: string; consentGrantId?: string }, idem?: string) =>
      call<{
        session: LiveSessionView;
        signalingToken: string;
        tokenExpiresAt: string;
      }>('/live-sessions', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    get: (id: string) => call<LiveSessionView>(`/live-sessions/${id}`),
    // POST one SDP offer/answer or ICE candidate (requires the token).
    signal: (
      id: string,
      body: { kind: 'offer' | 'answer'; from: 'initiator' | 'responder'; sdp: string } | { kind: 'candidate'; from: 'initiator' | 'responder'; candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null },
      signalingToken: string,
    ) =>
      call<{ phase: string; status: string; seq: number | null }>(`/live-sessions/${id}/signal`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'x-signaling-token': signalingToken },
      }),
    // v1 transport: poll the relayed signaling state (documented honest limit).
    pollSignal: (id: string, since?: number) =>
      call<LiveSignalingPollView>(`/live-sessions/${id}/signal${qs({ since })}`),
    // POST one live state event (idempotent with x-idempotency-key; token).
    submitState: (
      id: string,
      body:
        | { kind: 'connection'; connectionState: 'connecting' | 'connected' | 'failed' | 'closed' }
        | { kind: 'performance'; delta: { gaze?: { x: number; y: number }; expression?: string; speech?: string; intensity?: number } }
        | { kind: 'agent'; agentState: string },
      signalingToken: string,
      idem?: string,
    ) =>
      call<{ eventId: string; duplicate: boolean; status: string; phase: string; currentAgentState: string | null }>(
        `/live-sessions/${id}/state`, {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'x-signaling-token': signalingToken },
          idempotencyKey: idem,
        }),
    end: (id: string) => call<void>(`/live-sessions/${id}/end`, { method: 'POST', body: '{}' }),
  },

  // ─── Lab ──────────────────────────────────────────────────────────────────
  lab: {
    objectives: () => call<LabObjectiveView[]>('/lab/objectives'),
    createObjective: (body: { code: string; title: string; description: string }, idem?: string) =>
      call<LabObjectiveView>('/lab/objectives', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    run: (body: { objectiveCode: string; worldSeed?: number; rerunOf?: string }, idem?: string) =>
      call<{ jobId: string; benchmarkRunId?: string; replayed?: boolean }>('/lab/runs', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    getRun: (id: string) => call<BenchmarkRunView>(`/lab/runs/${id}`),
    // P6.C11 — run comparison + regression detection (same world seed required).
    compareRun: (id: string, baseline: string, thresholds: Record<string, number> = {}) =>
      call<RunCompareView>(`/lab/runs/${id}/compare${qs({ baseline, ...thresholds })}`),
    // P6.C11 — Failure Atlas aggregation (by code/region/pipeline/technology
    // version/time window over real recorded cases only).
    failureAtlas: (params: { from?: string; to?: string; topCauses?: number } = {}) =>
      call<FailureAtlasView>(`/lab/failures/atlas${qs(params)}`),
    // P6.C11 — remediation lifecycle (open → mitigated → verified).
    remediate: (id: string, body: { action: 'mitigate' | 'verify'; evidence: string; note?: string }, idem?: string) =>
      call<FailureCaseView>(`/lab/failures/${id}/remediate`, { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    technologies: () => call<TechnologyCandidateView[]>('/lab/technologies'),
    pipelines: () => call<PipelineCandidateView[]>('/lab/pipelines'),
    failures: () => call<FailureCaseView[]>('/lab/failures'),
    promotions: () => call<PromotionRecordView[]>('/lab/promotions'),
  },

  // ─── Develop ──────────────────────────────────────────────────────────────
  develop: {
    apiKeys: () => call<ApiKeyView[]>('/api-keys'),
    createKey: (body: { name: string; scopes: string[] }, idem?: string) =>
      call<ApiKeySecret>('/api-keys', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    revokeKey: (id: string) => call<void>(`/api-keys/${id}`, { method: 'DELETE' }),
    events: (params?: { type?: string; limit?: number }) => call<EventRecordView[]>(`/events${qs(params ?? {})}`),
    usage: () => call<UsageSummaryView>('/usage'),
    webhooks: () => call<WebhookEndpointView[]>('/webhooks'),
    createWebhook: (body: { url: string; events: string[] }, idem?: string) =>
      call<WebhookEndpointView>('/webhooks', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    deleteWebhook: (id: string) => call<void>(`/webhooks/${id}`, { method: 'DELETE' }),
    // P6.B9 — the executable API playground (frozen-inventory operations,
    // API-level mutation confirmation, honest sandbox surface).
    playgroundStatus: () => call<PlaygroundStatusView>('/develop/playground'),
    playgroundExecute: (body: {
      method: 'get' | 'post' | 'put' | 'patch' | 'delete';
      path: string;
      pathParams?: Record<string, string>;
      query?: Record<string, string>;
      body?: string;
      mutationAcknowledged?: boolean;
      sandbox?: boolean;
    }) => call<PlaygroundExecuteResult>('/develop/playground/execute', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  },

  // ─── Artifacts / feedback loop ────────────────────────────────────────────
  artifacts: {
    get: (id: string) => call<SolutionArtifactView>(`/artifacts/${id}`),
    // P6.B6 — list with exact-match filters (twinVersionId / renderJobId /
    // type / performanceId; performanceId matches the manifest slot).
    list: (filters: { twinVersionId?: string; renderJobId?: string; type?: SolutionArtifactView['type']; performanceId?: string } = {}) =>
      call<SolutionArtifactView[]>(`/artifacts${qs(filters)}`),
    feedback: (body: {
      solutionArtifactId?: string; twinVersionId: string; region?: string;
      verdict: string; note?: string;
    }, idem?: string) => call<FeedbackRequestView>('/feedback', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    evidenceRequests: (opts: { status?: 'open' | 'fulfilled' | 'expired'; capability?: string } = {}) =>
      call<EvidenceRequestView[]>(`/evidence-requests${qs(opts)}`),
    requestEvidence: (body: {
      twinVersionId?: string; reason: string; capability: string;
      instructions: string; expectedSignal: string; scope?: string;
    }, idem?: string) => call<EvidenceRequestView>('/evidence-requests', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    fulfillEvidenceRequest: (id: string, twinId: string, opts: { idem?: string; guided?: boolean } = {}) =>
      call<{ captureSession: CaptureSessionView; evidenceRequest?: EvidenceRequestView; resumed?: boolean }>(
        `/evidence-requests/${id}/fulfill`,
        { method: 'POST', body: JSON.stringify({ twinId, guided: opts.guided === true }), idempotencyKey: opts.idem },
      ),
  },

  // ─── Jobs ─────────────────────────────────────────────────────────────────
  jobs: {
    get: (id: string) => call<JobView>(`/jobs/${id}`),
  },

  // ─── Operator maintenance + metrics (P6.B8 surfaces over P6.A6-FULL) ─────
  // Routes are Worker A lane (landed, frozen inventory); these client mirrors
  // are the Studio's typed view of them. Operator-gated server-side (session
  // actorType 'user'); 403s are rendered honestly by the UI, never retried.
  maintenance: {
    deadJobs: (params?: { limit?: number }) =>
      call<DeadJobsView>(`/maintenance/dead-jobs${qs({ limit: params?.limit })}`),
    replayDeadJob: (jobId: string, idem?: string) =>
      call<{ jobId: string; replayed: boolean }>('/maintenance/dead-jobs', {
        method: 'POST', body: JSON.stringify({ action: 'replay', jobId }), idempotencyKey: idem,
      }),
    purgeDeadJobs: (idem?: string) =>
      call<{ purged: number; retentionDays: number; cutoff: string }>('/maintenance/dead-jobs', {
        method: 'POST', body: JSON.stringify({ action: 'purge' }), idempotencyKey: idem,
      }),
  },
  metrics: () => call<MetricsView>('/metrics'),
};

export type Api = typeof api;
