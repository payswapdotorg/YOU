// ═══════════════════════════════════════════════════════════════════════════
// F1 real-human reconstruction pipeline (Worker C lane, P6.C4).
//
// The reconstruction side of docs/F1_OPERATOR_CAPTURE.md: takes a REAL capture
// session's consented evidence assets through fail-closed liveness/quality
// checkpoints and per-asset registry-resolved VLM analysis, then aggregates an
// honest F1ReconstructionReport — per-region confidence, coverage vs the
// 8-step capture protocol, quality findings, and a disclosure of everything
// that could NOT be reconstructed and why.
//
// Honesty laws (the F1 law + AGENTS.md):
// - CONSENT-GATED ENTRY: no active reconstruct-scope grant → typed refusal
//   BEFORE a single byte of evidence is loaded (defense-in-depth on top of
//   the server-enforced route gate, core/consent.ts requireConsent).
// - FAIL-CLOSED CHECKPOINTS: missing / empty / size-mismatched / corrupt /
//   undecodable / wrong-aspect assets are REFUSED with typed reasons and are
//   never sent to the vision model. Refused assets are disclosed in the
//   report — never silently dropped, never papered over.
// - NO SYNTHETIC-CLAIM LAUNDERING: an asset whose analysis fails (provider
//   error, unparseable model output) is recorded as failed with the verbatim
//   error message; the reconstruction is built ONLY from honestly analyzed
//   evidence and publishes ONLY when at least one asset was actually
//   analyzed. Zero analyzable evidence → typed refusal, never a fabricated
//   report.
// - DECLARED ≠ OBSERVED: upload-time region claims count toward coverage as
//   DECLARED-ONLY evidence; per-region confidence is computed exclusively
//   from VLM-observed regions and is null when nothing observed the region —
//   never fabricated.
// - INFERENCE ONLY (the vlm-recon-1 adapter contract): raw evidence stays in
//   object storage; only analysis derivatives are persisted. No training on
//   biometric data exists on this path.
//
// ARCHITECTURE (the P6.C3 pattern): this module is the PURE half — ZERO
// runtime imports (the two `import type` statements below erase), so
// node:test imports it directly (tests/contract/f1-recon.test.mjs). All I/O —
// object storage reads, the registry-resolved vision seam, time — is
// injected via F1VisionDeps and wired to the real seams by the
// f1.reconstruct executor in lab/executors.ts.
// ═══════════════════════════════════════════════════════════════════════════
import type { CaptureRegion, HtirProvenance, HTIR, JobKind } from '../contracts';
import type { VlmAssetAnalysis } from '../adapters/vlm-recon';

// ─── Adapter identity + report schema ────────────────────────────────────────

export const F1_RECON_ADAPTER = {
  adapterId: 'f1-recon-1',
  version: '1',
  role: 'liveness/quality checkpoints + per-asset aggregation for the F1 reconstruction path',
  inferenceOnly: true,
  trainingOnBiometrics: false,
} as const;

export const F1_REPORT_SCHEMA = 'f1-reconstruction-report/v1' as const;

/**
 * P6.C4 lane-local widening: the frozen contracts JobKind union does not yet
 * include 'f1.reconstruct'. Same disclosed pattern as 'template.analyze'
 * (core/jobs.ts DurableJobKind): the value flows through Job.kind rows/views
 * unchanged; the TL should add the union member at landing. Defined here (the
 * Worker C lane module) so lab/executors.ts can register the executor without
 * importing core/jobs.ts (which imports executors — a cycle).
 */
export const F1_RECONSTRUCT_JOB_KIND = 'f1.reconstruct' as JobKind;

// ─── The 8-step F1 capture protocol (docs/F1_OPERATOR_CAPTURE.md) ────────────

export interface F1ProtocolStep {
  readonly step: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  readonly id: string;
  readonly label: string;
  /** primary canonical regions that machine-evidence this step */
  readonly regions: readonly CaptureRegion[];
  /** honest disclosure when the wave-1 region model cannot distinguish
   *  protocol framings (e.g. upper-body vs full-body) */
  readonly coarseGrainingNote?: string;
}

/**
 * The 8-step protocol, mapped onto the canonical region model. Honest
 * coarse-graining notes disclose where the wave-1 region model cannot
 * distinguish protocol framings (upper-body vs full-body both derive from
 * silhouette.front).
 */
export const F1_PROTOCOL_STEPS: readonly F1ProtocolStep[] = [
  { step: 1, id: 'face-front', label: 'face/front', regions: ['face.front'] },
  { step: 2, id: 'face-turn', label: 'face/turn left/right', regions: ['face.profile'] },
  {
    step: 3, id: 'upper-body', label: 'upper body', regions: ['silhouette.front'],
    coarseGrainingNote:
      'the wave-1 canonical region model has one front-silhouette region; upper-body and full-body framing are not distinguishable',
  },
  {
    step: 4, id: 'full-body', label: 'full body', regions: ['silhouette.front'],
    coarseGrainingNote:
      'the wave-1 canonical region model has one front-silhouette region; upper-body and full-body framing are not distinguishable',
  },
  { step: 5, id: 'hands', label: 'hands', regions: ['hands'] },
  { step: 6, id: 'turn-around', label: 'turn-around', regions: ['hair.back', 'silhouette.side'] },
  { step: 7, id: 'walking', label: 'short walking sequence', regions: ['walking'] },
  { step: 8, id: 'speech', label: 'optional speech/performance sequence', regions: ['speech'] },
] as const;

/** Canonical regions tracked by the F1 report (per-region confidence/coverage). */
export const F1_REGIONS: readonly CaptureRegion[] = [
  'face.front', 'face.profile', 'face.hairline', 'teeth',
  'hands', 'hair.back', 'silhouette.front', 'silhouette.side',
  'walking', 'speech',
] as const;

// ─── Typed refusal taxonomy ──────────────────────────────────────────────────

