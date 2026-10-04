// ═══════════════════════════════════════════════════════════════════════════
// tryon-adapter-1 — the virtual try-on adapter CONTRACT + pure core
// (Worker C lane, P6.C8 — docs/PHASE_6_HANDOFF.md §P13 e-commerce).
//
// ZERO-IMPORT MODULE LAW (the live-core.ts / f1-recon.ts precedent): no db,
// no storage, no SDK imports — everything environmental (env vars, bytes,
// clocks, HTTP) is passed in or injected, so the node:test suite imports
// this file directly and exercises the CONTRACT, not the wiring. The
// executor (lab/executors.ts, kind 'tryon.render') composes these functions
// with the real seams.
//
// HONEST-CLAIMS CONTRACT (the order's core law):
// - `visualOnlyDisclaimer` is PART OF THE CONTRACT, not UI text: every
//   TryOnSuccess carries it verbatim, every comparison view renders it,
//   every 'tryon.completed' merchant callback includes it. A try-on output
//   is a VISUAL SIMULATION — it is NOT a claim about physical fit (size,
//   drape, comfort, fabric behavior, measurements). assertTryOnSuccess()
//   rejects a result whose disclaimer is missing or altered.
// - FAIL-CLOSED provider selection (the C1/C2 seam law, try-on side): no
//   provider configured → honest typed refusal (tryon_unavailable), never a
//   stub image, never a fabricated score. Unknown YOU_TRYON_PROVIDER values
//   throw — the platform never guesses which provider renders a garment.
// - Identity preservation is honest by construction: structural checks
//   (product reference preserved) are real; perceptual checks (garment
//   identity, twin identity) are ONLY reported when a vision comparison
//   actually ran — otherwise status 'unverified' with score null and the
//   reason. Unknown is unknown; nothing is invented.
// - Provider errors surface verbatim through the typed refusal taxonomy.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Adapter descriptor ─────────────────────────────────────────────────────

import type { JobKind } from '../contracts';

export const TRYON_ADAPTER = {
  adapterId: 'tryon-adapter-1',
  version: '1',
  providerNeutral: true,
  visualOnly: true,
  claimsNote:
    'visual try-on simulates how a garment LOOKS on the twin body representation; it makes NO physical-fit claim (size, drape, comfort, fabric behavior, measurements are out of scope by contract)',
} as const;

/**
 * The durable job kind (core/jobs.ts lane-local widening — the frozen
 * contracts JobKind union gains the member at TL landing, the f1.reconstruct
 * precedent). The import above is TYPE-ONLY (erased at runtime): this module
 * stays zero-import (node:test importable).
 */
export const TRYON_RENDER_JOB_KIND = 'tryon.render' as JobKind;

// ─── The visual-only disclaimer (CONTRACT, not UI text) ─────────────────────

/**
 * The exact disclaimer text every try-on result, comparison view and
 * merchant callback carries. Worded to state BOTH halves: what a visual
 * try-on is, and what it explicitly does not claim (physical fit).
 */
export const VISUAL_ONLY_DISCLAIMER =
  'Visual try-on only: this output simulates how the garment appears on your digital twin for visual comparison. It is not a physical-fit result — size, measurements, drape, comfort and fabric behavior are not evaluated and must be confirmed with the product\'s size guide before purchase.';

/** Contract check: a try-on result MUST carry the disclaimer verbatim. */
export function disclaimerIsIntact(disclaimer: unknown): boolean {
  return typeof disclaimer === 'string' && disclaimer === VISUAL_ONLY_DISCLAIMER;
}

// ─── Typed refusal taxonomy (the LiveSessionRefusal precedent) ─────────────

export type TryOnRefusalCode =
  | 'validation_failed' // 400 — malformed input (ids, options, garment upload)
  | 'tryon_unavailable' // 503 — provider not configured / required env missing (fail-closed)
  | 'provider_error' // 502 — the hosted provider call failed (verbatim message)
  | 'identity_check_failed'; // 422 — a structural identity invariant failed (product ref lost)

