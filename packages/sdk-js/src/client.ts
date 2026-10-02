// ═══════════════════════════════════════════════════════════════════════════
// @you/sdk-js — typed client for the YOU platform /api/v1 surface
// (Worker A lane, A8)
//
// Extraction of apps/web/src/lib/you/client/api.ts (TL-owned, stays untouched
// as the in-app client — transitional duplication, see README.md) extended
// with the templates surface (W2.B) and the verification-sessions surface
// incl. evaluate (W3.A / A4).
//
// Transport rules mirrored from the in-app client / docs/API_CONTRACTS.md:
//  - `x-idempotency-key` header is sent only where the server route consumes
//    it (§API rules "mutating requests support Idempotency-Key");
//  - errors surface as YouApiError { code, message, status } (stable machine
//    codes, honest messages — never swallowed);
//  - async work returns { jobId } immediately; poll jobs.get();
//  - verification-sessions create/evidence/evaluate take NO idempotency key:
//    the route contract pins the replay answer (409 on pending/expired/
//    already-evaluated state machine states).
//
// Zero runtime dependencies (zod was not needed — the server owns validation;
// this is a thin typed transport). Runs on any fetch implementation
// (undici Node ≥18, bun, browsers); inject `fetchImpl` for tests/edge.
// ═══════════════════════════════════════════════════════════════════════════
import type {
  AgentAvatarSessionView, AgentBodyView, AgentSoulView, ApiKeySecret, ApiKeyView,
  BenchmarkRunView, CaptureRegion, CaptureSessionView, ConsentGrantView, ConsentScope,
  EventRecordView, EvidenceAssetView, EvidenceRequestView, FailureCaseView,
  FeedbackRequestView, JobView, LabObjectiveView, OverviewStats, PerformanceView,
  PipelineCandidateView, PromotionRecordView, RenderJobView, RenderStyle,
  SessionInfo, SolutionArtifactView, TechnologyCandidateView, TemplateView,
  TwinVersionView, TwinView, UsageSummary, VerificationSessionView,
  WebhookEndpointView,
} from './types';

