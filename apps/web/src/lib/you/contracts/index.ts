// ═══════════════════════════════════════════════════════════════════════════
// YOU — Shared Contracts v1 (TL-owned, frozen for wave 1)
// Authority: payswapdotorg/YOU — AGENTS.md, docs/ARCHITECTURE.md,
// docs/API_CONTRACTS.md, docs/DATA_MODEL.md, contracts/{htir,events,lab}/v1.
// NO model/provider/GPU vendor types may leak into this file. Implementations
// are adapters behind the seams declared here.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Opaque IDs (never meaningful, never recycled) ──────────────────────────
export type TwinId = string;
export type TwinVersionId = string;
export type CaptureSessionId = string;
export type EvidenceAssetId = string;
export type ConsentGrantId = string;
export type PerformanceId = string;
export type RenderJobId = string;
export type JobId = string;
export type AgentBodyId = string;
export type SolutionArtifactId = string;
export type EvidenceRequestId = string;
export type ApiKeyId = string;

// ─── Jobs (ADR-0005 async media: durable IDs, no fabricated progress) ───────
export const JOB_STATES = [
  'queued', 'provisioning', 'running', 'collecting',
  'succeeded', 'failed', 'cancelled', 'unavailable',
  'dead', // terminal after exhausting bounded retries (P6.A6-FULL landing — TL contracts evolution, documented in core/jobs.ts)
] as const;
export type JobState = (typeof JOB_STATES)[number];

export type JobKind =
  | 'capture.quality'      // analyze evidence set → quality + deficiencies
  | 'twin.compile'         // reconstruction: evidence → HTIR → TwinVersion
  | 'render.image'         // HTIR(+performance) → image artifact
  | 'maintenance.gc-storage' // delete unreferenced content-addressed objects (P6.A4)
  | 'render.video'         // HTIR(+performance) → video artifact
  | 'performance.fromText' // dialog text → performance tracks
  | 'lab.benchmark'        // objective → org comparison evidence
  | 'template.analyze';    // template manifest → coverage analysis (W2.B, landed 2026-10-01 per w2a-report compat note 2)

export interface JobStep {
  key: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  detail?: string;
}

export interface JobView {
  id: JobId;
  kind: JobKind;
  status: JobState;
  progress: number; // 0..1, only advances on real completion signals
  steps: JobStep[];
  output?: Record<string, unknown> | null;
  error?: string | null;
  createdAt: string;
  finishedAt?: string | null;
}

/** Seam between Worker A (job runner) and Worker C (executors). */
export interface JobContext {
  jobId: JobId;
  tenantId: string;
  /** advance progress/steps — implementations must call on real signals only */
  report: (update: { progress?: number; steps?: JobStep[]; status?: JobState }) => Promise<void>;
}
export interface JobExecutorResult {
  output: Record<string, unknown>;
  /** canonical entity ids touched, for events/audit */
  entities?: { type: string; id: string }[];
}
export interface JobExecutor {
  kind: JobKind;
  execute(input: Record<string, unknown>, ctx: JobContext): Promise<JobExecutorResult>;
}

// ─── HTIR v1 — the canonical semantic representation ────────────────────────
// Stored shape conforms to contracts/htir/v1/htir.schema.json:
// { twinId, version, morphology, geometry, appearance, articulation?,
//   neuralAppearance?, motionProfile?, voice?, styleProfiles, confidence, provenance }
// identity/consent references live inside `provenance` (schema allows objects).

export interface HtirProvenance {
  subjectId: string;
  consentGrantIds: string[];
  evidenceAssetIds: string[];
  evidenceHashes: string[]; // sha256 of each input asset, in order
  pipeline: { pipelineId: string; components: { adapterId: string; version: string }[] };
  compiledAt: string;
  compiledBy: 'twin.compile';
}

export interface HtirConfidenceDeficiency {
  capability: string;   // e.g. 'face.profile', 'hair', 'hands', 'silhouette'
  severity: 'low' | 'medium' | 'high';
  reason: string;
  remediation: string;  // maps to targeted evidence requests
}

export interface HtirConfidence {
  overall: number; // 0..1
  byDomain: Record<string, number>;
  deficiencies: HtirConfidenceDeficiency[];
}