export class TryOnRefusal extends Error {
  readonly code: TryOnRefusalCode;
  readonly details?: unknown;
  constructor(code: TryOnRefusalCode, message: string, details?: unknown) {
    super(message);
    this.name = 'TryOnRefusal';
    this.code = code;
    this.details = details;
  }
}

export interface TryOnHttpSpec {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

const REFUSAL_STATUS: Record<TryOnRefusalCode, number> = {
  validation_failed: 400,
  tryon_unavailable: 503,
  provider_error: 502,
  identity_check_failed: 422,
};

/** Translate a TryOnRefusal into the standard error-envelope spec. */
export function tryOnHttpSpec(err: unknown): TryOnHttpSpec | null {
  if (!(err instanceof TryOnRefusal)) return null;
  return { status: REFUSAL_STATUS[err.code], code: err.code, message: err.message, details: err.details };
}

// ─── Garment upload validation (the captures/assets route laws, try-on side) ─

export const GARMENT_ALLOWED_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const GARMENT_MAX_BYTES = 10 * 1024 * 1024;

export interface GarmentUploadInput {
  mime: string;
  bytes: number; // file size in bytes
  displayName: string;
  productRef?: string | undefined;
  productUrl?: string | undefined;
}

export interface ValidatedGarmentUpload {
  mime: string;
  bytes: number;
  displayName: string;
  productRef: string | null;
  productUrl: string | null;
}

/** URL acceptance for merchant product pages: http(s) only, host required. */
export function isAcceptableProductUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname;
  } catch {
    return false;
  }
}

/**
 * Validate a garment upload exactly like evidence uploads: mime allow-list,
 * non-empty ≤10MB file, non-empty display name (≤120 chars), optional
 * product reference (≤128 chars) and optional product URL (http/https).
 * Throws TryOnRefusal('validation_failed') on any violation.
 */
export function validateGarmentUpload(input: GarmentUploadInput): ValidatedGarmentUpload {
  const mime = (input.mime ?? '').toLowerCase();
  if (!(GARMENT_ALLOWED_MIMES as readonly string[]).includes(mime)) {
    throw new TryOnRefusal(
      'validation_failed',
      `unsupported garment mime "${mime}" — allowed: ${GARMENT_ALLOWED_MIMES.join(', ')}`,
    );
  }
  if (!Number.isFinite(input.bytes) || input.bytes <= 0) {
    throw new TryOnRefusal('validation_failed', 'garment file is empty');
  }
  if (input.bytes > GARMENT_MAX_BYTES) {
    throw new TryOnRefusal(
      'validation_failed',
      `garment file exceeds the 10MB limit (${input.bytes} bytes)`,
    );
  }
  const displayName = (input.displayName ?? '').trim();
  if (!displayName) throw new TryOnRefusal('validation_failed', 'displayName is required (non-empty)');
  if (displayName.length > 120) {
    throw new TryOnRefusal('validation_failed', 'displayName exceeds 120 characters');
  }
  let productRef: string | null = null;
  if (input.productRef !== undefined && input.productRef !== null && String(input.productRef).trim() !== '') {
    const ref = String(input.productRef).trim();
    if (ref.length > 128) throw new TryOnRefusal('validation_failed', 'productRef exceeds 128 characters');
    productRef = ref;
  }
  let productUrl: string | null = null;
  if (input.productUrl !== undefined && input.productUrl !== null && String(input.productUrl).trim() !== '') {
    const url = String(input.productUrl).trim();
    if (url.length > 512) throw new TryOnRefusal('validation_failed', 'productUrl exceeds 512 characters');
    if (!isAcceptableProductUrl(url)) {
      throw new TryOnRefusal('validation_failed', 'productUrl must be an absolute http(s) URL');
    }
    productUrl = url;
  }
  return { mime, bytes: input.bytes, displayName, productRef, productUrl };
}

// ─── Fail-closed provider resolution (the renderProvider() law) ─────────────

export type TryOnProviderId = 'vertex-virtual-try-on';