export interface YouClientOptions {
  /** Base URL of the /api/v1 root. Default '/api/v1' (same-origin browser use). */
  baseUrl?: string;
  /** Bearer API key (you_sk_…). Omitted → cookie session auth (same-origin). */
  apiKey?: string;
  /** Injectable fetch (tests, edge runtimes). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class YouApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'YouApiError';
  }
}

type CallInit = RequestInit & { idempotencyKey?: string };

function joinUrl(base: string, path: string): string {
  if (!base.endsWith('/') && !path.startsWith('/')) return `${base}/${path}`;
  if (base.endsWith('/') && path.startsWith('/')) return base + path.slice(1);
  return base + path;
}

function qs(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

/** Collision-safe id helper (idempotency keys, test names…). */
export const uid = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export class YouClient {
  readonly options: Required<Omit<YouClientOptions, 'apiKey'>> & { apiKey?: string };

  constructor(options: YouClientOptions = {}) {
    this.options = {
      baseUrl: options.baseUrl ?? '/api/v1',
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
    };
  }

  private async call<T>(path: string, init?: CallInit): Promise<T> {
    const headers: Record<string, string> = {};
    if (init?.idempotencyKey) headers['x-idempotency-key'] = init.idempotencyKey;
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
    const merged: Record<string, string> = {
      ...headers,
      ...(init?.headers as Record<string, string> | undefined),
    };

    const res = await this.options.fetchImpl(joinUrl(this.options.baseUrl, path), {
      ...init,
      headers: merged,
      credentials: init?.credentials ?? 'same-origin',
    });

    if (!res.ok) {
      let code = 'internal_error';
      let message = res.statusText;
      let details: unknown;
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
        code = body?.error?.code ?? code;
        message = body?.error?.message ?? message;
        details = body?.error?.details;
      } catch {
        /* keep defaults — non-JSON error body */
      }
      throw new YouApiError(code, message, res.status, details);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  // ─── Session ───────────────────────────────────────────────────────────────
  readonly session = {
    get: () => this.call<SessionInfo>('/session'),
    create: () => this.call<SessionInfo>('/session', { method: 'POST' }),
  };

  readonly overview = () => this.call<OverviewStats>('/overview');

  // ─── Twins ─────────────────────────────────────────────────────────────────
  readonly twins = {
    list: () => this.call<TwinView[]>('/twins'),
    create: (body: { displayName: string; personName?: string }, idem?: string) =>
      this.call<TwinView>('/twins', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    get: (id: string) => this.call<TwinView & { versions: TwinVersionView[]; captures: CaptureSessionView[] }>(`/twins/${id}`),
    versions: (id: string) => this.call<TwinVersionView[]>(`/twins/${id}/versions`),
    compile: (id: string, body: { captureSessionId?: string; style?: RenderStyle } = {}, idem?: string) =>
      this.call<{ jobId: string }>(`/twins/${id}/compile`, { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    remove: (id: string) => this.call<void>(`/twins/${id}`, { method: 'DELETE' }),
  };

  // ─── Captures / evidence ───────────────────────────────────────────────────
  readonly captures = {
    start: (twinId: string, body: { fulfillRequestId?: string } = {}, idem?: string) =>
      this.call<CaptureSessionView>(`/twins/${twinId}/capture-sessions`, { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    list: () => this.call<CaptureSessionView[]>('/captures'),
    get: (id: string) => this.call<CaptureSessionView>(`/captures/${id}`),
    upload: async (id: string, file: Blob & { name?: string; type: string }, regions: CaptureRegion[]) => {
      const form = new FormData();
      form.append('file', file as unknown as File, (file as File).name ?? 'evidence');
      form.append('regions', JSON.stringify(regions));
      return this.call<EvidenceAssetView>(`/captures/${id}/assets`, { method: 'POST', body: form });
    },
    complete: (id: string, idem?: string) =>
      this.call<{ jobId: string }>(`/captures/${id}/complete`, { method: 'POST', idempotencyKey: idem }),
    signEvidence: (assetId: string) => this.call<{ url: string; expiresAt: string }>(`/evidence/${assetId}/url`),
  };

  // ─── Consent ───────────────────────────────────────────────────────────────
  readonly consent = {
    list: () => this.call<ConsentGrantView[]>('/consent-grants'),
    grant: (body: {
      subjectId: string; purpose: string; scopes: ConsentScope[];
      operations?: string[]; outputs?: string[]; ttlHours?: number;
    }, idem?: string) =>
      this.call<ConsentGrantView>('/consent-grants', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    revoke: (id: string) => this.call<void>(`/consent-grants/${id}`, { method: 'DELETE' }),
  };

  // ─── Performances ──────────────────────────────────────────────────────────
  readonly performances = {
    list: () => this.call<PerformanceView[]>('/performances'),
    fromText: (body: { name: string; script: string; twinId?: string }, idem?: string) =>
      this.call<{ jobId: string }>('/performances/from-text', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    get: (id: string) => this.call<PerformanceView>(`/performances/${id}`),
  };

  // ─── Renders ───────────────────────────────────────────────────────────────
  readonly renders = {
    list: () => this.call<RenderJobView[]>('/renders'),
    create: (body: {
      twinId: string; twinVersionId: string; performanceId?: string;
      kind: 'image' | 'video'; style: RenderStyle; adapter?: 'svg-portrait-1' | 'ai-image-1' | 'ai-video-1';
    }, idem?: string) =>
      this.call<{ jobId: string }>('/renders', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    get: (id: string) => this.call<RenderJobView>(`/renders/${id}`),
  };

  // ─── Templates (docs/API_CONTRACTS.md §Templates and scenes) ──────────────
  readonly templates = {
    list: () => this.call<TemplateView[]>('/templates'),
    get: (id: string) => this.call<TemplateView>(`/templates/${id}`),
    create: (body: {
      name: string; description?: string; status?: 'draft' | 'published'; notes?: string;
      captureChecklist?: { item: string; capability: string; region: CaptureRegion; optional?: boolean }[];
      scenes?: { name: string; parameters?: Record<string, unknown> }[];
      stylePresets?: { name: string; style: RenderStyle; params?: Record<string, unknown> }[];
    }, idem?: string) =>
      this.call<TemplateView>('/templates', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    analyze: (id: string, idem?: string) =>
      this.call<{ jobId: string }>(`/templates/${id}/analyze`, { method: 'POST', body: JSON.stringify({}), idempotencyKey: idem }),
  };

  // ─── Verification sessions (docs/API_CONTRACTS.md §Trust) ─────────────────
  // No idempotency keys on this surface by route contract: replays are
  // answered by the session state machine (409 pending / expired /
  // already-evaluated), never by a silent replay.
  readonly verificationSessions = {
    list: () => this.call<VerificationSessionView[]>('/verification-sessions'),
    create: (body: { subjectId: string; purpose: string; twinId?: string | null }) =>
      this.call<VerificationSessionView>('/verification-sessions', { method: 'POST', body: JSON.stringify(body) }),
    get: (id: string) => this.call<VerificationSessionView>(`/verification-sessions/${id}`),
    submitEvidence: (id: string, evidenceAssetIds: string[]) =>
      this.call<VerificationSessionView>(`/verification-sessions/${id}/evidence`, {
        method: 'POST',
        body: JSON.stringify({ evidenceAssetIds }),
      }),
    evaluate: (id: string) =>
      this.call<VerificationSessionView>(`/verification-sessions/${id}/evaluate`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
  };

  // ─── Agent avatars ─────────────────────────────────────────────────────────
  readonly agents = {
    bodies: () => this.call<AgentBodyView[]>('/agent-bodies'),
    souls: () => this.call<AgentSoulView[]>('/agent-souls'),
    createBody: (body: { name: string; role: string; capabilities?: string[]; tools?: string[]; permissions?: string[] }, idem?: string) =>
      this.call<AgentBodyView>('/agent-bodies', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    possess: (bodyId: string, soulKey: string, idem?: string) =>
      this.call<AgentBodyView>(`/agent-bodies/${bodyId}/possessions`, { method: 'POST', body: JSON.stringify({ soulKey }), idempotencyKey: idem }),
    startSession: (body: { bodyId: string; soulKey: string; twinId?: string }, idem?: string) =>
      this.call<AgentAvatarSessionView>('/agent-avatar-sessions', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    getSession: (id: string) => this.call<AgentAvatarSessionView>(`/agent-avatar-sessions/${id}`),
    sendTurn: (id: string, message: string) =>
      this.call<{ turn: AgentAvatarSessionView['turns'][number]; events: AgentAvatarSessionView['turns'][number]['states'] }>(
        `/agent-avatar-sessions/${id}/events`, { method: 'POST', body: JSON.stringify({ message }) }),
    endSession: (id: string) => this.call<void>(`/agent-avatar-sessions/${id}`, { method: 'DELETE' }),
  };

  // ─── Labs ──────────────────────────────────────────────────────────────────
  readonly lab = {
    objectives: () => this.call<LabObjectiveView[]>('/lab/objectives'),
    createObjective: (body: { code: string; title: string; description: string }, idem?: string) =>
      this.call<LabObjectiveView>('/lab/objectives', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    run: (body: { objectiveCode: string; worldSeed?: number }, idem?: string) =>
      this.call<{ jobId: string }>('/lab/runs', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    getRun: (id: string) => this.call<BenchmarkRunView>(`/lab/runs/${id}`),
    technologies: () => this.call<TechnologyCandidateView[]>('/lab/technologies'),
    pipelines: () => this.call<PipelineCandidateView[]>('/lab/pipelines'),
    failures: () => this.call<FailureCaseView[]>('/lab/failures'),
    promotions: () => this.call<PromotionRecordView[]>('/lab/promotions'),
  };

  // ─── Develop ───────────────────────────────────────────────────────────────
  readonly develop = {
    apiKeys: () => this.call<ApiKeyView[]>('/api-keys'),
    createKey: (body: { name: string; scopes: string[] }, idem?: string) =>
      this.call<ApiKeySecret>('/api-keys', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    revokeKey: (id: string) => this.call<void>(`/api-keys/${id}`, { method: 'DELETE' }),
    events: (params?: { type?: string; limit?: number }) => this.call<EventRecordView[]>(`/events${qs(params ?? {})}`),
    usage: () => this.call<UsageSummary>('/usage'),
    webhooks: () => this.call<WebhookEndpointView[]>('/webhooks'),
    createWebhook: (body: { url: string; events: string[] }, idem?: string) =>
      this.call<WebhookEndpointView>('/webhooks/endpoints', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    deleteWebhook: (id: string) => this.call<void>(`/webhooks/${id}`, { method: 'DELETE' }),
  };

  // ─── Artifacts / feedback loop ────────────────────────────────────────────
  readonly artifacts = {
    get: (id: string) => this.call<SolutionArtifactView>(`/artifacts/${id}`),
    feedback: (body: {
      solutionArtifactId?: string; twinVersionId: string; region?: string;
      verdict: string; note?: string;
    }, idem?: string) => this.call<FeedbackRequestView>('/feedback', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    evidenceRequests: () => this.call<EvidenceRequestView[]>('/evidence-requests'),
    requestEvidence: (body: {
      twinVersionId?: string; reason: string; capability: string;
      instructions: string; expectedSignal: string; scope?: string;
    }, idem?: string) => this.call<EvidenceRequestView>('/evidence-requests', { method: 'POST', body: JSON.stringify(body), idempotencyKey: idem }),
    fulfillEvidenceRequest: (id: string, twinId: string, idem?: string) =>
      this.call<{ captureSession: CaptureSessionView }>(`/evidence-requests/${id}/fulfill`, { method: 'POST', body: JSON.stringify({ twinId }), idempotencyKey: idem }),
  };

  // ─── Jobs ──────────────────────────────────────────────────────────────────
  readonly jobs = {
    get: (id: string) => this.call<JobView>(`/jobs/${id}`),
  };

  // ─── API keys (P6.A8: the auth surface incl. rotation) ────────────────────
  readonly apiKeys = {
    list: () => this.call<ApiKeyView[]>('/api-keys'),
    /** The secret is returned EXACTLY ONCE (sha256-only server storage). */
    create: (body: { name: string; scopes: Array<'read' | 'write'> }, idempotencyKey?: string) =>
      this.call<{ key: ApiKeyView; secret: string }>('/api-keys', { method: 'POST', body: JSON.stringify(body), idempotencyKey }),
    /** Revocation is terminal (rows kept for audit). */
    revoke: (id: string) => this.call<ApiKeyView>(`/api-keys/${id}`, { method: 'DELETE' }),
    /**
     * Rotate the secret IN PLACE (P6.A3): same id/name/scopes; the OLD secret
     * dies at the same instant the new one is born. The new secret is returned
     * exactly once. Revoked keys refuse rotation (409).
     */
    rotate: (id: string) => this.call<{ key: ApiKeyView; secret: string }>(`/api-keys/${id}/rotate`, { method: 'POST' }),
  };

  // ─── Webhooks / usage / feedback / evidence-requests ───────────────────────
  readonly webhooks = {
    list: () => this.call<WebhookEndpointView[]>('/webhooks'),
    create: (body: { url: string; secret: string; events?: string[] }, idempotencyKey?: string) =>
      this.call<WebhookEndpointView>('/webhooks', { method: 'POST', body: JSON.stringify(body), idempotencyKey }),
    delete: (id: string) => this.call<void>(`/webhooks/${id}`, { method: 'DELETE' }),
  };

  readonly usage = () => this.call<UsageSummary>('/usage');

  readonly feedback = {
    submit: (body: { artifactId?: string; renderJobId?: string; twinVersionId?: string; rating: number; comment?: string }) =>
      this.call<{ id: string }>('/feedback', { method: 'POST', body: JSON.stringify(body) }),
  };

  readonly evidenceRequests = {
    list: () => this.call<EvidenceRequestView[]>('/evidence-requests'),
    create: (body: { reason: string; capability: string; instructions?: string }, idempotencyKey?: string) =>
      this.call<EvidenceRequestView>('/evidence-requests', { method: 'POST', body: JSON.stringify(body), idempotencyKey }),
    fulfill: (id: string, upload: { file: Blob; filename: string; mime: string }) => {
      const form = new FormData();
      form.append('file', upload.file, upload.filename);
      return this.call<EvidenceAssetView>(`/evidence-requests/${id}/fulfill`, { method: 'POST', body: form });
    },
  };

  // ─── Data lifecycle (P6.A4 surfaces) ───────────────────────────────────────
  /** Portable subject export: rows + expiring evidence download capabilities. */
  readonly subjects = {
    export: (subjectId: string) =>
      this.call<{
        subjectId: string;
        exportedAt: string;
        twins: Array<{ id: string; displayName: string }>;
        consentGrants: Array<{ id: string; purpose: string }>;
        evidenceAssets: Array<{ id: string; contentHash: string; downloadUrl: string; downloadUrlExpiresInSeconds: number }>;
        [k: string]: unknown;
      }>(`/subjects/${subjectId}/export`),
  };

  /**
   * Storage GC (P6.A4): sweep unreferenced content-addressed objects.
   * OPERATOR-ONLY server-side (API keys get 403 — use session auth).
   */
  readonly maintenance = {
    gcStorage: () => this.call<{ jobId: string }>('/maintenance/gc-storage', { method: 'POST' }),
  };
}

/** Construct a client from environment-style config (baseUrl + optional key). */
export function createYouClient(options: YouClientOptions = {}): YouClient {
  return new YouClient(options);
}
