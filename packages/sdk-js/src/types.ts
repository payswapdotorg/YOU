// ═══════════════════════════════════════════════════════════════════════════
// @you/sdk-js — typed view/enum surface (Worker A lane, A8)
//
// TRANSITIONAL DUPLICATION (deliberate, documented in README.md): these shapes
// duplicate apps/web/src/lib/you/contracts/index.ts (TL-owned, frozen) plus the
// lane-owned TemplateView family (apps/web/src/lib/you/core/templates.ts) and
// VerificationSessionView family (apps/web/src/lib/you/core/verification.ts),
// because this package MUST NOT import from apps/web. The server routes are
// the authority; drift between these types and the server's serialized views
// is an integration bug. TL collapses the duplication at landing time.
//
// No runtime code lives in this module — types and constants only.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Ids (opaque string brands) ─────────────────────────────────────────────
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

// ─── Jobs (durable, no fabricated progress) ──────────────────────────────────
export type JobState =
  | 'queued' | 'provisioning' | 'running' | 'collecting'
  | 'succeeded' | 'failed' | 'cancelled' | 'unavailable' | 'dead';

export type JobKind =
  | 'capture.quality'
  | 'twin.compile'
  | 'render.image'
  | 'render.video'
  | 'performance.fromText'
  | 'lab.benchmark'
  | 'template.analyze'
  | 'f1.reconstruct';

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
  progress: number;
  steps: JobStep[];
  output?: Record<string, unknown> | null;
  error?: string | null;
  createdAt: string;
  finishedAt?: string | null;
}

// ─── HTIR v1 (canonical semantic representation — contracts/htir/v1) ────────
export type RenderStyle =
  | 'photorealistic' | 'anime' | 'cartoon' | 'low-poly'
  | 'game' | 'illustration' | 'stylized-portrait';

export interface HtirStyleProfile {
  style: RenderStyle;
  params: Record<string, unknown>;
}

export interface HtirProvenance {
  subjectId: string;
  consentGrantIds: string[];
  evidenceAssetIds: string[];
  evidenceHashes: string[];
  pipeline: { pipelineId: string; components: { adapterId: string; version: string }[] };
  compiledAt: string;
  compiledBy: 'twin.compile' | 'f1.reconstruct';
}

export interface HtirConfidenceDeficiency {
  capability: string;
  severity: 'low' | 'medium' | 'high';
  reason: string;
  remediation: string;
}

export interface HtirConfidence {
  overall: number;
  byDomain: Record<string, number>;
  deficiencies: HtirConfidenceDeficiency[];
}

export interface HtirMorphology {
  build?: string;
  heightEstimateCm?: number;
  ageEstimate?: string;
  presentation?: string;
  descriptors: string[];
}

export interface HtirGeometry {
  skeleton: string;
  measurements: Record<string, number>;
  face: { landmarkSummary?: string; proportions?: Record<string, number> };
  hands: { detail: 'low' | 'medium' | 'high' };
}

export interface HtirAppearance {
  palette: { skin?: string; hair?: string; eyes?: string; clothing?: string[] };
  hair: { style?: string; length?: string; coverage: 'low' | 'medium' | 'high' };
  clothing: { style?: string; items: string[] };
  distinguishing: string[];
}

export interface HtirArticulation {
  blendshapes: string[];
  gazeModel: 'basic' | 'tracked';
}

export interface HtirNeuralAppearance {
  enabled: boolean;
  adapterId?: string;
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
export type ConsentScope = 'capture' | 'reconstruct' | 'render' | 'embodiment';

export interface ConsentGrantView {
  id: ConsentGrantId;
  subjectId: string;
  granteeId: string;
  purpose: string;
  scopes: ConsentScope[];
  operations: string[];
  outputs: string[];
  expiresAt: string;
  revokedAt?: string | null;
  createdAt: string;
}

// ─── Twins ───────────────────────────────────────────────────────────────────
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
  htir: HTIR;
}

// ─── Performances (identity-independent) ────────────────────────────────────
export type PerformanceState =
  | 'listening' | 'reading' | 'typing' | 'thinking' | 'tool_use'
  | 'speaking' | 'interrupted' | 'idle' | 'unavailable';

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
  t: number;
  state?: PerformanceState;
  intensity?: number;
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