export interface TryOnProviderEnv {
  /** Raw YOU_TRYON_PROVIDER value (undefined = unset). */
  provider?: string | undefined;
  /** YOU_TRYON_VERTEX_PROJECT (Vertex hosted path requires it). */
  vertexProject?: string | undefined;
  /** YOU_TRYON_VERTEX_LOCATION (Vertex hosted path requires it). */
  vertexLocation?: string | undefined;
  /** YOU_TRYON_VERTEX_KEY — the provider credential (never in code). */
  vertexKey?: string | undefined;
}

export interface TryOnProviderResolution {
  available: true;
  provider: TryOnProviderId;
  project: string;
  location: string;
}

export interface TryOnProviderUnavailable {
  available: false;
  reason: string;
}

export type TryOnProviderStatus = TryOnProviderResolution | TryOnProviderUnavailable;

const VERTEX_ID: TryOnProviderId = 'vertex-virtual-try-on';

/**
 * Resolve the virtual try-on provider from env. Fail-closed on every axis:
 *   - unset / '' / 'none'            → unavailable (honest reason, no guess)
 *   - 'vertex-virtual-try-on'        → hosted Vertex path; requires
 *                                      YOU_TRYON_VERTEX_PROJECT + _LOCATION +
 *                                      _KEY — any miss → unavailable with the
 *                                      precise missing-key list (never a guess)
 *   - anything else                  → throws (the platform refuses to guess
 *                                      which provider renders a garment)
 */
export function resolveTryOnProvider(env: TryOnProviderEnv): TryOnProviderStatus {
  const raw = (env.provider ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'none') {
    return {
      available: false,
      reason:
        'YOU_TRYON_PROVIDER is not configured — no virtual try-on provider is selected. Try-on jobs fail honestly here (fail-closed); never a stub image. Configure a characterized provider to enable the path.',
    };
  }
  if (raw !== VERTEX_ID) {
    throw new Error(
      `YOU_TRYON_PROVIDER must be "vertex-virtual-try-on" or unset/none (got "${raw}") — refusing to guess which provider renders the try-on`,
    );
  }
  const project = (env.vertexProject ?? '').trim();
  const location = (env.vertexLocation ?? '').trim();
  const key = (env.vertexKey ?? '').trim();
  const missing = [
    ...(project ? [] : ['YOU_TRYON_VERTEX_PROJECT']),
    ...(location ? [] : ['YOU_TRYON_VERTEX_LOCATION']),
    ...(key ? [] : ['YOU_TRYON_VERTEX_KEY']),
  ];
  if (missing.length > 0) {
    return {
      available: false,
      reason: `YOU_TRYON_PROVIDER="${VERTEX_ID}" but the hosted path is not configured — missing ${missing.join(', ')}. Try-on jobs fail honestly here (fail-closed); never a stub image.`,
    };
  }
  return { available: true, provider: VERTEX_ID, project, location };
}

// ─── Try-on options + input contract ────────────────────────────────────────

export const TRYON_STYLES = ['photorealistic', 'stylized-portrait', 'anime', 'illustration'] as const;
export type TryOnStyle = (typeof TRYON_STYLES)[number];

export interface TryOnInput {
  twinVersionId: string;
  twinId: string;
  garmentAssetId: string;
  style: TryOnStyle;
}

/** Validate the route body shape → TryOnInput (throws validation_failed). */
export function validateTryOnInput(raw: {
  twinId?: unknown;
  twinVersionId?: unknown;
  garmentAssetId?: unknown;
  style?: unknown;
}): TryOnInput {
  const twinId = typeof raw.twinId === 'string' ? raw.twinId.trim() : '';
  const twinVersionId = typeof raw.twinVersionId === 'string' ? raw.twinVersionId.trim() : '';
  const garmentAssetId = typeof raw.garmentAssetId === 'string' ? raw.garmentAssetId.trim() : '';
  if (!twinId || !twinVersionId || !garmentAssetId) {
    throw new TryOnRefusal('validation_failed', 'twinId, twinVersionId and garmentAssetId are required');
  }
  const style = typeof raw.style === 'string' && raw.style.trim() !== '' ? (raw.style as string).trim() : 'photorealistic';
  if (!(TRYON_STYLES as readonly string[]).includes(style)) {
    throw new TryOnRefusal('validation_failed', `style must be one of: ${TRYON_STYLES.join(', ')}`);
  }
  return { twinId, twinVersionId, garmentAssetId, style: style as TryOnStyle };
}

