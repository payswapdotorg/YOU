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
  | 'template.analyze'    // template manifest → coverage analysis (W2.B, landed 2026-10-01 per w2a-report compat note 2)
  | 'f1.reconstruct';     // real-human F1 reconstruction pipeline (P6.C4)

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
  compiledBy: 'twin.compile' | 'f1.reconstruct';
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
  // ── P6.B3 lane-widening (additive, optional): guided F1 flow state ────────
  // Present only on sessions created via POST /twins/:id/capture-sessions/f1;
  // every legacy session returns these as null and behaves exactly as before.
  consentGrantId?: string | null;
  protocol?: F1ProtocolState | null;
  checkpoints?: Record<string, unknown> | null;
  manifest?: F1EvidenceManifest | null;
  retention?: F1ConsentStatements['retention'] & { deletionProcess?: string } | null;
  review?: F1ReviewState | null;
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
  // P6.B3 lane-widening (additive, optional): the F1 operator-capture
  // statements recorded with the grant (docs/F1_OPERATOR_CAPTURE.md
  // "Required consent"). null/absent for every pre-B3 grant — the F1 guided
  // flow's server-side gate refuses those with a machine-readable
  // missingStatements list instead of silently passing.
  statements?: F1ConsentStatements | null;
  expiresAt: string;
  revokedAt?: string | null;
  createdAt: string;
}

// ─── F1 operator capture flow (P6.B3, docs/F1_OPERATOR_CAPTURE.md) ──────────

/** The six consent statements F1 capture consent must explicitly state. */
export interface F1ConsentStatements {
  /** what is captured */
  what: string;
  /** why it is captured */
  why: string;
  /** which product tests will use it (≥1) */
  tests: string[];
  /** whether the sample may be retained, under which policy, and until when */
  retention: {
    mayBeRetained: boolean;
    /** ISO date — retention window while the grant is active */
    retainUntil?: string;
    /** the stated retention policy (free text, shown to the subject) */
    policy: string;
  };
  /** training permission — SEPARATE and default-DENIED */
  training: { permitted: boolean; note?: string };
  /** the deletion/withdrawal process */
  deletion: string;
}

/** Per-step state of the guided 8-step protocol. */
export type F1StepState = 'pending' | 'current' | 'done' | 'skipped';

/** One guided step, with the ACTUAL persisted operator instruction text. */
export interface F1GuidedStep {
  step: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  id: string;
  label: string;
  /** operator-facing instruction — persisted verbatim with the capture
   * (docs/F1_OPERATOR_CAPTURE.md: "the actual instructions for the acceptance
   * fixture must be persisted with the capture") */
  instruction: string;
  /** canonical regions this step machines as evidence */
  regions: CaptureRegion[];
  /** honest disclosure where the wave-1 region model coarse-grains framings */
  coarseGrainingNote?: string;
  /** steps 1–7 are required; step 8 (speech/performance) is optional */
  required: boolean;
  state: F1StepState;
  skipReason?: string;
  assetId?: string;
  contentHash?: string;
  checkpoint?: F1StepCheckpoint;
  submittedAt?: string;
}

/**
 * P6.B5 — targeted fulfillment context: present when this guided session was
 * opened to fulfill an EvidenceRequest. `focusedStepIds` is EMPTY when the
 * requested capability had no direct protocol-step mapping — then the full
 * standard protocol applies (honest fallback, never a fabricated focus).
 */
export interface F1FulfillmentContext {
  requestId: string;
  capability: string;
  reason: string;
  instructions: string;
  expectedSignal: string;
  focusedStepIds: string[];
}

/** The persisted protocol document on a guided capture session. */
export interface F1ProtocolState {
  version: 'f1-operator-capture/v1';
  source: 'docs/F1_OPERATOR_CAPTURE.md';
  steps: F1GuidedStep[];
  currentStepId: string | null;
  /** P6.B5 — set only on sessions opened via a guided evidence-request fulfillment */
  fulfillment?: F1FulfillmentContext;
}

/**
 * Per-step quality/liveness checkpoint (heuristic, byte-level — mirrors the
 * C-lane f1LivenessCheckpoint taxonomy). Honest by construction: every check
 * is named, region coverage is DECLARED (not machine-observed), and video/
 * audio duration is disclosed as not verifiable at this wave.
 */
export interface F1StepCheckpoint {
  stepId: string;
  assetId?: string;
  passed: boolean;
  checks: {
    filePresent: boolean;
    plausibleSize: boolean;
    decodable: boolean;
    plausibleAspect: boolean | null; // null when the container carries no dims (video/audio)
    requiredRegionsCovered: 'declared' | 'none';
  };
  sniffed?: { container: string; mimeFamily: string; canonicalMime: string; width?: number; height?: number };
  refusal?: { code: string; message: string };
  issues: string[];
  score: number; // 0..1 — honest heuristic score over the named checks
}

