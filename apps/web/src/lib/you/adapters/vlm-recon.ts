// ═══════════════════════════════════════════════════════════════════════════
// vlm-recon-1 — VLM-driven reconstruction evidence analyzer (Worker C lane).
// The core analysis stage of HUMAN-RECON-001.
//
// Honesty & privacy contract:
// - INFERENCE ONLY: the vision model receives image bytes as transient input
//   for analysis; YOU never trains on user biometric data (no training path
//   exists in this adapter at all).
// - Raw evidence stays in object storage; only analysis DERIVATIVES
//   (descriptors, confidences, coverage) are persisted.
// - Provider errors surface verbatim; parse failures retry once, then fail
//   honestly — never fabricate descriptors.
// - Every call's real latency is returned in `usage`.
// ═══════════════════════════════════════════════════════════════════════════
import type {
  CaptureRegion,
  EvidenceQuality,
  HtirAppearance,
  HtirArticulation,
  HtirConfidence,
  HtirConfidenceDeficiency,
  HtirGeometry,
  HtirMorphology,
  HtirMotionProfile,
  HtirNeuralAppearance,
  RenderStyle,
} from '../contracts';
import { visionAnalyze } from '../ai/zai';
import { getObject } from '../core/storage';
import { clamp, round } from '../lab/determinism';

export const VLM_RECON_ADAPTER = {
  adapterId: 'vlm-recon-1',
  version: '1',
  inferenceOnly: true,
  trainingOnBiometrics: false,
  privacyNote:
    'inference-only analysis; raw evidence stays in object storage and is passed to the vision model solely as transient analysis input; no training is performed on user biometric data',
} as const;

// ─── Canonical region model ──────────────────────────────────────────────────

export const CANONICAL_REGIONS: CaptureRegion[] = [
  'face.front', 'face.profile', 'face.hairline', 'teeth',
  'hands', 'hair.back', 'silhouette.front', 'silhouette.side',
  'walking', 'speech',
];

const REGION_IMPORTANCE: Record<CaptureRegion, 'high' | 'medium' | 'low'> = {
  'face.front': 'high',
  'face.profile': 'high',
  hands: 'high',
  'hair.back': 'high',
  'silhouette.side': 'high',
  'face.hairline': 'medium',
  'silhouette.front': 'medium',
  teeth: 'medium',
  walking: 'low',
  speech: 'low',
  custom: 'low',
};

const REMEDIATION: Record<CaptureRegion, string> = {
  'face.front': 'Capture a front-facing photo of the face with a neutral expression and even lighting.',
  'face.profile': 'Capture a ¾ or full side-profile photo of the face (head turned 45–90°).',
  'face.hairline': 'Capture a front photo with the forehead/hairline visible (hair pulled back if possible).',
  teeth: 'Capture a short clip with a natural smile briefly showing teeth.',
  hands: 'Capture a photo or short clip with palms visible and fingers spread at chest height.',
  'hair.back': 'Capture a rear-view photo of the head showing hair volume and the back hairline.',
  'silhouette.front': 'Capture a full-body front-facing photo against a plain background.',
  'silhouette.side': 'Capture a full-body side-view photo against a plain background.',
  walking: 'Capture a 5–10 second walking clip (full body, side view).',
  speech: 'Capture a 5–10 second clip while speaking naturally.',
  custom: 'Capture the additional evidence described by the corresponding evidence request.',
};

function isCanonicalRegion(s: string): s is CaptureRegion {
  return (CANONICAL_REGIONS as string[]).includes(s);
}

// ─── Strict JSON handling ────────────────────────────────────────────────────

function stripFences(text: string): string {
  return text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

export class VlmReconParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VlmReconParseError';
  }
}

/**
 * Parse model output as JSON. Strips code fences, extracts the outermost
 * object, retries ONCE with a "JSON only" reminder, then fails honestly.
 */
export async function parseModelJson<T>(
  rawContent: string,
  retry: () => Promise<string>
): Promise<T> {
  const attempt = (content: string): T | null => {
    const candidate = extractJsonObject(stripFences(content));
    if (!candidate) return null;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      return null;
    }
  };
  const first = attempt(rawContent);
  if (first) return first;
  const retried = await retry();
  const second = attempt(retried);
  if (second) return second;
  throw new VlmReconParseError(
    `vlm-recon-1: model did not return parseable JSON after one retry. Last output started with: ${rawContent.slice(0, 160)}`
  );
}