// ─── Diff manifest (what ACTUALLY changed — provider-reported or unknown) ───

export interface TryOnDiffChange {
  /** Body region the change applies to (e.g. 'torso', 'arms'). */
  region: string;
  /** Human-readable description of the change. */
  description: string;
  /** Who reported it: 'provider' (the hosted API said so) | 'unknown'. */
  source: 'provider' | 'unknown';
}

export interface TryOnDiffManifest {
  /**
   * Changes the provider actually reported in its response, verbatim-mapped.
   * When the provider reports nothing, this is the single honest
   * unknown-source entry — never an invented change list.
   */
  changes: TryOnDiffChange[];
  /** True when the provider did not report structured diff information. */
  providerReportedNothing: boolean;
}

export const NO_PROVIDER_DIFF: TryOnDiffManifest = {
  changes: [
    {
      region: 'garment-area',
      description: 'the provider returned an image but no structured change report — what changed is unknown',
      source: 'unknown',
    },
  ],
  providerReportedNothing: true,
};

/** Map a provider-reported change payload into the manifest (defensive). */
export function diffManifestFromProvider(
  reported: unknown,
): TryOnDiffManifest {
  if (!Array.isArray(reported) || reported.length === 0) return NO_PROVIDER_DIFF;
  const changes: TryOnDiffChange[] = [];
  for (const item of reported) {
    if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      const region = typeof rec.region === 'string' && rec.region.trim() ? rec.region.trim().slice(0, 64) : '';
      const description =
        typeof rec.description === 'string' && rec.description.trim() ? rec.description.trim().slice(0, 400) : '';
      if (region && description) changes.push({ region, description, source: 'provider' });
    }
  }
  if (changes.length === 0) return NO_PROVIDER_DIFF;
  return { changes, providerReportedNothing: false };
}

// ─── Identity-preservation report (honest by construction) ──────────────────

export type IdentityCheckStatus = 'verified' | 'unverified' | 'failed';

export interface IdentityCheck {
  status: IdentityCheckStatus;
  /** How the check ran: 'vision-comparison' (a real VLM call) | 'none'. */
  method: 'vision-comparison' | 'none';
  /** Real similarity score 0..1 when a vision comparison ran; null = unknown. */
  score: number | null;
  /** Why the check is unverified/failed — the honest reason, verbatim. */
  reason: string;
}

export interface TryOnIdentityReport {
  /** The garment's product reference, verbatim (null when the garment has none). */
  productRef: string | null;
  /**
   * Structural invariant (we control persistence): the comparison artifact
   * references the garment's exact productRef. False is a hard failure —
   * the job must fail (identity_check_failed), never ship a mismatched ref.
   */
  productRefPreserved: boolean;
  /** Did the rendered output preserve THE garment's visual identity? */
  garmentIdentity: IdentityCheck;
  /** Did the try-on output preserve the twin's visual identity vs baseline? */
  twinIdentity: IdentityCheck;
  /** Overall: every executed check passed (unverified checks do not pass this). */
  checksPassed: boolean;
  /** Honest failure reasons (empty when all checks passed). */
  failures: string[];
}

export interface VisionComparisonResult {
  /** Real score 0..1 from the vision call. */
  score: number;
  /** Verbatim model note (e.g. the comparison verdict text, bounded). */
  note: string;
}

/**
 * Parse a vision-comparison response into {score, note}. STRICTLY honest:
 * accepts a JSON object (bare or fenced) with a finite 0..1 "score" and an
 * optional string "note"; anything else parses to null — an unparseable
 * vision answer NEVER becomes a guessed score.
 */