/** Per-asset refusal codes (recorded values — not thrown). */
export type F1AssetRefusalCode =
  | 'evidence_missing' // object absent from object storage
  | 'evidence_empty' // zero bytes
  | 'evidence_size_mismatch' // manifest bytes ≠ actual bytes
  | 'evidence_mime_mismatch' // declared kind/mime ≠ sniffed container
  | 'evidence_undecodable' // bytes match no recognized container signature
  | 'evidence_wrong_aspect' // decodable dims but an implausible aspect ratio
  | 'analysis_failed' // VLM/provider/parse failure (verbatim message recorded)
  | 'analysis_skipped_non_image'; // wave-1: no vision adapter for video/audio

/** Pipeline-level refusal codes (thrown, fail-closed, non-retryable). */
export type F1PipelineRefusalCode =
  | 'consent_required'
  | 'session_incomplete'
  | 'no_analyzable_evidence';

/** Fail-closed typed refusal thrown by the pipeline gates. */
export class F1TypedRefusal extends Error {
  readonly code: F1PipelineRefusalCode;
  readonly details: unknown;
  constructor(code: F1PipelineRefusalCode, message: string, details?: unknown) {
    super(message);
    this.name = 'F1TypedRefusal';
    this.code = code;
    this.details = details;
  }
}

// ─── Liveness/quality checkpoints (pure byte-level heuristics) ───────────────

export interface F1EvidenceRecord {
  assetId: string;
  storageKey: string;
  /** declared on the EvidenceAsset row: 'image' | 'video' | 'audio' */
  kind: string;
  mime: string;
  contentHash: string;
  declaredBytes: number;
  regions: CaptureRegion[];
}

export interface F1SniffResult {
  container: string;
  mimeFamily: 'image' | 'video' | 'audio';
  canonicalMime: string;
  width?: number;
  height?: number;
}

export interface F1CheckpointVerdict {
  passed: boolean;
  refusal?: { code: F1AssetRefusalCode; message: string };
  sniffed?: F1SniffResult;
}

/** Plausible aspect-ratio bounds for human-evidence imagery (1:4 … 4:1). */
export const F1_MIN_ASPECT_RATIO = 0.25;
export const F1_MAX_ASPECT_RATIO = 4;
/** Any decoded dimension above this is not a plausible capture (corrupt header). */
const MAX_PLAUSIBLE_DIMENSION = 100_000;

function asciiMatches(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Decode PNG IHDR dimensions (fixed offsets: width@16, height@20, big-endian). */
function pngDimensions(bytes: Uint8Array, dv: DataView): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (!asciiMatches(bytes, 12, 'IHDR')) return null; // spec: IHDR is always first
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

/** Scan JPEG markers for the first SOF frame (dimensions at +5/+7, big-endian). */
function jpegDimensions(bytes: Uint8Array, dv: DataView): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 <= bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue; // resync to a marker
    }
    const marker = bytes[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // standalone markers carry no length
      continue;
    }
    if (i + 4 > bytes.length) return null;
    const segLen = dv.getUint16(i + 2);
    if (segLen < 2) return null;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 > bytes.length) return null;
      return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
    }
    if (marker === 0xda) return null; // start of scan reached before any SOF
    i += 2 + segLen;
  }
  return null;
}

/** Decode GIF logical screen dimensions (little-endian at 6/8). */
function gifDimensions(bytes: Uint8Array, dv: DataView): { width: number; height: number } | null {
  if (bytes.length < 10) return null;
  return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
}

/**
 * Sniff the evidence container from magic bytes. Pure; returns null when the
 * bytes match NO recognized evidence container (undecodable). Dimension
 * decoding is header-level only and honest about coverage: PNG/JPEG/GIF
 * expose fixed-offset dims; WebP/MP4/WebM are container-verified with dims
 * left undefined (the aspect heuristic is skipped and disclosed, never
 * guessed).
 */
export function sniffEvidenceContainer(bytes: Uint8Array): F1SniffResult | null {
  const dv = view(bytes);
  // PNG
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    const dims = pngDimensions(bytes, dv);
    return dims
      ? { container: 'png', mimeFamily: 'image', canonicalMime: 'image/png', width: dims.width, height: dims.height }
      : { container: 'png', mimeFamily: 'image', canonicalMime: 'image/png' };
  }
  // JPEG
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const dims = jpegDimensions(bytes, dv);
    return dims
      ? { container: 'jpeg', mimeFamily: 'image', canonicalMime: 'image/jpeg', width: dims.width, height: dims.height }
      : { container: 'jpeg', mimeFamily: 'image', canonicalMime: 'image/jpeg' };
  }
  // GIF
  if (asciiMatches(bytes, 0, 'GIF87a') || asciiMatches(bytes, 0, 'GIF89a')) {
    const dims = gifDimensions(bytes, dv);
    return dims
      ? { container: 'gif', mimeFamily: 'image', canonicalMime: 'image/gif', width: dims.width, height: dims.height }
      : { container: 'gif', mimeFamily: 'image', canonicalMime: 'image/gif' };
  }
  // RIFF family: WebP vs WAV (discriminated by bytes 8..12)
  if (asciiMatches(bytes, 0, 'RIFF') && bytes.length >= 12) {
    if (asciiMatches(bytes, 8, 'WEBP')) return { container: 'webp', mimeFamily: 'image', canonicalMime: 'image/webp' };
    if (asciiMatches(bytes, 8, 'WAVE')) return { container: 'wav', mimeFamily: 'audio', canonicalMime: 'audio/wav' };
  }
  // MP4 (ftyp box at offset 4)
  if (bytes.length >= 8 && asciiMatches(bytes, 4, 'ftyp')) {
    return { container: 'mp4', mimeFamily: 'video', canonicalMime: 'video/mp4' };
  }
  // WebM/MKV (EBML header)
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
  ) {
    return { container: 'webm', mimeFamily: 'video', canonicalMime: 'video/webm' };
  }
  // Ogg
  if (asciiMatches(bytes, 0, 'OggS')) return { container: 'ogg', mimeFamily: 'audio', canonicalMime: 'audio/ogg' };
  // MP3: ID3v2 or a raw frame sync
  if (asciiMatches(bytes, 0, 'ID3')) return { container: 'mp3', mimeFamily: 'audio', canonicalMime: 'audio/mpeg' };
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return { container: 'mp3', mimeFamily: 'audio', canonicalMime: 'audio/mpeg' };
  }
  return null;
}

