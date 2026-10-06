// ═══════════════════════════════════════════════════════════════════════════
// YOU core — view serialization (Prisma rows → frozen contract DTOs)
// JSON-encoded columns are decoded here exactly once per view boundary.
// ═══════════════════════════════════════════════════════════════════════════
import type {
  AgentAvatarSessionView, AgentAvatarTurnView, AgentBodyView, AgentSoulView,
  ApiKeyView, ArtifactRef, BenchmarkRunView, CaptureChecklistItem, CaptureSessionView,
  ConsentGrantView, ConsentScope, EvaluationReportView, EventRecordView, EvidenceAssetView,
  EvidenceQuality, EvidenceRequestView, FailureCaseView, FeedbackRequestView, F1EvidenceManifest,
  F1ProtocolState, F1ReviewState, HTIR,
  HtirConfidence, JobStep, JobView, LabObjectiveView, PerformanceTrack, PerformanceView,
  PipelineCandidateView, PipelineGenome, PromotionRecordView, RenderJobView,
  SolutionArtifactManifest, SolutionArtifactView, TechnologyCandidateView,
  TechnologyVersionView, TwinVersionView, TwinView, WebhookEndpointView,
} from '../contracts';
import type {
  AgentAvatarSession, AgentAvatarTurn, AgentBody, AgentSoulBinding, ApiKey,
  BenchmarkRun, CaptureSession, ConsentGrant, EventRecord, EvidenceAsset,
  EvidenceRequest, FailureCase, FeedbackRequest, Job, LabObjective, OutputArtifact,
  Performance, PipelineCandidate, PromotionRecord, RenderJob, SolutionArtifact,
  TechnologyCandidate, TechnologyVersion, Twin, TwinVersion, WebhookEndpoint,
} from '@prisma/client';
import { SOUL_CATALOG, type SoulCatalogEntry } from '../lab/seed';
import { grantF1Statements } from './f1-flow';
import { signStorageUrl } from './storage';

/** Safe JSON decode for string-encoded columns. */
export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

const iso = (d: Date): string => d.toISOString();

// ─── Twins ───────────────────────────────────────────────────────────────────

export function twinView(t: Twin): TwinView {
  return {
    id: t.id,
    displayName: t.displayName,
    personName: t.personName,
    subjectId: t.subjectId,
    status: t.status as TwinView['status'],
    currentVersion: t.currentVersion,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  };
}

export function twinVersionView(v: TwinVersion): TwinVersionView {
  return {
    id: v.id,
    twinId: v.twinId,
    version: v.version,
    status: v.status as TwinVersionView['status'],
    confidenceSummary: parseJson<HtirConfidence | null>(v.confidenceSummary, null),
    evidenceAssetIds: parseJson<string[]>(v.evidenceAssetIds, []),
    pipelineId: v.pipelineId,
    inputVersionIds: parseJson<string[]>(v.inputVersionIds, []),
    createdAt: iso(v.createdAt),
    htir: parseJson<HTIR>(v.htir, {} as HTIR),
  };
}

// ─── Evidence / captures ─────────────────────────────────────────────────────

export function evidenceAssetView(a: EvidenceAsset): EvidenceAssetView {
  return {
    id: a.id,
    kind: a.kind as EvidenceAssetView['kind'],
    regions: parseJson<EvidenceAssetView['regions']>(a.regions, []),
    contentHash: a.contentHash,
    bytes: a.bytes,
    mime: a.mime,
    quality: parseJson<EvidenceQuality | null>(a.quality, null),
    createdAt: iso(a.createdAt),
  };
}

export function captureSessionView(
  c: CaptureSession,
  assets: EvidenceAsset[],
): CaptureSessionView {
  return {
    id: c.id,
    twinId: c.twinId,
    status: c.status as CaptureSessionView['status'],
    checklist: parseJson<CaptureChecklistItem[]>(c.checklist, []),
    instructions: c.instructions,
    error: c.error,
    createdAt: iso(c.createdAt),
    completedAt: c.completedAt ? iso(c.completedAt) : null,
    assets: assets.map(evidenceAssetView),
    // P6.B3 — guided F1 flow state (null on every legacy session)
    consentGrantId: c.consentGrantId ?? null,
    protocol: parseJson<F1ProtocolState | null>(c.protocol, null),
    checkpoints: parseJson<Record<string, unknown> | null>(c.checkpoints, null),
    manifest: parseJson<F1EvidenceManifest | null>(c.manifest, null),
    retention: parseJson<CaptureSessionView['retention']>(c.retention, null),
    review: parseJson<F1ReviewState | null>(c.review, null),
  };
}