export function parseVisionComparison(content: string): VisionComparisonResult | null {
  const trimmed = (content ?? '').trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenced ? fenced[1] : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  const score = rec.score;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) return null;
  const note = typeof rec.note === 'string' ? rec.note.slice(0, 200) : '';
  return { score, note };
}

/**
 * Build the identity-preservation report. LAWS:
 * - productRefPreserved is a REAL structural check over the recorded refs;
 * - garment/twin identity checks are 'unverified' (score null + reason)
 *   unless a vision comparison actually ran — never an invented score;
 * - a vision score below `threshold` is an honest 'failed' check.
 */
export function buildIdentityReport(input: {
  garmentProductRef: string | null;
  artifactProductRef: string | null;
  garmentVsOutput: VisionComparisonResult | null;
  baselineVsOutput: VisionComparisonResult | null;
  visionUnavailableReason?: string;
  threshold?: number;
}): TryOnIdentityReport {
  const threshold = input.threshold ?? 0.6;
  const failures: string[] = [];

  const productRefPreserved = input.garmentProductRef === input.artifactProductRef;
  if (!productRefPreserved) {
    failures.push(
      `product reference not preserved: garment carries ${JSON.stringify(input.garmentProductRef)} but the artifact records ${JSON.stringify(input.artifactProductRef)}`,
    );
  }

  const noVision = input.visionUnavailableReason ?? 'no vision comparison ran — identity preservation is unknown';
  const makeCheck = (result: VisionComparisonResult | null | undefined, label: string): IdentityCheck => {
    if (result === null || result === undefined) {
      return { status: 'unverified', method: 'none', score: null, reason: noVision };
    }
    if (!Number.isFinite(result.score) || result.score < 0 || result.score > 1) {
      return {
        status: 'unverified',
        method: 'vision-comparison',
        score: null,
        reason: `the vision comparison returned a non-finite score (${String(result.score)}) — refusing to report it`,
      };
    }
    if (result.score < threshold) {
      failures.push(`${label} identity check failed: vision score ${result.score.toFixed(3)} < threshold ${threshold}`);
      return {
        status: 'failed',
        method: 'vision-comparison',
        score: result.score,
        reason: `vision score ${result.score.toFixed(3)} is below the ${threshold} threshold — the output does not preserve ${label} identity`,
      };
    }
    return {
      status: 'verified',
      method: 'vision-comparison',
      score: result.score,
      reason: `vision comparison score ${result.score.toFixed(3)} ≥ threshold ${threshold}${result.note ? ` — ${result.note.slice(0, 200)}` : ''}`,
    };
  };

  const garmentIdentity = makeCheck(input.garmentVsOutput, 'garment');
  const twinIdentity = makeCheck(input.baselineVsOutput, 'twin');

  const checksPassed =
    productRefPreserved && garmentIdentity.status === 'verified' && twinIdentity.status === 'verified';

  return {
    productRef: input.garmentProductRef,
    productRefPreserved,
    garmentIdentity,
    twinIdentity,
    checksPassed,
    failures,
  };
}

// ─── Provider call shapes (Vertex Virtual Try-On, public-docs mapped) ───────

export interface TryOnProviderCallInput {
  /** Person/base image bytes (the twin's baseline render). */
  personImage: Uint8Array;
  /** Garment product image bytes (as uploaded, content-addressed). */
  garmentImage: Uint8Array;
}

export interface TryOnProviderCallResult {
  /** The try-on output image bytes (garment transferred onto the person). */
  imageBytes: Uint8Array;
  /** Provider-reported structured changes, when any (→ diff manifest). */
  reportedChanges: unknown;
  /** Provider task id when task-based, else null (predict is synchronous). */
  taskId: string | null;
  /** Model version the provider reported, else null. */
  modelVersion: string | null;
  /** REAL latency of the hosted HTTP call, measured at the call boundary. */
  latencyMs: number;
}