const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/x-png': 'image/png',
  'audio/x-wav': 'audio/wav',
  'video/x-webm': 'video/webm',
};

function normalizeDeclaredMime(mime: string): string {
  const base = mime.trim().toLowerCase().split(';')[0]?.trim() ?? '';
  return MIME_ALIASES[base] ?? base;
}

/**
 * The F1 liveness/quality checkpoint for ONE evidence asset (pure, honest):
 *
 *   missing bytes      → evidence_missing      (object absent from storage)
 *   zero bytes         → evidence_empty
 *   manifest ≠ actual  → evidence_size_mismatch (the evidence manifest lied)
 *   unknown signature  → evidence_undecodable  (matches no container magic)
 *   kind/mime ≠ sniff  → evidence_mime_mismatch
 *   zero/absurd dims   → evidence_undecodable  (corrupt header)
 *   aspect ∉ [1:4,4:1]→ evidence_wrong_aspect
 *
 * Passing assets carry the sniffed container (and dims when decoded) forward
 * into the report — the checkpoint is the honesty gate; the vision model only
 * ever sees assets that passed it.
 */
export function f1LivenessCheckpoint(
  asset: F1EvidenceRecord,
  bytes: Uint8Array | null,
): F1CheckpointVerdict {
  const refuse = (code: F1AssetRefusalCode, message: string): F1CheckpointVerdict => ({
    passed: false,
    refusal: { code, message },
  });

  if (bytes === null || bytes === undefined) {
    return refuse(
      'evidence_missing',
      `evidence object missing from object storage (asset ${asset.assetId}, key ${asset.storageKey}) — refusing to analyze bytes that do not exist`,
    );
  }
  if (bytes.length === 0) {
    return refuse('evidence_empty', `asset ${asset.assetId} is zero bytes — nothing to analyze`);
  }
  if (asset.declaredBytes !== bytes.length) {
    return refuse(
      'evidence_size_mismatch',
      `asset ${asset.assetId} declares ${asset.declaredBytes} bytes in the evidence manifest but object storage returned ${bytes.length} — refusing to analyze bytes that contradict the manifest`,
    );
  }
  const sniffed = sniffEvidenceContainer(bytes);
  if (!sniffed) {
    return refuse(
      'evidence_undecodable',
      `asset ${asset.assetId} does not decode as any recognized evidence container (png/jpeg/gif/webp/mp4/webm/ogg/wav/mp3) — refusing to pass unknown bytes to the vision model`,
    );
  }
  const declaredMime = normalizeDeclaredMime(asset.mime);
  if (!declaredMime) {
    return refuse(
      'evidence_mime_mismatch',
      `asset ${asset.assetId} declares an empty mime type — the evidence manifest is incomplete`,
    );
  }
  const kind = asset.kind.trim().toLowerCase();
  if (kind !== sniffed.mimeFamily) {
    return refuse(
      'evidence_mime_mismatch',
      `asset ${asset.assetId} is declared as kind "${asset.kind}" but its bytes sniff as a ${sniffed.mimeFamily} container (${sniffed.container}) — the evidence manifest misdescribes the bytes`,
    );
  }
  if (declaredMime !== sniffed.canonicalMime) {
    return refuse(
      'evidence_mime_mismatch',
      `asset ${asset.assetId} declares mime "${asset.mime}" but its bytes sniff as ${sniffed.canonicalMime} (${sniffed.container}) — the evidence manifest misdescribes the bytes`,
    );
  }
  if (sniffed.width !== undefined && sniffed.height !== undefined) {
    const { width, height } = sniffed;
    if (width === 0 || height === 0) {
      return refuse(
        'evidence_undecodable',
        `asset ${asset.assetId} decodes to a ${width}×${height} ${sniffed.container} header — a zero dimension is a corrupt image`,
      );
    }
    if (width > MAX_PLAUSIBLE_DIMENSION || height > MAX_PLAUSIBLE_DIMENSION) {
      return refuse(
        'evidence_undecodable',
        `asset ${asset.assetId} decodes to ${width}×${height} — beyond any plausible capture dimension (corrupt header)`,
      );
    }
    const aspect = width / height;
    if (aspect < F1_MIN_ASPECT_RATIO || aspect > F1_MAX_ASPECT_RATIO) {
      return refuse(
        'evidence_wrong_aspect',
        `asset ${asset.assetId} is ${width}×${height} (aspect ${aspect.toFixed(3)}:1) — outside the plausible ${F1_MIN_ASPECT_RATIO}:1…${F1_MAX_ASPECT_RATIO}:1 band for human-evidence imagery; declared regions "${asset.regions.join(', ') || 'none'}" cannot be honestly evidenced at this framing`,
      );
    }
  }
  return { passed: true, sniffed };
}

// ─── Consent gate (pure; defense-in-depth over the route gate) ───────────────

export interface F1ConsentGrantInput {
  id: string;
  scopes: string[];
  revokedAt: Date | string | null;
  expiresAt: Date | string;
}

export interface F1ConsentDecision {
  grantId: string;
}

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

/**
 * Fail-closed consent gate for the F1 reconstruction path. Throws
 * F1TypedRefusal('consent_required') unless one of the supplied grants is
 * active (not revoked, not expired — invalid dates count as expired) and
 * covers the 'reconstruct' scope. The FIRST covering grant (input order)
 * wins, deterministically. This re-checks what the route already enforced
 * through core/consent.ts requireConsent — consent is server-enforced at
 * BOTH layers, and this layer is the one that guarantees no evidence byte is
 * loaded without it.
 */