export interface HtirMorphology {
  build?: string;          // e.g. 'slim', 'athletic', 'average'
  heightEstimateCm?: number;
  ageEstimate?: string;
  presentation?: string;   // gender presentation descriptor (self-identified)
  descriptors: string[];   // free, respectful textual descriptors
}

export interface HtirGeometry {
  skeleton: string;              // skeleton convention, e.g. 'you-generic-v1'
  measurements: Record<string, number>; // e.g. { shoulderRatio, headRatio }
  face: { landmarkSummary?: string; proportions?: Record<string, number> };
  hands: { detail: 'low' | 'medium' | 'high' };
}

export interface HtirAppearance {
  palette: { skin?: string; hair?: string; eyes?: string; clothing?: string[] };
  hair: { style?: string; length?: string; coverage: 'low' | 'medium' | 'high' };
  clothing: { style?: string; items: string[] };
  distinguishing: string[]; // glasses, beard, freckles…
}

export interface HtirArticulation {
  blendshapes: string[];    // supported blendshape set
  gazeModel: 'basic' | 'tracked';
}

export interface HtirNeuralAppearance {
  enabled: boolean;
  adapterId?: string;       // neural appearance adapter reference
  notes?: string;
}

export interface HtirMotionProfile {
  defaultPose: string;
  gestureStyle: string;
  tempo: 'calm' | 'moderate' | 'energetic';
}

export interface HtirVoice {
  pitch: 'low' | 'mid' | 'high';
  pace: string;
  style: string;
  ttsReady: boolean;
}

export type RenderStyle =
  | 'photorealistic' | 'anime' | 'cartoon' | 'low-poly'
  | 'game' | 'illustration' | 'stylized-portrait';

export interface HtirStyleProfile {
  style: RenderStyle;
  params: Record<string, unknown>;
}

export interface HTIR {
  twinId: TwinId;
  version: number;
  morphology: HtirMorphology;
  geometry: HtirGeometry;
  appearance: HtirAppearance;
  articulation?: HtirArticulation;
  neuralAppearance?: HtirNeuralAppearance;
  motionProfile?: HtirMotionProfile;
  voice?: HtirVoice | null;
  styleProfiles: HtirStyleProfile[];
  confidence: HtirConfidence;
  provenance: HtirProvenance;
}

// ─── Evidence ────────────────────────────────────────────────────────────────
export type EvidenceKind = 'image' | 'video' | 'audio';
export type CaptureRegion =
  | 'face.front' | 'face.profile' | 'face.hairline' | 'teeth'
  | 'hands' | 'hair.back' | 'silhouette.front' | 'silhouette.side'
  | 'walking' | 'speech' | 'custom';

export interface EvidenceQuality {
  usable: boolean;
  blur: 'none' | 'light' | 'heavy';
  lighting: 'good' | 'uneven' | 'poor';
  coverage: CaptureRegion[];
  issues: string[];
  score: number; // 0..1
}

export interface CaptureChecklistItem {
  item: string;
  capability: string;
  region: CaptureRegion;
  instructions: string;
  status: 'pending' | 'provided' | 'waived';
  expectedSignal: string;
}

export interface EvidenceAssetView {
  id: EvidenceAssetId;
  kind: EvidenceKind;
  regions: CaptureRegion[];
  contentHash: string;
  bytes: number;
  mime: string;
  quality: EvidenceQuality | null;
  createdAt: string;
}

export interface CaptureSessionView {
  id: CaptureSessionId;
  twinId: TwinId;
  status: 'pending' | 'uploading' | 'analyzing' | 'complete' | 'failed';
  checklist: CaptureChecklistItem[];
  instructions?: string | null;
  error?: string | null;
  createdAt: string;
  completedAt?: string | null;
  assets: EvidenceAssetView[];
}

// ─── Consent (explicit, scoped, revocable, server-enforced) ─────────────────
export type ConsentScope =
  | 'capture'      // allow capture sessions for the subject
  | 'reconstruct'  // allow reconstruction into HTIR/TwinVersions
  | 'render'       // allow rendering derived outputs
  | 'embodiment';  // allow agent avatar embodiment

