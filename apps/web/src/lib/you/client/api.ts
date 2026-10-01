// YOU Studio API client (TL-owned). Worker B consumes; Worker A implements
// the server routes to match exactly. Drift = integration bug.
import type {
  AgentAvatarSessionView, AgentBodyView, AgentSoulView, ApiKeySecret, ApiKeyView,
  BenchmarkRunView, CaptureSessionView, ConsentGrantView, EventRecordView,
  EvidenceAssetView, EvidenceRequestView, FailureCaseView, FeedbackRequestView,
  JobView, LabObjectiveView, OverviewStats, PerformanceView, PipelineCandidateView,
  PromotionRecordView, RenderJobView, RenderStyle, SessionInfo, SolutionArtifactView,
  TechnologyCandidateView, TwinVersionView, TwinView, UsageSummary,
  WebhookEndpointView, ConsentScope, CaptureRegion,
} from '../contracts';

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
    try { const body = await res.json(); code = body?.error?.code ?? code; message = body?.error?.message ?? message; } catch { /* keep default */ }
    throw new YouApiError(code, message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export class YouApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

function qs(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

export const uid = () => (globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`);

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
  },

  // ─── Consent ──────────────────────────────────────────────────────────────
  consent: {
    list: () => call<ConsentGrantView[]>('/consent-grants'),
    grant: (body: {
      subjectId: string; purpose: string; scopes: ConsentScope[];
      operations?: string[]; outputs?: string[]; ttlHours?: number;
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
};

export type Api = typeof api;