// ─── Renders ─────────────────────────────────────────────────────────────────
export interface ArtifactRef {
  artifactId: string;
  kind: 'image' | 'video' | 'svg' | 'htir' | 'report' | 'manifest';
  mime: string;
  bytes: number;
  contentHash: string;
  url: string; // signed, expiring URL
  remoteUrl?: string | null;
  meta: Record<string, unknown>;
}

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

// ─── Templates and scenes (W2.B; lane-owned views) ──────────────────────────
export interface TemplateChecklistItem {
  item: string;
  capability: string;
  region: CaptureRegion;
  instructions: string;
  expectedSignal: string;
  optional: boolean;
}

export interface TemplateStylePreset {
  name: string;
  style: RenderStyle;
  params: Record<string, unknown>;
}

export interface TemplateManifest {
  captureChecklist: TemplateChecklistItem[];
  stylePresets: TemplateStylePreset[];
  notes?: string;
}

export interface SceneRecipeView {
  id: string;
  templateId: string;
  name: string;
  parameters: Record<string, unknown>;
  createdAt: string;
}

export interface TemplateAnalysis {
  templateId: string;
  templateVersion: number;
  analyzedAt: string;
  capabilities: { covered: string[]; uncovered: string[] };
  evidenceGaps: string[];
  checklist: { items: number; required: number; optional: number; invalidRegions: string[] };
  scenes: { count: number; invalid: string[] };
  stylePresets: { count: number; valid: string[]; invalid: string[] };
  notes: string[];
}

export interface TemplateView {
  id: string;
  name: string;
  description: string | null;
  version: number;
  status: 'draft' | 'published';
  manifest: TemplateManifest;
  scenes: SceneRecipeView[];
  analysis: TemplateAnalysis | null;
  analyzedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Verification sessions (§Trust; A4) ──────────────────────────────────────
// Semantics per docs/SECURITY_PRIVACY.md controls 2–3: this surface NEVER
// claims an identity match or visual similarity — identityMatch and
// visualSimilarity are null by contract; ownershipConfidence is an
// evidence-quality signal only, null when no machine analysis exists.
export type VerificationMethod = 'liveness-challenge';

export interface LivenessChallenge {
  challengeId: string;
  nonce: string;
  variant: string;
  prompt: string;
  instructions: string;
  requiredRegions: CaptureRegion[];
  issuedAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface VerificationResult {
  outcome: 'liveness-verified' | 'liveness-failed' | 'inconclusive';
  liveness: {
    status: 'passed' | 'failed' | 'inconclusive';
    onTime: boolean;
    coveredRegions: string[];
    missingRegions: string[];
    note: string;
  };
  ownershipConfidence: number | null;
  visualSimilarity: null;
  identityMatch: null;
  evaluatedAt: string;
  evidenceAssetIds: string[];
  notes: string[];
}

export interface VerificationSessionView {
  id: string;
  subjectId: string;
  twinId: string | null;
  purpose: string;
  method: VerificationMethod;
  status: 'pending' | 'in_review' | 'evaluated' | 'expired';
  challenge: LivenessChallenge | null;
  evidenceAssetIds: string[];
  result: VerificationResult | null;
  consentGrantId: string | null;
  expiresAt: string;
  createdAt: string;
  submittedAt: string | null;
  evaluatedAt: string | null;
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
  possessions: AgentSoulView[];
  createdAt: string;
}

export type RoutingClass = 'system_one' | 'system_two';

export interface AgentSoulView {
  id: string;
  soulKey: string;
  label: string;
  provider: string;
  model: string;
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

// ─── Labs (simulated research truth — never production truth) ───────────────
export interface LabObjectiveView {
  id: string;
  code: string;
  title: string;
  description: string;
  target: Record<string, unknown>;
  gates: Record<string, unknown>;
  status: string;
  createdAt: string;
}

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

export interface PipelineGenomeStage {
  adapterId: string;
  version: string;
  params: Record<string, unknown>;
}

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
  scores: Record<string, number>;
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

// ─── Solution Artifacts (review surface, never authority) ───────────────────
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
  feedback_schema: { verdicts: string[]; regions: string[] };
  evidence_request_schema: { capabilities: string[] };
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
  POLICY: 'policy_blocked',
  INTERNAL: 'internal_error',
} as const;

export type ErrCode = (typeof ERR)[keyof typeof ERR];