/** Content-addressed evidence manifest persisted at guided-flow completion. */
export interface F1EvidenceManifest {
  version: 'f1-evidence-manifest/v1';
  algorithm: 'sha256';
  captureSessionId: CaptureSessionId;
  provenance: {
    twinId: TwinId;
    subjectId: string;
    consentGrantId: string;
    capturedVia: 'f1-guided-flow/v1';
  };
  deletionPolicy: F1ConsentStatements['retention'] & { deletionProcess: string };
  assets: {
    assetId: EvidenceAssetId;
    stepId: string | null;
    storageKey: string;
    contentHash: string;
    /** re-hashed from the stored bytes at manifest-build time */
    verified: boolean;
    bytes: number;
    mime: string;
    regions: CaptureRegion[];
    checkpointPassed: boolean | null;
  }[];
  totals: { assets: number; verified: number; bytes: number };
  builtAt: string;
}

/** Review state + the F1 acceptance chain (capture → … → review). */
export interface F1ReviewState {
  status: 'none' | 'promoted' | 'rejected';
  verdict?: 'approve' | 'reject';
  note?: string;
  reviewerActorType?: string;
  reviewerActorId?: string;
  decidedAt?: string;
  twinVersionId?: TwinVersionId;
  twinVersionNumber?: number;
  chain?: F1AcceptanceChain;
}

/** The acceptance chain recorded at promotion (docs/F1_OPERATOR_CAPTURE.md). */
export interface F1AcceptanceChain {
  capture: { captureSessionId: CaptureSessionId; createdAt: string; completedAt: string | null };
  consent: { grantId: ConsentGrantId; statements: F1ConsentStatements };
  liveness: { stepsChecked: number; refusals: number; summary: string };
  quality: { stepsDone: number; stepsSkipped: number; skippedRequired: string[]; score: number | null };
  reconstruction: { twinVersionId: TwinVersionId; version: number; compiledBy?: string; pipelineId?: string | null };
  review: { verdict: 'approve' | 'reject'; note?: string; decidedAt: string };
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
  /** P6.C11: the write-once run manifest (null when the run predates manifests). */
  manifest?: Record<string, unknown> | null;
  /** P6.C11: this run re-ran the referenced run (its parent). */
  rerunOfId?: string | null;
  reports: EvaluationReportView[];
  createdAt: string;
}

export interface FailureCaseView {
  id: string;
  benchmarkRunId?: string | null;
  organizationId?: string | null;
  /** P6.C11: failure-code taxonomy v1 (region/stage/provider/policy classes). */
  code: string;
  inputConditions: Record<string, unknown>;
  /** structured payload per the taxonomy code. */
  payload: Record<string, unknown>;
  suspectedCause: string;
  confidence: number;
  remediation?: string | null;
  /** P6.C11 lifecycle: open | mitigated | verified. */
  status: 'open' | 'mitigated' | 'verified';
  /** audit entries (who/when/evidence) per remediation transition. */
  remediationLog: Array<{
    action: 'mitigate' | 'verify';
    from: string;
    to: string;
    actorType: 'user' | 'application';
    actorId: string;
    tenantId: string;
    evidence: string;
    note?: string;
    at: string;
  }>;
  /** recorded policy decisions for the case's class (enforced vs proposed, with basis). */
  policyDecision: {
    taxonomyVersion: number;
    decisions: Array<{
      code: string;
      action: 'retry' | 'fallback' | 'quarantine' | 'escalate';
      status: 'enforced' | 'proposed';
      basis: string;
    }>;
  };
  createdAt: string;
}

