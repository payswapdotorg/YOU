// YOU Studio API client (TL-owned). Worker B consumes; Worker A implements
// the server routes to match exactly. Drift = integration bug.
import type {
  AgentAvatarSessionView, AgentBodyView, AgentSoulView, ApiKeySecret, ApiKeyView,
  BenchmarkRunView, CaptureSessionView, ConsentGrantView, EventRecordView,
  EvidenceAssetView, EvidenceRequestView, FailureCaseView, FeedbackRequestView,
  F1ConsentStatements, F1EvidenceManifest, F1ReviewState, F1StepCheckpoint,
  JobView, LabObjectiveView, OverviewStats, PerformanceView, PipelineCandidateView,
  PromotionRecordView, RenderJobView, RenderStyle, SessionInfo, SolutionArtifactView,
  TechnologyCandidateView, TwinVersionView, TwinView, UsageSummary,
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

const BASE = '/api/v1';

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
  },

  // ─── Lab ──────────────────────────────────────────────────────────────────
  lab: {
    objectives: () => call<LabObjectiveView[]>('/lab/objectives'),
    createObjective: (body: { code: string; title: string; description: string }, idem?: string) =>
      call<LabObjectiveView>('/lab/objectives', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    run: (body: { objectiveCode: string; worldSeed?: number }, idem?: string) =>
      call<{ jobId: string }>('/lab/runs', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    getRun: (id: string) => call<BenchmarkRunView>(`/lab/runs/${id}`),
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
    usage: () => call<UsageSummary>('/usage'),
    webhooks: () => call<WebhookEndpointView[]>('/webhooks'),
    createWebhook: (body: { url: string; events: string[] }, idem?: string) =>
      call<WebhookEndpointView>('/webhooks', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    deleteWebhook: (id: string) => call<void>(`/webhooks/${id}`, { method: 'DELETE' }),
  },

  // ─── Artifacts / feedback loop ────────────────────────────────────────────
  artifacts: {
    get: (id: string) => call<SolutionArtifactView>(`/artifacts/${id}`),
    feedback: (body: {
      solutionArtifactId?: string; twinVersionId: string; region?: string;
      verdict: string; note?: string;
    }, idem?: string) => call<FeedbackRequestView>('/feedback', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    evidenceRequests: () => call<EvidenceRequestView[]>('/evidence-requests'),
    requestEvidence: (body: {
      twinVersionId?: string; reason: string; capability: string;
      instructions: string; expectedSignal: string; scope?: string;
    }, idem?: string) => call<EvidenceRequestView>('/evidence-requests', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    fulfillEvidenceRequest: (id: string, twinId: string, idem?: string) =>
      call<{ captureSession: CaptureSessionView }>(`/evidence-requests/${id}/fulfill`, { method: 'POST', body: JSON.stringify({ twinId }), idempotencyKey: idem }),
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