export interface ConsentGrantView {
  id: ConsentGrantId;
  subjectId: string;
  granteeId: string;
  purpose: string;
  scopes: ConsentScope[];
  operations: string[];
  outputs: string[]; // derived-only by default; raw evidence never included
  expiresAt: string;
  revokedAt?: string | null;
  createdAt: string;
}

// ─── Twin ────────────────────────────────────────────────────────────────────
export interface TwinView {
  id: TwinId;
  displayName: string;
  personName?: string | null;
  subjectId: string;
  status: 'draft' | 'capturing' | 'reconstructed' | 'ready';
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface TwinVersionView {
  id: TwinVersionId;
  twinId: TwinId;
  version: number;
  status: 'draft' | 'published';
  confidenceSummary: HtirConfidence | null;
  evidenceAssetIds: string[];
  pipelineId?: string | null;
  inputVersionIds: string[];
  createdAt: string;
  htir: HTIR; // full canonical document
}

// ─── Performance (first-class, identity-independent) ────────────────────────
export type PerformanceState =
  | 'listening' | 'reading' | 'typing' | 'thinking' | 'tool_use'
  | 'speaking' | 'interrupted' | 'idle' | 'unavailable';

// conforms to contracts/events/v1/agent-performance-events.schema.json
export interface AgentPerformanceEvent {
  eventId: string;
  sessionId: string;
  type: PerformanceState | 'custom';
  timestamp: string;
  durationMs: number | null;
  source: 'llm' | 'application' | 'user' | 'sensor' | 'generated';
  payload?: Record<string, unknown>;
}

export interface PerformanceTrackFrame {
  t: number; // ms from performance start
  state?: PerformanceState;
  intensity?: number; // 0..1
  note?: string;
}

export interface PerformanceTrack {
  trackId: string;
  kind: 'state' | 'expression' | 'gaze' | 'gesture' | 'speech';
  frames: PerformanceTrackFrame[];
}

export interface PerformanceView {
  id: PerformanceId;
  twinId?: TwinId | null;
  name: string;
  origin: 'text' | 'audio' | 'video' | 'motion' | 'generated' | 'interaction';
  durationMs?: number | null;
  tracks: PerformanceTrack[];
  script?: string | null;
  createdAt: string;
}

// ─── Render ──────────────────────────────────────────────────────────────────
export interface RenderJobView {
  id: RenderJobId;
  twinId: TwinId;
  twinVersionId: TwinVersionId;
  performanceId?: PerformanceId | null;
  kind: 'image' | 'video';
  style: RenderStyle;
  adapterId?: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  artifact?: ArtifactRef | null;
  costUsd?: number | null;
  latencyMs?: number | null;
  error?: string | null;
  createdAt: string;
}

export interface ArtifactRef {
  artifactId: string;
  kind: 'image' | 'video' | 'svg' | 'htir' | 'report' | 'manifest';
  mime: string;
  bytes: number;
  contentHash: string;
  url: string;      // signed, expiring URL
  remoteUrl?: string | null;
  meta: Record<string, unknown>;
}

// ─── Agent Body / Soul (ADR-0002) ───────────────────────────────────────────
export interface AgentBodyView {
  id: AgentBodyId;
  name: string;
  role: string;
  version: number;
  capabilities: string[];
  tools: string[];
  permissions: string[];
  memory: { policy: string; workingNotes: string[] };
  evaluation: { rubric: string[]; minScore: number };
  possessions: AgentSoulView[]; // souls this body has been possessed by
  createdAt: string;
}

export type RoutingClass = 'system_one' | 'system_two';

export interface AgentSoulView {
  id: string;
  soulKey: string;         // catalog key
  label: string;
  provider: string;        // adapter id — never a hard vendor in contracts
  model: string;           // model binding label
  routingClass: RoutingClass;
  params: { thinking?: boolean; temperature?: number; notes?: string };
}

export interface AgentAvatarTurnView {
  id: string;
  role: 'user' | 'agent';
  content: string;
  states: AgentPerformanceEvent[];
  latencyMs?: number | null;
  createdAt: string;
}

export interface AgentAvatarSessionView {
  id: string;
  bodyId: AgentBodyId;
  bodyName: string;
  soulKey: string;
  soulLabel: string;
  routingClass: RoutingClass;
  twinId?: TwinId | null;
  twinDisplayName?: string | null;
  status: 'live' | 'ended';
  turns: AgentAvatarTurnView[];
  createdAt: string;
  endedAt?: string | null;
}

// ─── Technology Registry (ADR-0003) ─────────────────────────────────────────
export type TechnologyStatus =
  | 'research' | 'candidate' | 'validated' | 'production'
  | 'retired' | 'closed-characterized';

export interface TechnologyCandidateView {
  id: string;
  techId: string;
  name: string;
  family: string;
  vendor?: string | null;
  source: 'open' | 'closed' | 'fixture';
  license: { code: string; weights: string; data: string; providerTerms: string };
  runtime: string;
  patentNotes: string;
  status: TechnologyStatus;
  versions: TechnologyVersionView[];
  meta: Record<string, unknown>;
}

export interface TechnologyVersionView {
  id: string;
  version: string;
  adapterVersion: string;
  capabilities: string[];
  resources: Record<string, unknown>;
  latencyP50Ms?: number | null;
  costUsdPerUnit?: number | null;
  failureClasses: string[];
  provenance: Record<string, unknown>;
}

// ─── Lab (simulated research truth — never production truth) ────────────────
export interface LabObjectiveView {
  id: string;
  code: string; // 'HUMAN-RECON-001'
  title: string;
  description: string;
  target: Record<string, unknown>;
  gates: Record<string, unknown>;
  status: string;
  createdAt: string;
}

// conforms to contracts/lab/v1/world.schema.json
export interface LabWorldSpec {
  worldId: string;
  seed: number;
  actors: Record<string, unknown>[];
  cameras?: Record<string, unknown>[];
  lighting?: Record<string, unknown>;
  environment?: Record<string, unknown>;
  sensors: Record<string, unknown>[];
  noise?: Record<string, unknown>;
  occlusions?: Record<string, unknown>[];
  groundTruth: Record<string, unknown>;
}

export type PipelineGenomeStage = {
  adapterId: string;
  version: string;
  params: Record<string, unknown>;
};

export interface PipelineGenome {
  stages: PipelineGenomeStage[];
  parameters: Record<string, unknown>;
  skills: string[];
  organizationId?: string;
  soulKey?: string;
  compute: { class: string; maxCostUsd?: number };
  evaluation: { rubric: string[]; seed: number };
}

export interface PipelineCandidateView {
  id: string;
  name: string;
  genome: PipelineGenome;
  generation: number;
  parentId?: string | null;
  origin: 'generalist' | 'hand-designed' | 'searched';
  status: 'draft' | 'benchmarked' | 'validated' | 'canary' | 'production' | 'retired';
  createdAt: string;
}

export interface OrganizationDescriptor {
  organizationId: string;
  label: string;
  origin: 'generalist' | 'hand-designed' | 'searched';
  bodies: { role: string; capabilities: string[]; soulKey?: string }[];
  pipelineId?: string;
}

export interface EvaluationReportView {
  id: string;
  organizationId: string;
  scores: Record<string, number>; // coverage, confidence, latencyMs, costUsd, determinism…
  reproducible: boolean;
  seed: number;
  detail: Record<string, unknown>;
}

export interface BenchmarkRunView {
  id: string;
  objectiveCode: string;
  worldSeed: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  organizations: OrganizationDescriptor[];
  metrics?: Record<string, unknown> | null;
  reports: EvaluationReportView[];
  createdAt: string;
}

export interface FailureCaseView {
  id: string;
  benchmarkRunId?: string | null;
  organizationId?: string | null;
  inputConditions: Record<string, unknown>;
  suspectedCause: string;
  confidence: number;
  remediation?: string | null;
  createdAt: string;
}

export interface PromotionRecordView {
  id: string;
  pipelineId: string;
  fromStatus: string;
  toStatus: string;
  decision: 'promoted' | 'rejected' | 'reverted' | 'drafted';
  evidence: Record<string, unknown>;
  createdAt: string;
}

// ─── Solution Artifacts (ADR-0004: review surface, never authority) ─────────
export interface SolutionArtifactManifest {
  solutionId: string;
  version: number;
  type: 'twin-review' | 'render-review' | 'benchmark-report' | 'avatar-session';
  title: string;
  inputs: { label: string; kind: string; ref: string }[];
  twinVersion?: { id: string; version: number } | null;
  performance?: { id: string; name: string } | null;
  pipeline?: { id: string; name: string } | null;
  organization?: { id: string; label: string } | null;
  artifacts: { artifactId: string; label: string; kind: string; url: string }[];
  evidence: { assetId: string; label: string; contentHash: string; url: string }[];
  consent: { grantIds: string[]; scopes: ConsentScope[]; subjectId: string };
  provenance: Record<string, unknown>;
  feedback_schema: {
    verdicts: string[];
    regions: string[];
  };
  evidence_request_schema: {
    capabilities: string[];
  };
  export_targets: string[];
}

export interface SolutionArtifactView {
  id: SolutionArtifactId;
  title: string;
  type: SolutionArtifactManifest['type'];
  manifest: SolutionArtifactManifest;
  createdAt: string;
}

export type FeedbackVerdict =
  | 'correct' | 'incorrect' | 'uncertain' | 'missing-detail'
  | 'wrong-motion' | 'wrong-identity' | 'wrong-style';

export interface FeedbackRequestView {
  id: string;
  solutionArtifactId?: string | null;
  twinVersionId: string;
  region?: string | null;
  verdict: FeedbackVerdict;
  note?: string | null;
  status: 'open' | 'addressed';
  createdAt: string;
}

export interface EvidenceRequestView {
  id: string;
  twinVersionId?: string | null;
  captureSessionId?: string | null;
  reason: string;
  capability: string;
  instructions: string;
  expectedSignal: string;
  scope: string;
  status: 'open' | 'fulfilled' | 'expired';
  createdAt: string;
}

// ─── Control plane: session / keys / events / usage ─────────────────────────
export interface SessionInfo {
  user: { id: string; email: string; name: string; role: string };
  tenant: { id: string; name: string; slug: string };
}

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt?: string | null;
  revokedAt?: string | null;
  createdAt: string;
}