// ─── Consent ─────────────────────────────────────────────────────────────────

export function consentGrantView(g: ConsentGrant): ConsentGrantView {
  return {
    id: g.id,
    subjectId: g.subjectId,
    granteeId: g.granteeId,
    purpose: g.purpose,
    scopes: parseJson<ConsentScope[]>(g.scopes, []),
    operations: parseJson<string[]>(g.operations, []),
    outputs: parseJson<string[]>(g.outputs, []),
    // P6.B3 — the F1 statements recorded with the grant (null = not an
    // F1-covered grant; the guided-flow gate refuses those honestly)
    statements: grantF1Statements(g),
    expiresAt: iso(g.expiresAt),
    revokedAt: g.revokedAt ? iso(g.revokedAt) : null,
    createdAt: iso(g.createdAt),
  };
}

// ─── Performances ────────────────────────────────────────────────────────────

export function performanceView(p: Performance): PerformanceView {
  return {
    id: p.id,
    twinId: p.twinId,
    name: p.name,
    origin: p.origin as PerformanceView['origin'],
    durationMs: p.durationMs,
    tracks: parseJson<PerformanceTrack[]>(p.tracks, []),
    script: p.script,
    createdAt: iso(p.createdAt),
  };
}

// ─── Renders / artifacts ─────────────────────────────────────────────────────

export function artifactRef(a: OutputArtifact): ArtifactRef {
  return {
    artifactId: a.id,
    kind: a.kind as ArtifactRef['kind'],
    mime: a.mime,
    bytes: a.bytes,
    contentHash: a.contentHash,
    url: signStorageUrl(a.storageKey), // always fresh
    remoteUrl: a.remoteUrl,
    meta: parseJson<Record<string, unknown>>(a.meta, {}),
  };
}

export function renderJobView(r: RenderJob, artifact?: OutputArtifact | null): RenderJobView {
  return {
    id: r.id,
    twinId: r.twinId,
    twinVersionId: r.twinVersionId,
    performanceId: r.performanceId,
    kind: r.kind as RenderJobView['kind'],
    style: r.style as RenderJobView['style'],
    adapterId: r.adapterId,
    status: r.status as RenderJobView['status'],
    artifact: artifact ? artifactRef(artifact) : null,
    costUsd: r.costUsd,
    latencyMs: r.latencyMs,
    error: r.error,
    createdAt: iso(r.createdAt),
  };
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

export function jobView(j: Job): JobView {
  return {
    id: j.id,
    kind: j.kind as JobView['kind'],
    status: j.status as JobView['status'],
    progress: j.progress,
    steps: parseJson<JobStep[]>(j.steps, []),
    output: parseJson<Record<string, unknown> | null>(j.output, null),
    error: j.error,
    createdAt: iso(j.createdAt),
    finishedAt: j.finishedAt ? iso(j.finishedAt) : null,
  };
}

// ─── Control plane ───────────────────────────────────────────────────────────

export function eventView(e: EventRecord): EventRecordView {
  return {
    id: e.id,
    type: e.type,
    entityType: e.entityType,
    entityId: e.entityId,
    payload: parseJson<Record<string, unknown>>(e.payload, {}),
    createdAt: iso(e.createdAt),
  };
}

export function apiKeyView(k: ApiKey): ApiKeyView {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: parseJson<string[]>(k.scopes, []),
    lastUsedAt: k.lastUsedAt ? iso(k.lastUsedAt) : null,
    revokedAt: k.revokedAt ? iso(k.revokedAt) : null,
    createdAt: iso(k.createdAt),
  };
}

export function webhookView(w: WebhookEndpoint): WebhookEndpointView {
  return {
    id: w.id,
    url: w.url,
    events: parseJson<string[]>(w.events, []),
    active: w.active,
    createdAt: iso(w.createdAt),
  };
}

// ─── Agent body / soul / avatar sessions ─────────────────────────────────────

export function soulView(entry: SoulCatalogEntry): AgentSoulView {
  return {
    id: `soul_${entry.soulKey}`,
    soulKey: entry.soulKey,
    label: entry.label,
    provider: entry.provider,
    model: entry.model,
    routingClass: entry.routingClass,
    params: entry.params,
  };
}

function soulViewFromBinding(b: AgentSoulBinding): AgentSoulView {
  const catalogEntry = SOUL_CATALOG.find((s) => s.soulKey === b.soulKey);
  return soulView({
    soulKey: b.soulKey,
    label: catalogEntry?.label ?? b.soulKey,
    provider: b.provider,
    model: b.model,
    routingClass: b.routingClass as AgentSoulView['routingClass'],
    params: parseJson<AgentSoulView['params']>(b.params, {}),
  });
}