/** Injectable HTTP dep — the real seam passes plain fetch (timeout applied). */
export type TryOnFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** The hosted try-on endpoint URL for a resolved project/location. */
export function vertexTryOnUrl(project: string, location: string): string {
  return `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/endpoints/open-api/api/v1/multimodal:predict`;
}

/**
 * Build the hosted try-on request body (person + garment, base64, mime-typed).
 * Exported for tests + audit: the exact wire shape is contract-visible.
 */
export function buildVertexTryOnRequest(input: TryOnProviderCallInput, personMime: string, garmentMime: string): string {
  return JSON.stringify({
    personImage: { bytesBase64Encoded: toBase64(input.personImage), mimeType: personMime },
    productImage: { bytesBase64Encoded: toBase64(input.garmentImage), mimeType: garmentMime },
  });
}

/**
 * Execute the hosted try-on call through the injected fetch. VERBATIM error
 * law: any non-2xx surfaces as TryOnRefusal('provider_error') with the exact
 * status + body excerpt; network/parse failures surface verbatim too. The
 * response's generated image (base64) is returned as bytes; a response with
 * no image refuses honestly (never a placeholder image).
 */
export async function executeVertexTryOnCall(
  resolution: TryOnProviderResolution,
  input: TryOnProviderCallInput,
  opts: {
    personMime: string;
    garmentMime: string;
    /** The provider credential (env-read by the executor, never persisted). */
    apiKey: string;
    fetchImpl: TryOnFetch;
    timeoutMs?: number;
  },
): Promise<TryOnProviderCallResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const url = vertexTryOnUrl(resolution.project, resolution.location);
  const body = buildVertexTryOnRequest(input, opts.personMime, opts.garmentMime);
  let res: { ok: boolean; status: number; text: () => Promise<string> };
  const startedAt = Date.now();
  try {
    res = await opts.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // the credential flows env → header, never into logs or storage
        'x-goog-api-key': opts.apiKey,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new TryOnRefusal(
      'provider_error',
      `try-on provider call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const latencyMs = Math.max(0, Date.now() - startedAt);
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new TryOnRefusal(
      'provider_error',
      `try-on provider returned HTTP ${res.status}: ${text.slice(0, 400) || '(empty body)'}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TryOnRefusal('provider_error', `try-on provider response is not valid JSON: ${text.slice(0, 200)}`);
  }
  const rec = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const candidates = Array.isArray(rec.candidates) ? (rec.candidates as Record<string, unknown>[]) : [];
  const first = candidates[0] ?? {};
  const content =
    first.content && typeof first.content === 'object' ? (first.content as Record<string, unknown>) : {};
  const parts = Array.isArray(content.parts) ? (content.parts as Record<string, unknown>[]) : [];
  const inline = parts.find((p) => typeof p.inlineData === 'object' && p.inlineData !== null) as
    | { inlineData?: { data?: unknown; mimeType?: unknown } }
    | undefined;
  const b64 = inline?.inlineData && typeof inline.inlineData.data === 'string' ? inline.inlineData.data : '';
  if (!b64) {
    throw new TryOnRefusal(
      'provider_error',
      'try-on provider response carries no generated image (no candidates[].content.parts[].inlineData) — refusing to substitute a placeholder',
    );
  }
  const imageBytes = Buffer.from(b64, 'base64');
  if (imageBytes.byteLength === 0) {
    throw new TryOnRefusal('provider_error', 'try-on provider returned an empty image payload');
  }
  const reportedChanges = rec.reportedChanges ?? null;
  const modelVersion = typeof rec.modelVersion === 'string' && rec.modelVersion.trim() ? rec.modelVersion.trim() : null;
  return { imageBytes: new Uint8Array(imageBytes), reportedChanges, taskId: null, modelVersion, latencyMs };
}

// ─── The composed result contract ────────────────────────────────────────────