export interface ApiKeySecret {
  key: ApiKeyView;
  secret: string; // shown once
}

export interface EventRecordView {
  id: string;
  type: string;
  entityType: string;
  entityId?: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface WebhookEndpointView {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
}

export interface UsageSummary {
  metrics: { metric: string; quantity: number; unit: string }[];
  totals: { evidenceMb: number; jobs: number; renders: number; llmCalls: number };
}

// ─── Compute Broker (provider-neutral, ADR-0003) ────────────────────────────
export interface ComputeRequest {
  workload: string;
  minVramGb?: number;
  maxCostUsd?: number;
  privacy?: 'tenant' | 'managed' | 'any';
}
export interface ComputeQuote {
  providerId: string;
  class: string;
  costUsd: number;
  etaSeconds: number;
  accepted: boolean;
}
export interface ComputeProviderAdapter {
  id: string;
  capabilities(): unknown;
  quote(req: ComputeRequest): Promise<ComputeQuote>;
  submit(req: ComputeRequest): Promise<string>;
  status(id: string): Promise<unknown>;
  cancel(id: string): Promise<void>;
}

// ─── Dashboard aggregates ────────────────────────────────────────────────────
export interface OverviewStats {
  twins: number;
  twinsReady: number;
  captures: number;
  evidenceAssets: number;
  versions: number;
  renders: number;
  activeGrants: number;
  openEvidenceRequests: number;
  labRuns: number;
  recentEvents: EventRecordView[];
  pipeline: { stage: string; count: number; hint: string }[];
}

// ─── API error envelope (stable machine codes) ──────────────────────────────
export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}
export const ERR = {
  UNAUTHENTICATED: 'unauthenticated',
  FORBIDDEN: 'forbidden',
  CONSENT_REQUIRED: 'consent_required',
  NOT_FOUND: 'not_found',
  VALIDATION: 'validation_failed',
  CONFLICT: 'conflict',
  RATE_LIMITED: 'rate_limited',
  COMPUTE_QUOTA_EXCEEDED: 'compute_quota_exceeded',
  COMPUTE_QUOTA_UNVERIFIABLE: 'compute_quota_unverifiable',
  POLICY: 'policy_blocked',
  SERVICE_UNAVAILABLE: 'service_unavailable',
  INTERNAL: 'internal_error',
} as const;