// ─── Per-asset analysis contracts ─────────────────────────────────────────────

export interface VlmReconAssetInput {
  id: string;
  storageKey: string;
  mime: string;
  regions: CaptureRegion[];
}

export interface VlmReconDescriptors {
  build: string | null;
  ageEstimate: string | null;
  presentation: string | null;
  hair: string | null;
  hairColorTone: string | null;
  hairColorHex: string | null;
  skinToneTone: string | null;
  skinToneHex: string | null;
  eyeTone: string | null;
  eyeToneHex: string | null;
  clothingItems: string[];
  clothingStyle: string | null;
  clothingColorHexes: string[];
  distinguishing: string[];
  facialHair: string | null;
  glasses: boolean | null;
}

export interface VlmReconGeometryHints {
  shoulderRatio: number | null;
  headRatio: number | null;
  faceShape: string | null;
}

export interface VlmReconConfidence {
  overall: number;
  morphology: number;
  appearance: number;
  geometry: number;
}

export interface VlmAssetAnalysis {
  assetId: string;
  usable: boolean;
  blur: 'none' | 'light' | 'heavy';
  lighting: 'good' | 'uneven' | 'poor';
  issues: string[];
  observedRegions: string[];
  score: number;
  descriptors: VlmReconDescriptors;
  geometryHints: VlmReconGeometryHints;
  confidence: VlmReconConfidence;
  latencyMs: number; // real per-call latency
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

const JSON_ONLY_REMINDER =
  '\n\nREMINDER: respond with ONLY the JSON object. No markdown fences, no prose before or after.';

const EVIDENCE_SET_PROMPT = `You are the evidence analysis stage ("vlm-recon-1") of a human digital-twin reconstruction pipeline. Analyze this photo of a person to produce a respectful, abstract descriptor set used to build a stylized avatar. This is inference-only analysis: no training, no identification, no biometric matching. Describe only what is visible; use null when uncertain; never guess specifics.

Respond with ONLY a valid JSON object (no markdown fences, no commentary) exactly matching this shape:
{
  "usable": boolean,
  "blur": "none" | "light" | "heavy",
  "lighting": "good" | "uneven" | "poor",
  "issues": string[],
  "observedRegions": string[],
  "score": number,
  "descriptors": {
    "build": string | null,
    "ageEstimate": string | null,
    "presentation": string | null,
    "hair": string | null,
    "hairColorTone": string | null,
    "hairColorHex": string | null,
    "skinToneTone": string | null,
    "skinToneHex": string | null,
    "eyeTone": string | null,
    "eyeToneHex": string | null,
    "clothingItems": string[],
    "clothingStyle": string | null,
    "clothingColorHexes": string[],
    "distinguishing": string[],
    "facialHair": string | null,
    "glasses": boolean | null
  },
  "geometryHints": { "shoulderRatio": number | null, "headRatio": number | null, "faceShape": string | null },
  "confidence": { "overall": number, "morphology": number, "appearance": number, "geometry": number }
}
Rules:
- observedRegions: ONLY strings from this list that are actually visible: ["face.front","face.profile","face.hairline","teeth","hands","hair.back","silhouette.front","silhouette.side","walking","speech"]. Empty array if none apply.
- score: 0..1 evidence quality for reconstruction (framing, sharpness, lighting, how much of the person is visible).
- tone fields are human-readable ("dark brown", "warm medium", "hazel"); *Hex fields are approximate hex colors like "#4a3320" estimated from the image.
- distinguishing: respectful, visible features only (e.g. "glasses", "beard", "freckles"). No identity claims.
- confidence numbers are 0..1 and must be honest about what the image supports.`;

const QUALITY_PROMPT = `You are the capture quality stage ("vlm-recon-1") of a human digital-twin pipeline. Assess whether this photo is usable as reconstruction evidence. Inference-only; describe only what is visible.

Respond with ONLY a valid JSON object (no markdown fences, no commentary) exactly matching:
{
  "usable": boolean,
  "blur": "none" | "light" | "heavy",
  "lighting": "good" | "uneven" | "poor",
  "issues": string[],
  "observedRegions": string[],
  "score": number
}
Rules:
- observedRegions: ONLY strings from ["face.front","face.profile","face.hairline","teeth","hands","hair.back","silhouette.front","silhouette.side","walking","speech"] that are actually visible.
- score: 0..1 (sharpness, lighting, framing, visibility of the person).
- issues: concrete, actionable problems (e.g. "motion blur on hands", "backlit face").`;

// ─── Tone → hex fallbacks (only used when the model omits hex fields) ────────

const TONE_HEX: Array<[RegExp, string]> = [
  [/black|jet/i, '#1c1a17'],
  [/dark brown|brunette/i, '#3b2a20'],
  [/brown|chestnut/i, '#5a3d28'],
  [/auburn|red|ginger/i, '#7a3b22'],
  [/blonde|blond|fair hair/i, '#c9a86a'],
  [/gray|grey|silver|white/i, '#b9b6b0'],
  [/pale|fair|porcelain/i, '#f0d9c8'],
  [/light skin|light-medium/i, '#e8c4a2'],
  [/medium|tan|olive/i, '#c8956c'],
  [/brown skin|deep tan/i, '#a06a42'],
  [/dark skin|deep/i, '#6f4629'],
  [/blue eyes|blue/i, '#4f6d8f'],
  [/green eyes|green/i, '#5c7a52'],
  [/hazel/i, '#8a7350'],
  [/brown eyes|dark eyes/i, '#4a342a'],
  [/amber/i, '#a8783c'],
];

function toneFallback(tone: string | null | undefined, fallback: string): string {
  if (!tone) return fallback;
  for (const [re, hex] of TONE_HEX) if (re.test(tone)) return hex;
  return fallback;
}

function normalizeHex(hex: string | null | undefined, fallback: string): string {
  if (!hex) return fallback;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  return m ? `#${m[1].toLowerCase()}` : fallback;
}

// ─── Asset loading ───────────────────────────────────────────────────────────

async function assetToDataUrl(asset: VlmReconAssetInput): Promise<string> {
  const buf = await getObject(asset.storageKey);
  if (!buf) {
    throw new Error(
      `vlm-recon-1: evidence object missing from storage (asset ${asset.id}, key ${asset.storageKey}) — refusing to fabricate analysis`
    );
  }
  return `data:${asset.mime};base64,${buf.toString('base64')}`;
}

// ─── Public API: single-asset quality analysis (capture.quality job) ─────────

export interface AssetQualityResult {
  assetId: string;
  quality: EvidenceQuality;
  latencyMs: number;
}

export async function analyzeAssetQuality(asset: VlmReconAssetInput): Promise<AssetQualityResult> {
  const dataUrl = await assetToDataUrl(asset);
  const res = await visionAnalyze(dataUrl, QUALITY_PROMPT, { thinking: false });
  const parsed = await parseModelJson<{
    usable?: boolean; blur?: string; lighting?: string; issues?: unknown;
    observedRegions?: unknown; score?: number;
  }>(res.content, async () => {
    const retry = await visionAnalyze(dataUrl, QUALITY_PROMPT + JSON_ONLY_REMINDER, { thinking: false });
    return retry.content;
  });

  const blur: EvidenceQuality['blur'] =
    parsed.blur === 'light' || parsed.blur === 'heavy' ? parsed.blur : 'none';
  const lighting: EvidenceQuality['lighting'] =
    parsed.lighting === 'uneven' || parsed.lighting === 'poor' ? parsed.lighting : 'good';
  const observed = Array.isArray(parsed.observedRegions)
    ? parsed.observedRegions.filter((r): r is string => typeof r === 'string' && isCanonicalRegion(r))
    : [];
  // Coverage = VLM-observed regions ∪ regions declared for the asset at upload
  // time (declared coverage is evidence metadata, not fabrication).
  const coverage = [
    ...new Set([
      ...asset.regions.filter(isCanonicalRegion),
      ...observed.filter(isCanonicalRegion),
    ]),
  ];
  const issues = Array.isArray(parsed.issues)
    ? parsed.issues.filter((i): i is string => typeof i === 'string').slice(0, 10)
    : [];

  return {
    assetId: asset.id,
    latencyMs: res.latencyMs,
    quality: {
      usable: typeof parsed.usable === 'boolean' ? parsed.usable : parsed.score !== undefined ? parsed.score >= 0.4 : false,
      blur,
      lighting,
      coverage,
      issues,
      score: clamp(typeof parsed.score === 'number' ? parsed.score : 0.5, 0, 1),
    },
  };
}

// ─── Public API: evidence-set reconstruction analysis (twin.compile job) ─────

export interface EvidenceSetAnalysis {
  htirDraft: {
    morphology: HtirMorphology;
    geometry: HtirGeometry;
    appearance: HtirAppearance;
    articulation: HtirArticulation;
    neuralAppearance: HtirNeuralAppearance;
    motionProfile: HtirMotionProfile;
    confidence: HtirConfidence;
  };
  perAsset: VlmAssetAnalysis[];
  usage: { llmCalls: number; totalLatencyMs: number };
}

export async function analyzeEvidenceSet(
  assets: VlmReconAssetInput[],
  style: RenderStyle
): Promise<EvidenceSetAnalysis> {
  if (assets.length === 0) {
    throw new Error('vlm-recon-1: analyzeEvidenceSet called with zero assets — refusing to fabricate an HTIR draft');
  }

  const perAsset: VlmAssetAnalysis[] = [];
  let totalLatencyMs = 0;
  let llmCalls = 0;

  for (const asset of assets) {
    const dataUrl = await assetToDataUrl(asset);
    const prompt = `${EVIDENCE_SET_PROMPT}\n\nTarget render style for the avatar: "${style}".`;
    const res = await visionAnalyze(dataUrl, prompt, { thinking: false });
    llmCalls += 1;
    totalLatencyMs += res.latencyMs;
    const parsed = await parseModelJson<Record<string, unknown>>(res.content, async () => {
      const retry = await visionAnalyze(dataUrl, prompt + JSON_ONLY_REMINDER, { thinking: false });
      llmCalls += 1;
      totalLatencyMs += retry.latencyMs;
      return retry.content;
    });
    perAsset.push(normalizeAssetAnalysis(asset.id, parsed, res.latencyMs));
  }

  const usable = perAsset.filter((a) => a.usable);
  const pool = usable.length > 0 ? usable : perAsset; // if nothing is "usable", still report honest low-confidence analysis

  // weights: evidence quality × model self-confidence
  const weighted = pool.map((a) => ({
    a,
    w: Math.max(0.05, a.score * clamp(a.confidence.overall, 0.05, 1)),
  }));
  const wTotal = weighted.reduce((s, x) => s + x.w, 0);

  const weightedMean = (get: (a: VlmAssetAnalysis) => number | null): number | null => {
    const vals = weighted.filter((x) => typeof get(x.a) === 'number');
    if (vals.length === 0) return null;
    return vals.reduce((s, x) => s + (get(x.a) as number) * x.w, 0) / vals.reduce((s, x) => s + x.w, 0);
  };

  const pickByWeight = (get: (a: VlmAssetAnalysis) => string | null): string | null => {
    const vals = weighted.filter((x) => typeof get(x.a) === 'string' && (get(x.a) as string).length > 0);
    if (vals.length === 0) return null;
    vals.sort((x, y) => y.w - x.w);
    return get(vals[0].a);
  };

  // ── merge descriptors ──
  const d = (get: (x: VlmReconDescriptors) => string | null) => (a: VlmAssetAnalysis) => get(a.descriptors);
  const build = pickByWeight(d((x) => x.build));
  const ageEstimate = pickByWeight(d((x) => x.ageEstimate));
  const presentation = pickByWeight(d((x) => x.presentation));
  const hairDesc = pickByWeight(d((x) => x.hair));
  const hairTone = pickByWeight(d((x) => x.hairColorTone));
  const skinTone = pickByWeight(d((x) => x.skinToneTone));
  const eyeTone = pickByWeight(d((x) => x.eyeTone));
  const clothingStyle = pickByWeight(d((x) => x.clothingStyle));
  const facialHair = pickByWeight(d((x) => x.facialHair));

  const hairHex = normalizeHex(
    pickByWeight(d((x) => x.hairColorHex)),
    toneFallback(hairTone, '#3b2a20')
  );
  const skinHex = normalizeHex(
    pickByWeight(d((x) => x.skinToneHex)),
    toneFallback(skinTone, '#c8956c')
  );
  const eyeHex = normalizeHex(
    pickByWeight(d((x) => x.eyeToneHex)),
    toneFallback(eyeTone, '#4a342a')
  );
  const clothingHexes = pool
    .flatMap((a) => (Array.isArray(a.descriptors.clothingColorHexes) ? a.descriptors.clothingColorHexes : []))
    .filter((h): h is string => typeof h === 'string')
    .map((h) => normalizeHex(h, '#565a64'))
    .slice(0, 3);

  const clothingItems = [...new Set(pool.flatMap((a) => a.descriptors.clothingItems))].slice(0, 8);
  const distinguishing = [...new Set(pool.flatMap((a) => a.descriptors.distinguishing))].slice(0, 8);
  const glassesVotes = pool.map((a) => a.descriptors.glasses);
  const glasses = glassesVotes.some((g) => g === true)
    ? true
    : glassesVotes.every((g) => g === false)
      ? false
      : null;

  // ── coverage & deficiencies ──
  const covered = new Set<string>(pool.flatMap((a) => a.observedRegions.filter(isCanonicalRegion)));
  const highRegions = CANONICAL_REGIONS.filter((r) => REGION_IMPORTANCE[r] === 'high');
  const coveredHigh = highRegions.filter((r) => covered.has(r));
  const coverageFactor = coveredHigh.length / highRegions.length;

  const deficiencies: HtirConfidenceDeficiency[] = CANONICAL_REGIONS.filter((r) => !covered.has(r)).map((r) => ({
    capability: r,
    severity: REGION_IMPORTANCE[r],
    reason: `No evidence asset in this set observes the "${r}" region of the subject.`,
    remediation: REMEDIATION[r],
  }));

  // ── confidences ──
  const conf = (k: keyof VlmReconConfidence) => clamp(weightedMean((a) => a.confidence[k]) ?? 0.4, 0, 1);
  const overallRaw = conf('overall');
  const overall = round(overallRaw * (0.55 + 0.45 * coverageFactor), 3);

  // ── geometry ──
  const shoulderRatio = weightedMean((a) => a.geometryHints.shoulderRatio);
  const headRatio = weightedMean((a) => a.geometryHints.headRatio);
  const faceShape = pickByWeight((a) => a.geometryHints.faceShape);

  // ── hair parsing (length keywords from descriptor, honest fallbacks) ──
  const hairLower = (hairDesc ?? '').toLowerCase();
  const hairLength = /bald|shaved|buzz/.test(hairLower)
    ? 'very short'
    : /\bvery short|cropped|short\b/.test(hairLower)
      ? 'short'
      : /shoulder|medium|mid-length/.test(hairLower)
        ? 'medium'
        : /long|past shoulder|flowing/.test(hairLower)
          ? 'long'
          : null;
  const hairCoverage: HtirAppearance['hair']['coverage'] =
    hairLength === 'very short' || hairLength === 'short' ? 'low' : hairLength === 'long' ? 'high' : 'medium';

  // ── assemble the HTIR draft (provenance is filled by the twin.compile executor) ──
  const descriptorNotes = [build, presentation, ageEstimate ? `apparent age: ${ageEstimate}` : null, hairDesc, clothingStyle]
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .slice(0, 8);

  const appearance: HtirAppearance = {
    palette: {
      skin: skinHex,
      hair: hairHex,
      eyes: eyeHex,
      clothing: clothingHexes.length > 0 ? clothingHexes : undefined,
    },
    hair: {
      style: hairDesc ?? 'not observed',
      length: hairLength ?? 'not observed',
      coverage: hairCoverage,
    },
    clothing: {
      style: clothingStyle ?? 'not observed',
      items: clothingItems,
    },
    distinguishing: distinguishing,
  };

  const htirDraft: EvidenceSetAnalysis['htirDraft'] = {
    morphology: {
      build: build ?? 'not observed',
      ageEstimate: ageEstimate ?? undefined,
      presentation: presentation ?? undefined,
      descriptors: descriptorNotes,
      // heightEstimateCm deliberately omitted: single photos cannot honestly
      // establish absolute height without a reference scale.
    },
    geometry: {
      skeleton: 'you-generic-v1',
      measurements: {
        ...(shoulderRatio !== null ? { shoulderRatio: round(shoulderRatio, 3) } : {}),
        ...(headRatio !== null ? { headRatio: round(headRatio, 3) } : {}),
      },
      face: {
        landmarkSummary: faceShape ?? 'face shape not confidently observed',
        proportions: {},
      },
      hands: { detail: covered.has('hands') ? 'medium' : 'low' },
    },
    appearance,
    articulation: {
      blendshapes: ['neutral', 'smile', 'brow-raise', 'blink'],
      gazeModel: 'basic',
    },
    neuralAppearance: {
      enabled: false,
      notes:
        'wave-1: no neural-appearance adapter wired for twin compile; derived representations come from the deterministic svg-portrait-1 renderer and provider image/video adapters',
    },
    motionProfile: {
      defaultPose: 'neutral-standing',
      gestureStyle: 'reserved',
      tempo: 'moderate',
    },
    confidence: {
      overall,
      byDomain: {
        morphology: round(conf('morphology'), 3),
        appearance: round(conf('appearance'), 3),
        geometry: round(conf('geometry'), 3),
        ...(covered.has('speech') ? { voice: round(conf('appearance') * 0.8, 3) } : {}),
      },
      deficiencies,
    },
  };

  return { htirDraft, perAsset, usage: { llmCalls, totalLatencyMs } };
}

// ─── Normalization helpers ────────────────────────────────────────────────────

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 10) : [];
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function normalizeAssetAnalysis(assetId: string, parsed: Record<string, unknown>, latencyMs: number): VlmAssetAnalysis {
  const rawDesc = (parsed.descriptors ?? {}) as Record<string, unknown>;
  const rawGeo = (parsed.geometryHints ?? {}) as Record<string, unknown>;
  const rawConf = (parsed.confidence ?? {}) as Record<string, unknown>;

  const observed = Array.isArray(parsed.observedRegions)
    ? parsed.observedRegions.filter((r): r is string => typeof r === 'string').slice(0, 10)
    : [];

  return {
    assetId,
    usable: parsed.usable === true,
    blur: parsed.blur === 'light' || parsed.blur === 'heavy' ? (parsed.blur as 'light' | 'heavy') : 'none',
    lighting:
      parsed.lighting === 'uneven' || parsed.lighting === 'poor'
        ? (parsed.lighting as 'uneven' | 'poor')
        : 'good',
    issues: strArray(parsed.issues),
    observedRegions: observed,
    score: clamp(num(parsed.score) ?? 0.4, 0, 1),
    descriptors: {
      build: str(rawDesc.build),
      ageEstimate: str(rawDesc.ageEstimate),
      presentation: str(rawDesc.presentation),
      hair: str(rawDesc.hair),
      hairColorTone: str(rawDesc.hairColorTone),
      hairColorHex: str(rawDesc.hairColorHex),
      skinToneTone: str(rawDesc.skinToneTone),
      skinToneHex: str(rawDesc.skinToneHex),
      eyeTone: str(rawDesc.eyeTone),
      eyeToneHex: str(rawDesc.eyeToneHex),
      clothingItems: strArray(rawDesc.clothingItems),
      clothingStyle: str(rawDesc.clothingStyle),
      clothingColorHexes: strArray(rawDesc.clothingColorHexes),
      distinguishing: strArray(rawDesc.distinguishing),
      facialHair: str(rawDesc.facialHair),
      glasses: typeof rawDesc.glasses === 'boolean' ? rawDesc.glasses : null,
    },
    geometryHints: {
      shoulderRatio: num(rawGeo.shoulderRatio),
      headRatio: num(rawGeo.headRatio),
      faceShape: str(rawGeo.faceShape),
    },
    confidence: {
      overall: clamp(num(rawConf.overall) ?? 0.4, 0, 1),
      morphology: clamp(num(rawConf.morphology) ?? 0.4, 0, 1),
      appearance: clamp(num(rawConf.appearance) ?? 0.4, 0, 1),
      geometry: clamp(num(rawConf.geometry) ?? 0.3, 0, 1),
    },
    latencyMs,
  };
}