export interface TryOnSuccess {
  /** Stored try-on output image (content-addressed key, written by the executor). */
  storageKey: string;
  contentHash: string;
  bytes: number;
  mime: string;
  /** The baseline render refs — the comparison's LEFT panel (side-by-side). */
  baseline: { storageKey: string; contentHash: string; bytes: number; mime: string };
  /** REAL provider latency (the hosted call only). */
  latencyMs: number;
  provider: TryOnProviderId;
  /** Model id the provider reported, or null when it did not. */
  providerModel: string | null;
  providerTaskId: string | null;
  /** Side-by-side comparison manifest (what actually changed). */
  diffManifest: TryOnDiffManifest;
  /** The identity-preservation report (honest statuses, never invented). */
  identityReport: TryOnIdentityReport;
  /** CONTRACT FIELD — must equal VISUAL_ONLY_DISCLAIMER verbatim. */
  visualOnlyDisclaimer: string;
}

/**
 * Contract assertion: a composed try-on result is only valid when the
 * disclaimer is intact and the identity report has honest shape (scores only
 * when a vision comparison ran; productRefPreserved true — a false value
 * must fail the job instead of composing a result).
 */
export function assertTryOnSuccess(result: TryOnSuccess): TryOnSuccess {
  if (!disclaimerIsIntact(result.visualOnlyDisclaimer)) {
    throw new TryOnRefusal(
      'validation_failed',
      'try-on contract violation: visualOnlyDisclaimer is missing or altered — a try-on result may never ship without the verbatim visual-only disclaimer',
    );
  }
  if (!result.identityReport.productRefPreserved) {
    throw new TryOnRefusal(
      'identity_check_failed',
      `try-on contract violation: product reference not preserved — ${result.identityReport.failures.join('; ')}`,
    );
  }
  const check = (c: IdentityCheck) => {
    if (c.status === 'unverified' && c.score !== null) {
      throw new TryOnRefusal(
        'validation_failed',
        'try-on contract violation: an unverified identity check must carry score null (unknown is unknown)',
      );
    }
    if (c.status !== 'unverified' && c.score === null) {
      throw new TryOnRefusal(
        'validation_failed',
        'try-on contract violation: a verified/failed identity check must carry its real vision score',
      );
    }
  };
  check(result.identityReport.garmentIdentity);
  check(result.identityReport.twinIdentity);
  return result;
}

// ─── The pipeline fold (pure; the executor composes it with real deps) ──────

export interface TryOnPipelineDeps {
  /** Resolve the provider from the REAL env (env captured by the executor). */
  resolveProvider: () => TryOnProviderStatus;
  /** Load the garment image bytes from content-addressed storage. */
  loadGarmentBytes: (storageKey: string) => Promise<Uint8Array | null>;
  /** Render + store the twin's BASELINE image; returns its refs (real provider call). */
  renderBaseline: () => Promise<{
    storageKey: string;
    contentHash: string;
    bytes: number;
    mime: string;
    latencyMs: number;
    provider: string;
    providerModel: string | null;
  }>;
  /** Store the try-on output image (content-addressed). */
  storeTryOnImage: (bytes: Uint8Array, mime: string) => Promise<{ storageKey: string; contentHash: string; bytes: number }>;
  /**
   * The hosted try-on call: receives the baseline REF + garment BYTES. The
   * executor's implementation loads the baseline bytes and runs
   * executeVertexTryOnCall with the real env credential; tests inject a fake.
   */
  callProvider: (
    baseline: { storageKey: string; mime: string },
    garment: { bytes: Uint8Array; mime: string },
  ) => Promise<TryOnProviderCallResult>;
  /** Optional REAL vision comparisons for identity checks (null-able per check). */
  compareImages: (
    a: { storageKey: string; label: string },
    b: { storageKey: string; label: string },
  ) => Promise<VisionComparisonResult | null>;
  /** The garment's product reference (provenance). */
  garmentProductRef: string | null;
  /** Product ref the artifact will record — must equal garmentProductRef. */
  artifactProductRef: string | null;
  /** Honest reason when vision comparison is unavailable (else undefined). */
  visionUnavailableReason?: string;
}

export interface TryOnPipelineProgress {
  step: 'provider' | 'baseline' | 'tryon' | 'comparison';
  detail: string;
}