export function f1ConsentGate(
  grants: readonly F1ConsentGrantInput[],
  subjectId: string,
  now: Date = new Date(),
): F1ConsentDecision {
  for (const grant of grants) {
    if (grant.revokedAt) continue;
    const expiresAt = toDate(grant.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) continue;
    if (grant.scopes.includes('reconstruct')) {
      return { grantId: grant.id };
    }
  }
  throw new F1TypedRefusal(
    'consent_required',
    `no active consent grant with scope "reconstruct" for subject ${subjectId} — F1 reconstruction refused before any evidence was loaded (fail-closed, per docs/F1_OPERATOR_CAPTURE.md)`,
    { subjectId, scope: 'reconstruct', grantsConsidered: grants.length },
  );
}

// ─── The deps-injected reconstruction run ────────────────────────────────────

export interface F1VisionResolution {
  provider: string;
  modelId: string;
  source: string;
}

export interface F1AssetAnalysisResult {
  analysis: VlmAssetAnalysis;
  /** real per-asset call accounting (the shared adapter contract) */
  usage: { llmCalls: number; totalLatencyMs: number };
}

/** All I/O the F1 pipeline needs — injected; the executor wires the real seams. */
export interface F1VisionDeps {
  /** object-storage read (null = missing object). Storage THROWS propagate —
   *  a storage outage is a job-level failure (retried by the runner), never a
   *  per-asset refusal. */
  loadBytes(storageKey: string): Promise<Uint8Array | null>;
  /** single-asset reconstruction analysis through the registry-resolved
   *  vision seam (vlm-recon-1). Throws propagate per-asset and are recorded
   *  verbatim as analysis_failed — never papered over. */
  analyzeAsset(asset: F1EvidenceRecord, contextNote: string): Promise<F1AssetAnalysisResult>;
  /** resolution snapshot taken through the SAME function the seam uses per
   *  call (ai/recon-provider.ts reconResolution). Throws (fail-closed
   *  RegistryResolutionError) propagate — the run never starts on an
   *  unresolvable model. */
  resolveVision(): F1VisionResolution;
}

export interface F1ProgressEvent {
  stage: 'checkpoint' | 'analysis';
  index: number;
  total: number;
  assetId: string;
}

export interface F1ReconstructionInput {
  captureSessionId: string;
  twinId: string;
  subjectId: string;
  sessionStatus: string;
  grants: readonly F1ConsentGrantInput[];
  assets: readonly F1EvidenceRecord[];
}

export interface F1ReconstructionResult {
  report: F1ReconstructionReport;
  /** per-asset analyses of every honestly-analyzed asset (input order) — the
   *  executor feeds these to the shared C1 HTIR-draft aggregation. */
  analyzedAssets: VlmAssetAnalysis[];
  grantId: string;
  vision: F1VisionResolution;
}

export interface F1RunHooks {
  onProgress?: (event: F1ProgressEvent) => void | Promise<void>;
  now?: () => Date;
}

// Per-asset outcomes of the pipeline — a discriminated union on
// analysis.status, with named members + guards (the honest state machine:
// refused assets are never analyzed; failed analyses are recorded verbatim;
// non-image assets are skipped with a typed reason).
export interface F1OutcomeAnalyzed {
  asset: F1EvidenceRecord;
  checkpoint: F1CheckpointVerdict;
  analysis: { status: 'analyzed'; result: F1AssetAnalysisResult };
}
export interface F1OutcomeRefused {
  asset: F1EvidenceRecord;
  checkpoint: F1CheckpointVerdict;
  analysis: { status: 'refused' };
}
export interface F1OutcomeFailed {
  asset: F1EvidenceRecord;
  checkpoint: F1CheckpointVerdict;
  analysis: { status: 'failed'; message: string };
}
export interface F1OutcomeSkipped {
  asset: F1EvidenceRecord;
  checkpoint: F1CheckpointVerdict;
  analysis: { status: 'skipped'; code: 'analysis_skipped_non_image'; message: string };
}
export type F1Outcome = F1OutcomeAnalyzed | F1OutcomeRefused | F1OutcomeFailed | F1OutcomeSkipped;

function isAnalyzedOutcome(o: F1Outcome): o is F1OutcomeAnalyzed {
  return o.analysis.status === 'analyzed';
}
function isRefusedOutcome(o: F1Outcome): o is F1OutcomeRefused {
  return o.analysis.status === 'refused';
}
function isFailedOutcome(o: F1Outcome): o is F1OutcomeFailed {
  return o.analysis.status === 'failed';
}
function isSkippedOutcome(o: F1Outcome): o is F1OutcomeSkipped {
  return o.analysis.status === 'skipped';
}

/**
 * Prompt context note for one asset: what the uploader DECLARED and which
 * protocol steps the declaration maps to. The vision model is told to verify
 * honestly what is actually visible — declarations are claims to check, not
 * facts to confirm.
 */
export function f1AssetContextNote(asset: F1EvidenceRecord): string {
  const declared = asset.regions.length > 0 ? asset.regions.join(', ') : 'none declared';
  const steps = F1_PROTOCOL_STEPS.filter((s) =>
    s.regions.some((r) => asset.regions.includes(r)),
  ).map((s) => `${s.step} (${s.label})`);
  return (
    `F1 capture context: the uploader declared regions [${declared}]` +
    (steps.length > 0 ? ` for protocol step(s) ${steps.join('; ')}` : '') +
    '. Verify honestly what is actually visible in this asset; report only what it truly evidences — declarations are claims to check, not facts to confirm.'
  );
}

/**
 * The F1 reconstruction run — the whole honest pipeline, pure of I/O:
 *
 *   consent gate → session gate → vision resolution (fail-closed) →
 *   per-asset liveness/quality checkpoints (fail-closed per asset) →
 *   per-asset registry-resolved VLM analysis (failures recorded verbatim) →
 *   aggregation into F1ReconstructionReport.
 *
 * Throws F1TypedRefusal for the pipeline-level refusals (consent_required /
 * session_incomplete / no_analyzable_evidence); the last one carries every
 * per-asset refusal and failure in its details, so even a fully-refused run
 * discloses WHY nothing could be reconstructed.
 */