// ─── P6.C11: run comparison + regression detection (machine-readable verdict) ─
export interface RunCompareView {
  baselineRunId: string;
  candidateRunId: string;
  objectiveCode: { baseline: string; candidate: string; match: boolean };
  worldSeed: number;
  thresholds: {
    applied: Record<string, number>;
    defaults: Record<string, number>;
    overridden: string[];
    docs: Record<string, string>;
  };
  organizations: Array<{
    organizationId: string;
    presentIn: { baseline: boolean; candidate: boolean };
    metrics: Array<{
      metric: string;
      direction: 'higher-better' | 'lower-better' | 'unknown';
      baselineValue: number;
      candidateValue: number;
      delta: number;
      deltaKind: 'absolute' | 'relative-pct' | 'none';
      changed: boolean;
    }>;
    stages: Array<{
      adapterId: string;
      role: string;
      baselineModeledLatencyMs: number;
      candidateModeledLatencyMs: number;
      deltaModeledLatencyMs: number;
      baselineModeledCostUsd: number;
      candidateModeledCostUsd: number;
      deltaModeledCostUsd: number;
      observedLatencyMs: { baseline: number | null; candidate: number | null };
    }>;
    regressions: Array<{ organizationId: string; metric: string; kind: string; threshold: number; observed: number; detail: string }>;
    improvements: Array<{ organizationId: string; metric: string; kind: string; threshold: number; observed: number; detail: string }>;
  }>;
  regressionFlags: Array<{ organizationId: string; metric: string; kind: string; threshold: number; observed: number; detail: string }>;
  improvementFlags: Array<{ organizationId: string; metric: string; kind: string; threshold: number; observed: number; detail: string }>;
  verdict: 'regression' | 'improvement' | 'no_material_change';
  verdictBasis: string;
  honestyNotes: string[];
}

// ─── P6.C11: Failure Atlas aggregation (production surface) ──────────────────
export interface FailureAtlasView {
  taxonomyVersion: number;
  window: { from: string | null; to: string | null; filteredOut: number; note: string };
  totals: {
    cases: number;
    open: number;
    mitigated: number;
    verified: number;
    meanConfidence: number | null;
    unclassified: number;
  };
  byCode: Array<{
    code: string;
    class: 'region' | 'stage' | 'provider' | 'policy';
    count: number;
    meanConfidence: number;
    minConfidence: number;
    maxConfidence: number;
    open: number;
    mitigated: number;
    verified: number;
    topSuspectedCauses: Array<{ cause: string; count: number }>;
    policy: Array<{
      code: string;
      action: 'retry' | 'fallback' | 'quarantine' | 'escalate';
      status: 'enforced' | 'proposed';
      basis: string;
    }>;
  }>;
  byRegion: Array<{ key: string; count: number; meanConfidence: number; minConfidence: number; maxConfidence: number; open: number; mitigated: number; verified: number; topSuspectedCauses: Array<{ cause: string; count: number }> }>;
  byPipeline: Array<{ key: string; count: number; meanConfidence: number; minConfidence: number; maxConfidence: number; open: number; mitigated: number; verified: number; topSuspectedCauses: Array<{ cause: string; count: number }> }>;
  byTechnologyVersion: Array<{ key: string; count: number; meanConfidence: number; minConfidence: number; maxConfidence: number; open: number; mitigated: number; verified: number; topSuspectedCauses: Array<{ cause: string; count: number }> }>;
  honestyNotes: string[];
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
  type: 'twin-review' | 'render-review' | 'benchmark-report' | 'avatar-session' | 'performance-review';
  title: string;
  inputs: { label: string; kind: string; ref: string }[];
  twinVersion?: { id: string; version: number } | null;
  performance?: { id: string; name: string } | null;
  pipeline?: { id: string; name: string } | null;
  organization?: { id: string; label: string } | null;
  artifacts: { artifactId: string; label: string; kind: string; url: string }[];
  evidence: { assetId: string; label: string; contentHash: string; url: string }[];
  // P6.B6: null when no consent applies (e.g. a text-origin performance
  // records no subject evidence) — the consent SECTION slot carries the
  // documented reason; legacy manifests always carry the object.
  consent: { grantIds: string[]; scopes: ConsentScope[]; subjectId: string } | null;
  provenance: Record<string, unknown>;
  feedback_schema: {
    verdicts: string[];
    regions: string[];
  };
  evidence_request_schema: {
    capabilities: string[];
  };
  export_targets: string[];
  // P6.B6 (manifest v2): every P5 section gets a FIRST-CLASS slot — filled
  // with real references, or explicitly null WITH a documented reason
  // (honesty law: no invented content). Absent on legacy v1 manifests;
  // readers treat absence as legacy and derive as before.
  sections?: ArtifactManifestSections;
}

export interface SolutionArtifactView {
  id: SolutionArtifactId;
  title: string;
  type: SolutionArtifactManifest['type'];
  manifest: SolutionArtifactManifest;
  createdAt: string;
}

// ─── P6.B6 — first-class manifest sections (manifest v2) ─────────────────────

/** Uniform slot envelope: `data` non-null → filled with real references;
 *  `data: null` → honestly absent, `reason` documents WHY (required,
 *  non-empty) and `fillHint` says what would fill it. */
export interface ArtifactSectionSlot<T> {
  data: T | null;
  reason?: string;
  fillHint?: string;
}