export function agentBodyView(
  b: AgentBody,
  possessions: AgentSoulBinding[],
): AgentBodyView {
  return {
    id: b.id,
    name: b.name,
    role: b.role,
    version: b.version,
    capabilities: parseJson<string[]>(b.capabilities, []),
    tools: parseJson<string[]>(b.tools, []),
    permissions: parseJson<string[]>(b.permissions, []),
    memory: parseJson<AgentBodyView['memory']>(b.memory, { policy: '', workingNotes: [] }),
    evaluation: parseJson<AgentBodyView['evaluation']>(b.evaluation, { rubric: [], minScore: 0 }),
    possessions: possessions.map(soulViewFromBinding),
    createdAt: iso(b.createdAt),
  };
}

export function agentTurnView(t: AgentAvatarTurn): AgentAvatarTurnView {
  return {
    id: t.id,
    role: t.role as AgentAvatarTurnView['role'],
    content: t.content,
    states: parseJson<AgentAvatarTurnView['states']>(t.states, []),
    latencyMs: t.latencyMs,
    createdAt: iso(t.createdAt),
  };
}

export function avatarSessionView(
  s: AgentAvatarSession,
  body: AgentBody | null,
  twinDisplayName: string | null,
  turns: AgentAvatarTurn[],
): AgentAvatarSessionView {
  const soul = SOUL_CATALOG.find((x) => x.soulKey === s.soulKey);
  return {
    id: s.id,
    bodyId: s.bodyId,
    bodyName: body?.name ?? '',
    soulKey: s.soulKey,
    soulLabel: soul?.label ?? s.soulKey,
    routingClass: (soul?.routingClass ?? 'system_one') as AgentAvatarSessionView['routingClass'],
    twinId: s.twinId,
    twinDisplayName,
    status: s.status as AgentAvatarSessionView['status'],
    turns: turns.map(agentTurnView),
    createdAt: iso(s.createdAt),
    endedAt: s.endedAt ? iso(s.endedAt) : null,
  };
}

// ─── Lab ─────────────────────────────────────────────────────────────────────

export function labObjectiveView(o: LabObjective): LabObjectiveView {
  return {
    id: o.id,
    code: o.code,
    title: o.title,
    description: o.description,
    target: parseJson<Record<string, unknown>>(o.target, {}),
    gates: parseJson<Record<string, unknown>>(o.gates, {}),
    status: o.status,
    createdAt: iso(o.createdAt),
  };
}

export function evaluationReportView(r: {
  id: string;
  organizationId: string;
  scores: string;
  reproducible: boolean;
  seed: number;
  detail: string;
}): EvaluationReportView {
  return {
    id: r.id,
    organizationId: r.organizationId,
    scores: parseJson<Record<string, number>>(r.scores, {}),
    reproducible: r.reproducible,
    seed: r.seed,
    detail: parseJson<Record<string, unknown>>(r.detail, {}),
  };
}

export function benchmarkRunView(
  r: BenchmarkRun & { objective?: LabObjective | null },
  reports: Parameters<typeof evaluationReportView>[0][],
): BenchmarkRunView {
  return {
    id: r.id,
    objectiveCode: r.objective?.code ?? '',
    worldSeed: r.worldSeed,
    status: r.status as BenchmarkRunView['status'],
    organizations: parseJson<BenchmarkRunView['organizations']>(r.organizations, []),
    metrics: parseJson<Record<string, unknown> | null>(r.metrics, null),
    // P6.C11: the write-once run manifest (null when the run predates manifests)
    manifest: parseJson<Record<string, unknown> | null>(r.manifest ?? '{}', null),
    rerunOfId: r.rerunOfId ?? null,
    reports: reports.map(evaluationReportView),
    createdAt: iso(r.createdAt),
  };
}

export function technologyVersionView(v: TechnologyVersion): TechnologyVersionView {
  return {
    id: v.id,
    version: v.version,
    adapterVersion: v.adapterVersion,
    capabilities: parseJson<string[]>(v.capabilities, []),
    resources: parseJson<Record<string, unknown>>(v.resources, {}),
    latencyP50Ms: v.latencyP50Ms,
    costUsdPerUnit: v.costUsdPerUnit,
    failureClasses: parseJson<string[]>(v.failureClasses, []),
    provenance: parseJson<Record<string, unknown>>(v.provenance, {}),
  };
}