/**
 * Run the pure try-on pipeline fold:
 *   provider (fail-closed) → baseline render → hosted try-on → store →
 *   diff manifest → identity report → assertTryOnSuccess (contract).
 * Progress surfaces only on REAL signals; every refusal propagates typed.
 */
export async function runTryOnPipeline(
  input: { garmentStorageKey: string; garmentMime: string },
  deps: TryOnPipelineDeps,
  onProgress?: (p: TryOnPipelineProgress) => Promise<void> | void,
): Promise<TryOnSuccess> {
  // 1. fail-closed provider availability — BEFORE any provider spend
  const status = deps.resolveProvider();
  if (!status.available) {
    throw new TryOnRefusal('tryon_unavailable', status.reason);
  }
  await onProgress?.({ step: 'provider', detail: `provider ${status.provider} resolved (project ${status.project})` });

  // 2. load the garment bytes (content-addressed, immutable)
  const garmentImage = await deps.loadGarmentBytes(input.garmentStorageKey);
  if (!garmentImage) {
    throw new TryOnRefusal('validation_failed', `garment image "${input.garmentStorageKey}" not found in object storage`);
  }

  // 3. baseline render of the twin (body-aware base image from the HTIR)
  const baseline = await deps.renderBaseline();
  await onProgress?.({
    step: 'baseline',
    detail: `baseline render stored (${baseline.bytes} bytes, provider ${baseline.provider}, ${baseline.latencyMs}ms)`,
  });

  // 4. the hosted try-on call — REAL latency measured at the HTTP boundary
  const call = await deps.callProvider(
    { storageKey: baseline.storageKey, mime: baseline.mime },
    { bytes: garmentImage, mime: input.garmentMime },
  );
  await onProgress?.({
    step: 'tryon',
    detail: `try-on render returned (${call.imageBytes.byteLength} bytes, ${call.latencyMs}ms)`,
  });

  // 5. store the try-on output (content-addressed, immutable)
  const stored = await deps.storeTryOnImage(call.imageBytes, 'image/png');

  // 6. diff manifest — provider-reported or honestly unknown
  const diffManifest = diffManifestFromProvider(call.reportedChanges);

  // 7. identity-preservation report — real checks or honest unknowns
  const garmentVsOutput = await deps
    .compareImages(
      { storageKey: input.garmentStorageKey, label: 'garment' },
      { storageKey: stored.storageKey, label: 'try-on output' },
    )
    .catch(() => null);
  const baselineVsOutput = await deps
    .compareImages(
      { storageKey: baseline.storageKey, label: 'baseline' },
      { storageKey: stored.storageKey, label: 'try-on output' },
    )
    .catch(() => null);
  const identityReport = buildIdentityReport({
    garmentProductRef: deps.garmentProductRef,
    artifactProductRef: deps.artifactProductRef,
    garmentVsOutput,
    baselineVsOutput,
    ...(deps.visionUnavailableReason !== undefined ? { visionUnavailableReason: deps.visionUnavailableReason } : {}),
  });
  await onProgress?.({
    step: 'comparison',
    detail: `identity report: garment ${identityReport.garmentIdentity.status}, twin ${identityReport.twinIdentity.status}, productRef ${
      identityReport.productRefPreserved ? 'preserved' : 'NOT preserved'
    }`,
  });

  const result: TryOnSuccess = {
    storageKey: stored.storageKey,
    contentHash: stored.contentHash,
    bytes: stored.bytes,
    mime: 'image/png',
    baseline: {
      storageKey: baseline.storageKey,
      contentHash: baseline.contentHash,
      bytes: baseline.bytes,
      mime: baseline.mime,
    },
    latencyMs: call.latencyMs,
    provider: status.provider,
    providerModel: call.modelVersion,
    providerTaskId: call.taskId,
    diffManifest,
    identityReport,
    visualOnlyDisclaimer: VISUAL_ONLY_DISCLAIMER,
  };
  return assertTryOnSuccess(result);
}