/** The 10 P5 sections, in canonical surface order. */
export type ArtifactSectionKey =
  | 'result' | 'compare' | 'evidence' | 'improve' | 'performance'
  | 'provenance' | 'consent' | 'apiCode' | 'feedback' | 'evidenceRequests';

export interface ManifestSectionRef {
  label: string;
  kind: string;
  ref: string;
}

export interface ManifestResultSection {
  /** honest one-liner; numbers quoted verbatim from the job output */
  summary: string;
  refs: ManifestSectionRef[];
  metrics?: Record<string, string | number | boolean>;
}

export interface ManifestCompareSection {
  /** the baseline this artifact's TwinVersion can be compared against */
  baselineTwinVersion: { id: string; version: number } | null;
  note: string;
}

export interface ManifestEvidenceSection {
  /** ids into the top-level manifest.evidence[] entries */
  assetIds: string[];
}

/** The improve chain — REAL causal links only: a targeted evidence request,
 *  its fulfillment capture session, and versions whose evidenceAssetIds
 *  overlap that session's assets (never inferred from timestamps alone). */
export interface ManifestImproveSection {
  requests: {
    requestId: string;
    capability: string;
    status: string;
    captureSessionId: string | null;
  }[];
  followUpVersions: {
    twinVersionId: string;
    version: number;
    artifactId: string | null;
    causedBySessionIds: string[];
  }[];
  note: string;
}

export interface ManifestPerformanceSection {
  id: string;
  name: string;
}

export interface ManifestProvenanceSection {
  adapterComponents: { adapterId: string; version: string }[];
  provenanceKeys: string[];
}

export interface ManifestConsentSection {
  subjectId: string;
  grantIds: string[];
  scopes: string[];
}

export interface ManifestApiCodeSection {
  /** real API paths this artifact's review loop travels */
  endpoints: string[];
}

export interface ManifestFeedbackSection {
  /** live FeedbackRequests linked to THIS artifact (read-time merge) */
  requests: FeedbackRequestView[];
  note: string;
}

export interface ManifestEvidenceRequestsSection {
  /** live targeted EvidenceRequests for this artifact's TwinVersion */
  requests: EvidenceRequestView[];
  capabilities: string[];
}

export interface ArtifactManifestSections {
  result: ArtifactSectionSlot<ManifestResultSection>;
  compare: ArtifactSectionSlot<ManifestCompareSection>;
  evidence: ArtifactSectionSlot<ManifestEvidenceSection>;
  improve: ArtifactSectionSlot<ManifestImproveSection>;
  performance: ArtifactSectionSlot<ManifestPerformanceSection>;
  provenance: ArtifactSectionSlot<ManifestProvenanceSection>;
  consent: ArtifactSectionSlot<ManifestConsentSection>;
  apiCode: ArtifactSectionSlot<ManifestApiCodeSection>;
  feedback: ArtifactSectionSlot<ManifestFeedbackSection>;
  evidenceRequests: ArtifactSectionSlot<ManifestEvidenceRequestsSection>;
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

// ─── Cost budgets + optimization evidence (P6.C12 / PR-13) ──────────────────

/** GET /api/v1/usage → cost section: budget status + accrual breakdowns. */
export interface CostUsageSection {
  basis: string;
  budget: {
    mode: 'limited' | 'unlimited';
    source: 'db:application+pipeline' | 'db:application' | 'db:pipeline' | 'db:tenant' | 'env' | 'default';
    budgetUsd: number | null;
    periodHours: number;
    periodStartedAt: string;
    accruedUsd: number;
    remainingUsd: number | null;
    note: string;
  };
  byPipeline: { pipeline: string; quotedUsd: number; submits: number }[];
  byApplication: { applicationActorId: string | null; quotedUsd: number; submits: number }[];
  series: { day: string; quotedUsd: number; submits: number }[];
  accrualMetric: string;
}

/** GET /api/v1/usage → one optimization's before/after evidence record. */
export interface OptimizationEvidenceView {
  id: 'parallel-org-evaluation' | 'deterministic-subresult-cache';
  title: string;
  kind: 'latency' | 'latency+cost';
  changed: string;
  basis: string;
  note: string;
  evidence: {
    before: { runId: string; worldSeed: number; wallClockMs: number; mode: 'sequential' | 'parallel'; cacheHits: number };
    after: { runId: string; worldSeed: number; wallClockMs: number; mode: 'sequential' | 'parallel'; cacheHits: number };
    deltaMs: number;
    improvementPct: number | null;
    basis: string;
  } | null;
  emptyStateReason: string;
}

/** GET /api/v1/metrics → latency section: declared SLOs + observed stats. */
export interface SloStatContract {
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