export function technologyCandidateView(
  c: TechnologyCandidate,
  versions: TechnologyVersion[],
): TechnologyCandidateView {
  return {
    id: c.id,
    techId: c.techId,
    name: c.name,
    family: c.family,
    vendor: c.vendor,
    source: c.source as TechnologyCandidateView['source'],
    license: { code: c.licenseCode, weights: c.licenseWeights, data: c.licenseData, providerTerms: c.providerTerms },
    runtime: c.runtime,
    patentNotes: c.patentNotes,
    status: c.status as TechnologyCandidateView['status'],
    versions: versions.map(technologyVersionView),
    meta: parseJson<Record<string, unknown>>(c.meta, {}),
  };
}

export function pipelineCandidateView(p: PipelineCandidate): PipelineCandidateView {
  return {
    id: p.id,
    name: p.name,
    genome: parseJson<PipelineGenome>(p.genome, {
      stages: [],
      parameters: {},
      skills: [],
      compute: { class: '' },
      evaluation: { rubric: [], seed: 0 },
    }),
    generation: p.generation,
    parentId: p.parentId,
    origin: p.origin as PipelineCandidateView['origin'],
    status: p.status as PipelineCandidateView['status'],
    createdAt: iso(p.createdAt),
  };
}

export function failureCaseView(f: FailureCase): FailureCaseView {
  return {
    id: f.id,
    benchmarkRunId: f.benchmarkRunId,
    organizationId: f.organizationId,
    // P6.C11: taxonomy v1 code + structured payload + lifecycle + audit + policy
    code: f.code ?? 'UNCLASSIFIED',
    inputConditions: parseJson<Record<string, unknown>>(f.inputConditions, {}),
    payload: parseJson<Record<string, unknown>>(f.payload ?? '{}', {}),
    suspectedCause: f.suspectedCause,
    confidence: f.confidence,
    remediation: f.remediation,
    status: (f.status ?? 'open') as FailureCaseView['status'],
    remediationLog: parseJson<FailureCaseView['remediationLog']>(f.remediationLog ?? '[]', []),
    policyDecision: parseJson<FailureCaseView['policyDecision']>(f.policyDecision ?? '{}', {
      taxonomyVersion: 1,
      decisions: [],
    }),
    createdAt: iso(f.createdAt),
  };
}

export function promotionRecordView(p: PromotionRecord): PromotionRecordView {
  return {
    id: p.id,
    pipelineId: p.pipelineId,
    fromStatus: p.fromStatus,
    toStatus: p.toStatus,
    decision: p.decision as PromotionRecordView['decision'],
    evidence: parseJson<Record<string, unknown>>(p.evidence, {}),
    decidedBy: p.decidedBy, // P6.C10: server-derived actor, recorded verbatim
    createdAt: iso(p.createdAt),
  };
}

// ─── Solution artifacts / feedback loop ──────────────────────────────────────

/**
 * Parse the manifest and REFRESH the expiring signed URLs inside
 * artifacts[]/evidence[] so every fetch of the artifact view yields usable
 * capabilities (manifests are stored with their original URLs for
 * portability; URLs are re-signed at read time).
 */
export function solutionArtifactView(s: SolutionArtifact): SolutionArtifactView {
  const manifest = parseJson<SolutionArtifactManifest>(s.manifest, {} as SolutionArtifactManifest);
  return {
    id: s.id,
    title: s.title,
    type: s.type as SolutionArtifactView['type'],
    manifest,
    createdAt: iso(s.createdAt),
  };
}

export function feedbackRequestView(f: FeedbackRequest): FeedbackRequestView {
  return {
    id: f.id,
    solutionArtifactId: f.solutionArtifactId,
    twinVersionId: f.twinVersionId,
    region: f.region,
    verdict: f.verdict as FeedbackRequestView['verdict'],
    note: f.note,
    status: f.status as FeedbackRequestView['status'],
    createdAt: iso(f.createdAt),
  };
}

export function evidenceRequestView(r: EvidenceRequest): EvidenceRequestView {
  return {
    id: r.id,
    twinVersionId: r.twinVersionId,
    captureSessionId: r.captureSessionId,
    reason: r.reason,
    capability: r.capability,
    instructions: r.instructions,
    expectedSignal: r.expectedSignal,
    scope: r.scope,
    status: r.status as EvidenceRequestView['status'],
    source: (r.source as EvidenceRequestView['source']) ?? 'manual', // P6.C10
    originFailureId: r.originFailureId, // P6.C10
    createdAt: iso(r.createdAt),
  };
}