export async function runF1Reconstruction(
  input: F1ReconstructionInput,
  deps: F1VisionDeps,
  hooks: F1RunHooks = {},
): Promise<F1ReconstructionResult> {
  const now = (hooks.now ?? (() => new Date()))();
  const consent = f1ConsentGate(input.grants, input.subjectId, now);

  if (input.sessionStatus !== 'complete') {
    throw new F1TypedRefusal(
      'session_incomplete',
      `capture session ${input.captureSessionId} status is "${input.sessionStatus}" — F1 reconstruction requires a COMPLETE session (run capture.quality first; refusing to reconstruct from an unfinished evidence set)`,
      { captureSessionId: input.captureSessionId, status: input.sessionStatus },
    );
  }
  if (input.assets.length === 0) {
    throw new F1TypedRefusal(
      'no_analyzable_evidence',
      `capture session ${input.captureSessionId} contains no evidence assets — nothing to reconstruct (refusing to fabricate an F1 report)`,
      { captureSessionId: input.captureSessionId, assets: 0 },
    );
  }

  // fail-closed model resolution through the seam BEFORE any evidence is read
  const vision = deps.resolveVision();

  // ── phase 1: liveness/quality checkpoints on every asset ──
  const outcomes: F1Outcome[] = [];
  const eligible: Array<{ asset: F1EvidenceRecord; checkpoint: F1CheckpointVerdict }> = [];
  for (let i = 0; i < input.assets.length; i += 1) {
    const asset = input.assets[i];
    const bytes = await deps.loadBytes(asset.storageKey);
    const checkpoint = f1LivenessCheckpoint(asset, bytes);
    if (hooks.onProgress) {
      await hooks.onProgress({ stage: 'checkpoint', index: i + 1, total: input.assets.length, assetId: asset.assetId });
    }
    if (!checkpoint.passed) {
      outcomes.push({ asset, checkpoint, analysis: { status: 'refused' } });
      continue;
    }
    const family = checkpoint.sniffed?.mimeFamily;
    if (family === 'image') {
      eligible.push({ asset, checkpoint });
      continue;
    }
    // non-image assets pass the byte-level checks but have no vision adapter
    // in wave-1 — their declared regions count toward coverage as DECLARED
    // evidence only, disclosed honestly.
    outcomes.push({
      asset,
      checkpoint,
      analysis: {
        status: 'skipped',
        code: 'analysis_skipped_non_image',
        message: `no vision adapter is wired for ${family ?? 'non-image'} evidence in wave-1 — the asset passed the byte-level liveness checkpoint and counts toward protocol coverage via its DECLARED regions only (never as machine-observed)`,
      },
    });
  }

  // ── phase 2: per-asset VLM analysis (failures recorded, never papered over) ──
  let analysisIndex = 0;
  for (const { asset, checkpoint } of eligible) {
    analysisIndex += 1;
    let outcome: F1Outcome;
    try {
      const result = await deps.analyzeAsset(asset, f1AssetContextNote(asset));
      outcome = { asset, checkpoint, analysis: { status: 'analyzed', result } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcome = { asset, checkpoint, analysis: { status: 'failed', message } };
    }
    if (hooks.onProgress) {
      await hooks.onProgress({ stage: 'analysis', index: analysisIndex, total: eligible.length, assetId: asset.assetId });
    }
    outcomes.push(outcome);
  }

  const analyzed = outcomes.filter(isAnalyzedOutcome);
  if (analyzed.length === 0) {
    throw new F1TypedRefusal(
      'no_analyzable_evidence',
      `capture session ${input.captureSessionId}: every evidence asset was refused at the liveness/quality checkpoint or failed analysis — refusing to publish a reconstruction with zero honestly-analyzed evidence`,
      {
        captureSessionId: input.captureSessionId,
        perAsset: outcomes.map((o) => ({
          assetId: o.asset.assetId,
          kind: o.asset.kind,
          refusal: o.checkpoint.refusal ?? null,
          analysisStatus: o.analysis.status,
          analysisMessage: o.analysis.status === 'failed' || o.analysis.status === 'skipped' ? o.analysis.message : null,
        })),
      },
    );
  }

  const report = aggregateF1Report(input, consent.grantId, vision, outcomes, now);
  return {
    report,
    analyzedAssets: analyzed.map((o) => o.analysis.result.analysis),
    grantId: consent.grantId,
    vision,
  };
}

// ─── Aggregation → F1ReconstructionReport (pure) ─────────────────────────────

export interface F1EvidenceManifestEntry {
  assetId: string;
  storageKey: string;
  kind: string;
  mime: string;
  contentHash: string;
  declaredBytes: number;
  regions: CaptureRegion[];
  checkpoint: {
    passed: boolean;
    refusal?: { code: F1AssetRefusalCode; message: string };
    sniffed?: { container: string; mimeFamily: string; width?: number; height?: number };
  };
  analysis: {
    status: 'analyzed' | 'refused' | 'failed' | 'skipped';
    code?: F1AssetRefusalCode;
    message?: string;
    observedRegions?: string[];
    score?: number;
    confidenceOverall?: number;
  };
}

export interface F1ProtocolStepCoverage {
  step: number;
  id: string;
  label: string;
  status: 'covered' | 'partial' | 'missing';
  /** step regions the VLM actually observed (machine-verified) */
  observedRegions: string[];
  /** step regions nothing observed */
  missingRegions: string[];
  /** some step-region coverage comes from DECLARED-only assets */
  declaredOnly: boolean;
  /** analyzed assets whose observation covers ≥1 step region */
  evidenceAssetIds: string[];
  coarseGrainingNote?: string;
}

export interface F1FailureDisclosure {
  assetId: string;
  code: F1AssetRefusalCode;
  message: string;
}

export interface F1ReconstructionReport {
  schema: typeof F1_REPORT_SCHEMA;
  captureSessionId: string;
  twinId: string;
  subjectId: string;
  consent: { grantId: string; scope: 'reconstruct'; verifiedAt: string };
  vision: {
    provider: string;
    modelId: string;
    resolutionSource: string;
    adapterId: 'vlm-recon-1';
    inferenceOnly: true;
    note: string;
  };
  evidenceManifest: F1EvidenceManifestEntry[];
  protocolCoverage: F1ProtocolStepCoverage[];
  /** canonical region → weighted mean of observing assets' model self-confidence (null = not machine-observed; NEVER fabricated) */
  perRegionConfidence: Record<string, number | null>;
  /** canonical region → observed (VLM) | declared-only | none */
  regionCoverage: Record<string, 'observed' | 'declared-only' | 'none'>;
  /** analysis-derived quality findings (verbatim model issues + blur/lighting flags) */
  qualityFindings: string[];
  /** EVERY refused/failed/skipped asset with its typed code and verbatim message */
  failures: F1FailureDisclosure[];
  overall: {
    assetsTotal: number;
    assetsAnalyzed: number;
    assetsRefused: number;
    assetsFailed: number;
    assetsSkippedNonImage: number;
    protocolStepsCovered: number;
    protocolStepsPartial: number;
    protocolStepsMissing: number;
    /** (covered + 0.5 × partial) / 8 */
    protocolCoverageRatio: number;
    /** weighted model self-confidence × coverage factor (C1 formula constants); null never happens post-gate */
    confidenceOverall: number | null;
    disclosure: string;
  };
  usage: {
    llmCalls: number;
    totalLatencyMs: number;
    note: string;
  };
}

const OBSERVER_WEIGHT_FLOOR = 0.05;
/** C1 analyzeEvidenceSet honesty constants — overall confidence scales with protocol coverage. */
const CONFIDENCE_COVERAGE_BASE = 0.55;
const CONFIDENCE_COVERAGE_SPAN = 0.45;

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Aggregate every per-asset outcome into the honest F1 report (pure). */
export function aggregateF1Report(
  input: F1ReconstructionInput,
  grantId: string,
  vision: F1VisionResolution,
  outcomes: readonly F1Outcome[],
  now: Date = new Date(),
): F1ReconstructionReport {
  const analyzed = outcomes.filter(isAnalyzedOutcome);
  const refused = outcomes.filter(isRefusedOutcome);
  const failed = outcomes.filter(isFailedOutcome);
  const skipped = outcomes.filter(isSkippedOutcome);

  // ── evidence manifest (input order — content-hash order is the manifest order) ──
  const evidenceManifest: F1EvidenceManifestEntry[] = outcomes.map((o) => {
    const a = o.analysis;
    const base = {
      assetId: o.asset.assetId,
      storageKey: o.asset.storageKey,
      kind: o.asset.kind,
      mime: o.asset.mime,
      contentHash: o.asset.contentHash,
      declaredBytes: o.asset.declaredBytes,
      regions: [...o.asset.regions],
      checkpoint: {
        passed: o.checkpoint.passed,
        ...(o.checkpoint.refusal ? { refusal: { ...o.checkpoint.refusal } } : {}),
        ...(o.checkpoint.sniffed
          ? {
              sniffed: {
                container: o.checkpoint.sniffed.container,
                mimeFamily: o.checkpoint.sniffed.mimeFamily,
                ...(o.checkpoint.sniffed.width !== undefined ? { width: o.checkpoint.sniffed.width } : {}),
                ...(o.checkpoint.sniffed.height !== undefined ? { height: o.checkpoint.sniffed.height } : {}),
              },
            }
          : {}),
      } as F1EvidenceManifestEntry['checkpoint'],
    };
    if (a.status === 'analyzed') {
      return {
        ...base,
        analysis: {
          status: 'analyzed' as const,
          observedRegions: [...a.result.analysis.observedRegions],
          score: a.result.analysis.score,
          confidenceOverall: a.result.analysis.confidence.overall,
        },
      };
    }
    if (a.status === 'failed') {
      return { ...base, analysis: { status: 'failed' as const, code: 'analysis_failed' as const, message: a.message } };
    }
    if (a.status === 'skipped') {
      return { ...base, analysis: { status: 'skipped' as const, code: a.code, message: a.message } };
    }
    return { ...base, analysis: { status: 'refused' as const, code: o.checkpoint.refusal?.code ?? 'evidence_undecodable', message: o.checkpoint.refusal?.message ?? 'refused at the liveness/quality checkpoint' } };
  });

  // ── region coverage + per-region confidence (machine-observed only) ──
  const observedBy = new Map<string, F1OutcomeAnalyzed[]>();
  for (const region of F1_REGIONS) observedBy.set(region, []);
  for (const o of analyzed) {
    for (const region of o.analysis.result.analysis.observedRegions) {
      const bucket = observedBy.get(region);
      if (bucket) bucket.push(o);
    }
  }
  // declared-only coverage counts ONLY from assets that passed checkpoints
  // (refused assets contribute nothing — their claims are unverifiable)
  const declaredBy = new Map<string, number>();
  for (const region of F1_REGIONS) declaredBy.set(region, 0);
  for (const o of outcomes) {
    if (o.analysis.status === 'refused') continue;
    for (const region of o.asset.regions) {
      const count = declaredBy.get(region);
      if (count !== undefined) declaredBy.set(region, count + 1);
    }
  }

  const perRegionConfidence: Record<string, number | null> = {};
  const regionCoverage: Record<string, 'observed' | 'declared-only' | 'none'> = {};
  for (const region of F1_REGIONS) {
    const observers = observedBy.get(region) ?? [];
    if (observers.length > 0) {
      regionCoverage[region] = 'observed';
      const weights = observers.map((o) =>
        Math.max(OBSERVER_WEIGHT_FLOOR, o.analysis.result.analysis.score * clamp01(o.analysis.result.analysis.confidence.overall)),
      );
      const wTotal = weights.reduce((s, w) => s + w, 0);
      const value = observers.reduce((s, o, i) => s + weights[i] * clamp01(o.analysis.result.analysis.confidence.overall), 0) / wTotal;
      perRegionConfidence[region] = round3(value);
    } else {
      perRegionConfidence[region] = null;
      regionCoverage[region] = (declaredBy.get(region) ?? 0) > 0 ? 'declared-only' : 'none';
    }
  }

  // ── protocol coverage (the 8-step law) ──
  const protocolCoverage: F1ProtocolStepCoverage[] = F1_PROTOCOL_STEPS.map((step) => {
    const observedRegions = step.regions.filter((r) => regionCoverage[r] === 'observed');
    const missingRegions = step.regions.filter((r) => regionCoverage[r] !== 'observed');
    const evidenceAssetIds = analyzed
      .filter((o) => o.analysis.result.analysis.observedRegions.some((r) => step.regions.includes(r as CaptureRegion)))
      .map((o) => o.asset.assetId);
    const status: F1ProtocolStepCoverage['status'] =
      observedRegions.length === step.regions.length ? 'covered' : observedRegions.length > 0 ? 'partial' : 'missing';
    return {
      step: step.step,
      id: step.id,
      label: step.label,
      status,
      observedRegions: [...observedRegions],
      missingRegions: [...missingRegions],
      declaredOnly: step.regions.some((r) => regionCoverage[r] === 'declared-only'),
      evidenceAssetIds,
      ...(step.coarseGrainingNote ? { coarseGrainingNote: step.coarseGrainingNote } : {}),
    };
  });

  // ── quality findings (analysis-derived; refusals live in `failures`) ──
  const qualityFindings: string[] = [];
  for (const o of analyzed) {
    const a = o.analysis.result.analysis;
    if (a.blur === 'heavy') qualityFindings.push(`asset ${o.asset.assetId}: heavy blur reported by the vision model`);
    if (a.lighting === 'poor') qualityFindings.push(`asset ${o.asset.assetId}: poor lighting reported by the vision model`);
    for (const issue of a.issues) {
      const line = `asset ${o.asset.assetId}: ${issue}`;
      if (!qualityFindings.includes(line)) qualityFindings.push(line);
    }
  }
  for (const region of F1_REGIONS) {
    if (regionCoverage[region] === 'declared-only') {
      qualityFindings.push(`region "${region}" is covered by DECLARED evidence only — no analyzed asset machine-observed it`);
    }
  }

  // ── failures: every refused/failed/skipped asset, typed + verbatim ──
  const failures: F1FailureDisclosure[] = [];
  for (const o of refused) {
    failures.push({
      assetId: o.asset.assetId,
      code: o.checkpoint.refusal?.code ?? 'evidence_undecodable',
      message: o.checkpoint.refusal?.message ?? 'refused at the liveness/quality checkpoint',
    });
  }
  for (const o of failed) {
    failures.push({ assetId: o.asset.assetId, code: 'analysis_failed', message: o.analysis.message });
  }
  for (const o of skipped) {
    failures.push({ assetId: o.asset.assetId, code: o.analysis.code, message: o.analysis.message });
  }

  // ── overall numbers ──
  const stepsCovered = protocolCoverage.filter((s) => s.status === 'covered').length;
  const stepsPartial = protocolCoverage.filter((s) => s.status === 'partial').length;
  const stepsMissing = protocolCoverage.filter((s) => s.status === 'missing').length;
  const protocolCoverageRatio = round3((stepsCovered + 0.5 * stepsPartial) / F1_PROTOCOL_STEPS.length);

  let confidenceOverall: number | null = null;
  if (analyzed.length > 0) {
    const weights = analyzed.map((o) =>
      Math.max(OBSERVER_WEIGHT_FLOOR, o.analysis.result.analysis.score * clamp01(o.analysis.result.analysis.confidence.overall)),
    );
    const wTotal = weights.reduce((s, w) => s + w, 0);
    const raw = analyzed.reduce((s, o, i) => s + weights[i] * clamp01(o.analysis.result.analysis.confidence.overall), 0) / wTotal;
    confidenceOverall = round3(raw * (CONFIDENCE_COVERAGE_BASE + CONFIDENCE_COVERAGE_SPAN * protocolCoverageRatio));
  }

  // ── usage (successful analyses only — failures disclose attempts, not counts) ──
  const llmCalls = analyzed.reduce((s, o) => s + o.analysis.result.usage.llmCalls, 0);
  const totalLatencyMs = analyzed.reduce((s, o) => s + o.analysis.result.usage.totalLatencyMs, 0);

  // ── the disclosure: what could NOT be reconstructed, and why ──
  const disclosureParts: string[] = [];
  if (stepsMissing > 0) {
    const labels = protocolCoverage.filter((s) => s.status === 'missing').map((s) => `${s.step} ${s.label}`).join('; ');
    disclosureParts.push(`${stepsMissing} of 8 F1 protocol steps have no machine-observed evidence (${labels}).`);
  }
  if (stepsPartial > 0) {
    const labels = protocolCoverage.filter((s) => s.status === 'partial').map((s) => `${s.step} ${s.label} (missing: ${s.missingRegions.join(', ')})`).join('; ');
    disclosureParts.push(`${stepsPartial} protocol steps are only partially observed (${labels}).`);
  }
  const declaredOnlyRegions = F1_REGIONS.filter((r) => regionCoverage[r] === 'declared-only');
  if (declaredOnlyRegions.length > 0) {
    disclosureParts.push(`Regions covered by DECLARED evidence only (not machine-verified): ${declaredOnlyRegions.join(', ')}.`);
  }
  if (refused.length > 0) {
    disclosureParts.push(
      `${refused.length} asset(s) were refused at the liveness/quality checkpoint and excluded from analysis: ${refused
        .map((o) => `${o.asset.assetId} (${o.checkpoint.refusal?.code ?? 'unknown'})`)
        .join(', ')}.`,
    );
  }
  if (failed.length > 0) {
    disclosureParts.push(
      `${failed.length} asset(s) passed checkpoints but FAILED analysis (recorded verbatim, never papered over): ${failed
        .map((o) => o.asset.assetId)
        .join(', ')}.`,
    );
  }
  if (skipped.length > 0) {
    disclosureParts.push(
      `${skipped.length} non-image asset(s) passed the byte-level checks but have no vision adapter in wave-1 — they count toward coverage via declared regions only.`,
    );
  }
  const unobserved = F1_REGIONS.filter((r) => perRegionConfidence[r] === null);
  if (unobserved.length > 0) {
    disclosureParts.push(`No machine-observed confidence exists for regions: ${unobserved.join(', ')} (reported as null, never fabricated).`);
  }
  if (regionCoverage['silhouette.front'] === 'observed') {
    disclosureParts.push('Upper-body and full-body protocol steps share the silhouette.front region in wave-1 — front framing is not distinguishable beyond region coverage.');
  }
  if (disclosureParts.length === 0) {
    disclosureParts.push('All 8 protocol steps are machine-observed; every asset passed checkpoints and was analyzed; no refusals, failures, or skips to disclose.');
  }
  const disclosure = disclosureParts.join(' ');

  return {
    schema: F1_REPORT_SCHEMA,
    captureSessionId: input.captureSessionId,
    twinId: input.twinId,
    subjectId: input.subjectId,
    consent: { grantId, scope: 'reconstruct', verifiedAt: now.toISOString() },
    vision: {
      provider: vision.provider,
      modelId: vision.modelId,
      resolutionSource: vision.source,
      adapterId: 'vlm-recon-1',
      inferenceOnly: true,
      note: 'resolution snapshot taken through the same registry resolution the recon seam performs per call (ai/recon-provider.ts); per-call resolution remains authoritative for routing',
    },
    evidenceManifest,
    protocolCoverage,
    perRegionConfidence,
    regionCoverage,
    qualityFindings,
    failures,
    overall: {
      assetsTotal: outcomes.length,
      assetsAnalyzed: analyzed.length,
      assetsRefused: refused.length,
      assetsFailed: failed.length,
      assetsSkippedNonImage: skipped.length,
      protocolStepsCovered: stepsCovered,
      protocolStepsPartial: stepsPartial,
      protocolStepsMissing: stepsMissing,
      protocolCoverageRatio,
      confidenceOverall,
      disclosure,
    },
    usage: {
      llmCalls,
      totalLatencyMs,
      note: 'counted over successfully analyzed assets only; failed analyses made at least one provider call that is not counted (the adapter reports counts only on success)',
    },
  };
}

// ─── TwinVersion linkage (pure payload builders) ─────────────────────────────

export interface F1ProvenanceBlock {
  reportSchema: typeof F1_REPORT_SCHEMA;
  reconstructionOf: { captureSessionId: string; twinId: string; subjectId: string };
  consentGrantId: string;
  vision: { provider: string; modelId: string; resolutionSource: string; adapterId: string };
  /** sha256 of every manifest asset IN ORDER — the evidence manifest hashes */
  evidenceManifestHashes: string[];
  refusedAssetIds: string[];
  failedAssetIds: string[];
  skippedNonImageAssetIds: string[];
  perRegionConfidence: Record<string, number | null>;
  protocolCoverage: Array<{ step: number; id: string; status: string }>;
  protocolCoverageRatio: number;
  confidenceOverall: number | null;
  disclosure: string;
  reportRepresentation: { kind: 'f1-recon-report'; adapterId: 'f1-recon-1' };
}

/**
 * The F1 provenance block carried on the published TwinVersion's HTIR
 * provenance (htir.provenance.f1): evidence manifest hashes, the consent
 * grant id, the model + provider actually used (registry-resolved), per-region
 * confidences, protocol coverage, and the disclosure — everything the F1 law
 * requires the TwinVersion to carry about HOW it was reconstructed.
 */
export function buildF1ProvenanceBlock(
  input: F1ReconstructionInput,
  report: F1ReconstructionReport,
): F1ProvenanceBlock {
  return {
    reportSchema: report.schema,
    reconstructionOf: {
      captureSessionId: input.captureSessionId,
      twinId: input.twinId,
      subjectId: input.subjectId,
    },
    consentGrantId: report.consent.grantId,
    vision: {
      provider: report.vision.provider,
      modelId: report.vision.modelId,
      resolutionSource: report.vision.resolutionSource,
      adapterId: report.vision.adapterId,
    },
    evidenceManifestHashes: report.evidenceManifest.map((e) => e.contentHash),
    refusedAssetIds: report.evidenceManifest.filter((e) => e.analysis.status === 'refused').map((e) => e.assetId),
    failedAssetIds: report.evidenceManifest.filter((e) => e.analysis.status === 'failed').map((e) => e.assetId),
    skippedNonImageAssetIds: report.evidenceManifest.filter((e) => e.analysis.status === 'skipped').map((e) => e.assetId),
    perRegionConfidence: report.perRegionConfidence,
    protocolCoverage: report.protocolCoverage.map((s) => ({ step: s.step, id: s.id, status: s.status })),
    protocolCoverageRatio: report.overall.protocolCoverageRatio,
    confidenceOverall: report.overall.confidenceOverall,
    disclosure: report.overall.disclosure,
    reportRepresentation: { kind: 'f1-recon-report', adapterId: F1_RECON_ADAPTER.adapterId },
  };
}

/**
 * Lane-local widening of the frozen HtirProvenance contract (the same
 * disclosed pattern as DurableJobKind/'template.analyze'): the F1 path
 * compiles with compiledBy 'f1.reconstruct' and an `f1` provenance block.
 * The HTIR schema allows objects inside provenance; the TL should widen the
 * contracts union at landing.
 */
export type F1HtirProvenance = Omit<HtirProvenance, 'compiledBy'> & {
  compiledBy: 'f1.reconstruct';
  f1: F1ProvenanceBlock;
};

export type F1Htir = Omit<HTIR, 'provenance'> & { provenance: F1HtirProvenance };
