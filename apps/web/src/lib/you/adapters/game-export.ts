// ═══════════════════════════════════════════════════════════════════════════
// game-export-1 — the game/VRM/GLB export adapter CONTRACT + pure emitter
// (Worker C lane, P6.C9 — docs/PHASE_6_HANDOFF.md §P14 gaming/AR).
//
// ZERO-IMPORT MODULE LAW (the try-on.ts / live-core.ts precedent): no db,
// no storage, no crypto, no SDK imports — everything environmental is passed
// in by the executor (lab/executors.ts, kinds 'export.glb' / 'export.vrm').
// node:test imports this file directly and exercises the CONTRACT, not the
// wiring. Buffer (a Node global) is the only runtime dependency.
//
// HONEST-CLAIMS CONTRACT (the order's core law):
// - The STRUCTURAL-vs-DERIVED split is PART OF THE CONTRACT: every export
//   manifest lists which fields came from the TwinVersion's HTIR verbatim
//   (structural) and which were synthesized/estimated (derived, each with
//   its basis). assertExportSuccess() refuses a manifest without the split.
// - The mesh is a PARAMETRIC SEGMENT representation derived from the HTIR's
//   skeleton convention + proportions — it is NOT scanned surface geometry
//   and the manifest says so verbatim (no photorealism claim anywhere).
// - Facial blendshapes are ZERO-DELTA PLACEHOLDERS emitted ONLY for the
//   HTIR articulation set; no blendshape is invented, no delta is fabricated.
// - LOD counts are measured from the REAL emitter output (the arrays that
//   ship in the GLB), never claimed without being emitted.
// - FAIL-CLOSED: unknown format → typed refusal (never a guess); a
//   TwinVersion without usable geometry (missing/unrecognized skeleton
//   convention, or no finite measurements to build proportions from) →
//   honest geometry_unavailable refusal — never a default-body export
//   pretending to be this twin.
// - DETERMINISM: identical TwinVersion + options → byte-identical GLB
//   (sha256-stable). No clocks, no randomness, no map-iteration order.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Adapter descriptor ─────────────────────────────────────────────────────

import type { JobKind } from '../contracts';

export const GAME_EXPORT_ADAPTER = {
  adapterId: 'game-export-1',
  version: '1',
  providerNeutral: true,
  localEmitter: true,
  deterministic: true,
  claimsNote:
    'the exported model is a parametric humanoid built from the HTIR (skeleton convention, body proportions, palette); it is NOT a photorealistic scan and NOT measured surface geometry — the structural-vs-derived split in the manifest is the contract',
} as const;

/**
 * The durable job kinds (core/jobs.ts lane-local widening — the frozen
 * contracts JobKind union gains the members at TL landing, the f1.reconstruct
 * / tryon.render precedent). The import above is TYPE-ONLY (erased at
 * runtime): this module stays zero-import (node:test importable).
 */
export const EXPORT_GLB_JOB_KIND = 'export.glb' as JobKind;
export const EXPORT_VRM_JOB_KIND = 'export.vrm' as JobKind;

/** The job kind for a format (fail-closed on unknown formats). */
export function exportJobKindFor(format: ExportFormat): 'export.glb' | 'export.vrm' {
  if (format === 'glb') return 'export.glb';
  if (format === 'vrm') return 'export.vrm';
  throw new ExportRefusal('validation_failed', `unknown export format "${String(format)}"`);
}

// ─── The honest claims statement (CONTRACT, not UI text) ────────────────────

/**
 * The exact claims text every export manifest and package README carries.
 * Worded to state BOTH halves: what the export IS (parametric humanoid from
 * the HTIR) and what it explicitly is NOT (a photorealistic scan, measured
 * surface geometry).
 */
export const EXPORT_CLAIMS =
  'Game/AR export honesty: the exported model is a parametric humanoid built from this TwinVersion\u2019s HTIR (skeleton convention, body proportions, palette). It is NOT a photorealistic scan and NOT measured surface geometry: mesh vertices are synthesized segment primitives, facial blendshapes are zero-delta placeholders, and absolute height defaults to a canonical value when the HTIR carries none. What is structural from the HTIR versus derived/estimated is recorded field-by-field in the export manifest.';

/** Contract check: a manifest claims statement must carry the verbatim text. */
export function claimsAreIntact(claims: unknown): boolean {
  return typeof claims === 'string' && claims === EXPORT_CLAIMS;
}

// ─── Typed refusal taxonomy ─────────────────────────────────────────────────

export type ExportRefusalCode =
  | 'validation_failed' // 400 — malformed input (ids, format, lodLevel, options)
  | 'geometry_unavailable'; // 422 — the TwinVersion carries no usable geometry (honest refusal)

export class ExportRefusal extends Error {
  readonly code: ExportRefusalCode;
  readonly details?: unknown;
  constructor(code: ExportRefusalCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ExportRefusal';
    this.code = code;
    this.details = details;
  }
}

export interface ExportHttpSpec {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

const REFUSAL_STATUS: Record<ExportRefusalCode, number> = {
  validation_failed: 400,
  geometry_unavailable: 422,
};

/** Translate an ExportRefusal into the standard error-envelope spec. */
export function exportHttpSpec(err: unknown): ExportHttpSpec | null {
  if (!(err instanceof ExportRefusal)) return null;
  return { status: REFUSAL_STATUS[err.code], code: err.code, message: err.message, details: err.details };
}

// ─── Export options + input contract ────────────────────────────────────────

export const EXPORT_FORMATS = ['glb', 'vrm'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_LOD_LEVELS = [0, 1, 2] as const;
export type ExportLodLevel = (typeof EXPORT_LOD_LEVELS)[number];

export const LOD_LEVEL_LABELS: Record<ExportLodLevel, string> = {
  0: 'high detail (split long segments)',
  1: 'medium detail (one box per bone)',
  2: 'low detail (merged limb chains; hands and feet omitted)',
};

export interface ValidatedExportInput {
  twinId: string;
  twinVersionId: string;
  format: ExportFormat;
  lodLevel: ExportLodLevel;
  includeFacialControls: boolean;
}

/** Validate the route body shape → ValidatedExportInput (throws validation_failed). */
export function validateExportInput(raw: {
  twinId?: unknown;
  twinVersionId?: unknown;
  format?: unknown;
  lodLevel?: unknown;
  includeFacialControls?: unknown;
}): ValidatedExportInput {
  const twinId = typeof raw.twinId === 'string' ? raw.twinId.trim() : '';
  const twinVersionId = typeof raw.twinVersionId === 'string' ? raw.twinVersionId.trim() : '';
  if (!twinId || !twinVersionId) {
    throw new ExportRefusal('validation_failed', 'twinId and twinVersionId are required');
  }
  const format = typeof raw.format === 'string' ? raw.format.trim().toLowerCase() : '';
  if (!(EXPORT_FORMATS as readonly string[]).includes(format)) {
    throw new ExportRefusal(
      'validation_failed',
      `format must be one of: ${EXPORT_FORMATS.join(', ')} (got ${JSON.stringify(raw.format ?? null)}) — refusing to guess an export format`,
    );
  }
  const lodRaw = raw.lodLevel === undefined || raw.lodLevel === null ? 0 : raw.lodLevel;
  if (typeof lodRaw !== 'number' || !Number.isInteger(lodRaw) || !(EXPORT_LOD_LEVELS as readonly number[]).includes(lodRaw)) {
    throw new ExportRefusal(
      'validation_failed',
      `lodLevel must be one of: ${EXPORT_LOD_LEVELS.join(', ')} (got ${JSON.stringify(raw.lodLevel ?? null)})`,
    );
  }
  const facial = raw.includeFacialControls === undefined || raw.includeFacialControls === null ? true : raw.includeFacialControls;
  if (typeof facial !== 'boolean') {
    throw new ExportRefusal('validation_failed', 'includeFacialControls must be a boolean');
  }
  return { twinId, twinVersionId, format: format as ExportFormat, lodLevel: lodRaw as ExportLodLevel, includeFacialControls: facial };
}

// ─── The HTIR the emitter consumes (defensive parse of TwinVersion.htir) ────

/** The only skeleton convention this emitter understands (fail-closed otherwise). */
export const SUPPORTED_SKELETON = 'you-generic-v1';

export interface HtirForExport {
  skeleton: string;
  measurements: Record<string, number>;
  heightEstimateCm: number | null;
  build: string | null;
  skinHex: string | null;
  blendshapeNames: string[];
  geometryConfidence: number | null;
  hairCoverage: string | null;
}

/**
 * Parse the raw TwinVersion HTIR into exactly the fields the emitter needs.
 * Returns null when the object is not HTIR-shaped at all (the caller turns
 * that into the honest geometry_unavailable refusal — never a guessed body).
 */
export function parseHtirForExport(raw: unknown): HtirForExport | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const geometry = rec.geometry;
  if (geometry === null || typeof geometry !== 'object' || Array.isArray(geometry)) return null;
  const geo = geometry as Record<string, unknown>;
  const skeleton = typeof geo.skeleton === 'string' ? geo.skeleton.trim() : '';
  const measurements: Record<string, number> = {};
  const rawMeasurements = geo.measurements;
  if (rawMeasurements !== null && typeof rawMeasurements === 'object' && !Array.isArray(rawMeasurements)) {
    for (const [key, value] of Object.entries(rawMeasurements as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) measurements[key] = value;
    }
  }
  const morphology = rec.morphology;
  const morph =
    morphology !== null && typeof morphology === 'object' && !Array.isArray(morphology)
      ? (morphology as Record<string, unknown>)
      : {};
  const heightEstimateCm =
    typeof morph.heightEstimateCm === 'number' && Number.isFinite(morph.heightEstimateCm) ? morph.heightEstimateCm : null;
  const build = typeof morph.build === 'string' && morph.build.trim() ? morph.build.trim() : null;
  const appearance = rec.appearance;
  const app =
    appearance !== null && typeof appearance === 'object' && !Array.isArray(appearance)
      ? (appearance as Record<string, unknown>)
      : {};
  const palette =
    app.palette !== null && typeof app.palette === 'object' && !Array.isArray(app.palette)
      ? (app.palette as Record<string, unknown>)
      : {};
  const skinHex = typeof palette.skin === 'string' && /^#?[0-9a-fA-F]{6}$/.test(palette.skin.trim())
    ? normalizeSkinHex(palette.skin.trim())
    : null;
  const hair =
    app.hair !== null && typeof app.hair === 'object' && !Array.isArray(app.hair)
      ? (app.hair as Record<string, unknown>)
      : {};
  const hairCoverage = typeof hair.coverage === 'string' ? hair.coverage : null;
  const articulation = rec.articulation;
  const art =
    articulation !== null && typeof articulation === 'object' && !Array.isArray(articulation)
      ? (articulation as Record<string, unknown>)
      : {};
  const blendshapeNames = Array.isArray(art.blendshapes)
    ? art.blendshapes.filter((b): b is string => typeof b === 'string' && b.trim().length > 0).map((b) => b.trim()).slice(0, 32)
    : [];
  const confidence = rec.confidence;
  const conf =
    confidence !== null && typeof confidence === 'object' && !Array.isArray(confidence)
      ? (confidence as Record<string, unknown>)
      : {};
  const byDomain =
    conf.byDomain !== null && typeof conf.byDomain === 'object' && !Array.isArray(conf.byDomain)
      ? (conf.byDomain as Record<string, unknown>)
      : {};
  const geometryConfidence =
    typeof byDomain.geometry === 'number' && Number.isFinite(byDomain.geometry) ? byDomain.geometry : null;
  return { skeleton, measurements, heightEstimateCm, build, skinHex, blendshapeNames, geometryConfidence, hairCoverage };
}

function normalizeSkinHex(hex: string): string {
  return hex.startsWith('#') ? hex.toLowerCase() : `#${hex.toLowerCase()}`;
}

/**
 * The usable-geometry gate (fail-closed). A TwinVersion is exportable only
 * when its HTIR carries the recognized skeleton convention AND at least one
 * finite body measurement to build proportions from — anything else is an
 * honest refusal, never a default body pretending to be this twin.
 */
export function checkGeometryUsable(htir: HtirForExport | null): { ok: true; htir: HtirForExport } | { ok: false; reason: string } {
  if (!htir) {
    return {
      ok: false,
      reason:
        'the TwinVersion carries no parseable HTIR document — there is no geometry to export. Refusing honestly (geometry_unavailable); never a default body pretending to be this twin.',
    };
  }
  if (htir.skeleton !== SUPPORTED_SKELETON) {
    return {
      ok: false,
      reason: `the TwinVersion skeleton convention is ${JSON.stringify(htir.skeleton)} but this exporter implements only "${SUPPORTED_SKELETON}" — refusing to guess a bone mapping for an unknown skeleton.`,
    };
  }
  const usable = Object.entries(htir.measurements).filter(([, v]) => Number.isFinite(v));
  if (usable.length === 0) {
    return {
      ok: false,
      reason:
        'the TwinVersion geometry carries no finite body measurements — there is no structural proportion to build this twin from. Refusing honestly (geometry_unavailable); never a default body pretending to be this twin.',
    };
  }
  return { ok: true, htir };
}

// ─── The canonical bone table (you-generic-v1) ──────────────────────────────

export interface BoneDef {
  /** You bone id === VRM-0.x humanoid bone name (the convention is shared). */
  id: string;
  /** Parent bone id (null = root). */
  parent: string | null;
  /** Unity Mecanim (HumanBodyBones) name. */
  unity: string;
  /** UE5 mannequin convention bone name (verify per project skeleton). */
  unreal: string;
  /** Canonical rest-pose fraction of height (x, y, z) — T-pose, meters × H. */
  canonical: [number, number, number];
}

/** Mirrored helper: left/right pairs emit both sides. */
export const BONES: BoneDef[] = [
  { id: 'hips', parent: null, unity: 'Hips', unreal: 'pelvis', canonical: [0, 0.52, 0] },
  { id: 'spine', parent: 'hips', unity: 'Spine', unreal: 'spine_01', canonical: [0, 0.6, 0] },
  { id: 'chest', parent: 'spine', unity: 'Chest', unreal: 'spine_02', canonical: [0, 0.72, 0] },
  { id: 'neck', parent: 'chest', unity: 'Neck', unreal: 'neck_01', canonical: [0, 0.86, 0] },
  { id: 'head', parent: 'neck', unity: 'Head', unreal: 'head', canonical: [0, 0.9, 0] },
  { id: 'leftShoulder', parent: 'chest', unity: 'LeftShoulder', unreal: 'clavicle_l', canonical: [-0.03, 0.84, 0] },
  { id: 'rightShoulder', parent: 'chest', unity: 'RightShoulder', unreal: 'clavicle_r', canonical: [0.03, 0.84, 0] },
  { id: 'leftUpperArm', parent: 'leftShoulder', unity: 'LeftUpperArm', unreal: 'upperarm_l', canonical: [-1, 0.84, 0] },
  { id: 'rightUpperArm', parent: 'rightShoulder', unity: 'RightUpperArm', unreal: 'upperarm_r', canonical: [1, 0.84, 0] },
  { id: 'leftLowerArm', parent: 'leftUpperArm', unity: 'LeftLowerArm', unreal: 'lowerarm_l', canonical: [-2, 0.84, 0] },
  { id: 'rightLowerArm', parent: 'rightUpperArm', unity: 'RightLowerArm', unreal: 'lowerarm_r', canonical: [2, 0.84, 0] },
  { id: 'leftHand', parent: 'leftLowerArm', unity: 'LeftHand', unreal: 'hand_l', canonical: [-3, 0.84, 0] },
  { id: 'rightHand', parent: 'rightLowerArm', unity: 'RightHand', unreal: 'hand_r', canonical: [3, 0.84, 0] },
  { id: 'leftUpperLeg', parent: 'hips', unity: 'LeftUpperLeg', unreal: 'thigh_l', canonical: [-0.05, 0.52, 0] },
  { id: 'rightUpperLeg', parent: 'hips', unity: 'RightUpperLeg', unreal: 'thigh_r', canonical: [0.05, 0.52, 0] },
  { id: 'leftLowerLeg', parent: 'leftUpperLeg', unity: 'LeftLowerLeg', unreal: 'calf_l', canonical: [-0.05, 0.28, 0] },
  { id: 'rightLowerLeg', parent: 'rightUpperLeg', unity: 'RightLowerLeg', unreal: 'calf_r', canonical: [0.05, 0.28, 0] },
  { id: 'leftFoot', parent: 'leftLowerLeg', unity: 'LeftFoot', unreal: 'foot_l', canonical: [-0.05, 0.05, 0] },
  { id: 'rightFoot', parent: 'rightLowerLeg', unity: 'RightFoot', unreal: 'foot_r', canonical: [0.05, 0.05, 0] },
];

export const BONE_COUNT = BONES.length;

// ─── Blendshape mapping (ARKit-style where it maps, honest unmapped else) ───

export interface BlendshapeMapping {
  htirName: string;
  /** ARKit blendshape names this HTIR blendshape maps to ([] when unmapped). */
  arkitNames: string[];
  /** VRM-0.x preset name when the match is exact (else a custom group ships). */
  vrmPreset: string | null;
  /** Whether the VRM preset match is exact (false → custom-name group, honest). */
  vrmPresetExact: boolean;
  /** mapped = a real correspondence exists (possibly partial — see note). */
  mapped: boolean;
  note: string;
}

const ARKIT_BLINK = ['eyeBlinkLeft', 'eyeBlinkRight'];
const ARKIT_SMILE = ['mouthSmileLeft', 'mouthSmileRight'];
const ARKIT_BROW = ['browInnerUp', 'browOuterLeft', 'browOuterRight'];

/** The deterministic HTIR-blendshape → engine mapping table (no guesses). */
export function mapBlendshapes(htirNames: string[]): BlendshapeMapping[] {
  return htirNames.map((name) => {
    switch (name) {
      case 'neutral':
        return {
          htirName: name,
          arkitNames: [],
          vrmPreset: 'Neutral',
          vrmPresetExact: true,
          mapped: true,
          note: 'the neutral base pose corresponds to all-zero ARKit blendshape weights — ARKit has no neutral shape because it IS the rest pose',
        };
      case 'blink':
        return {
          htirName: name,
          arkitNames: [...ARKIT_BLINK],
          vrmPreset: 'Blink',
          vrmPresetExact: true,
          mapped: true,
          note: 'the HTIR blink drives both ARKit eyes together; per-eye winks are not modeled in the HTIR articulation set',
        };
      case 'smile':
        return {
          htirName: name,
          arkitNames: [...ARKIT_SMILE],
          vrmPreset: null,
          vrmPresetExact: false,
          mapped: true,
          note: 'partial: the HTIR smile maps to the ARKit smile shapes; cheek/jaw co-articulation is not modeled. No exact VRM-0 preset exists (Joy is close but not identical) — shipped as a custom-name blendshape group',
        };
      case 'brow-raise':
        return {
          htirName: name,
          arkitNames: [...ARKIT_BROW],
          vrmPreset: null,
          vrmPresetExact: false,
          mapped: true,
          note: 'partial: the HTIR brow-raise maps to the ARKit brow shapes; asymmetric control is not modeled. No exact VRM-0 preset exists — shipped as a custom-name blendshape group',
        };
      default:
        return {
          htirName: name,
          arkitNames: [],
          vrmPreset: null,
          vrmPresetExact: false,
          mapped: false,
          note: `unmapped: no ARKit or VRM correspondence is known for the HTIR blendshape name "${name}" — no guess is made`,
        };
    }
  });
}

// ─── Deterministic body proportions (structural HTIR → derived defaults) ────

export interface BodyProportions {
  heightMeters: number;
  heightSource: 'htir' | 'derived-default';
  shoulderHalf: number;
  shoulderSource: 'htir' | 'derived-default';
  headLength: number;
  headSource: 'htir' | 'derived-default';
  thicknessFactor: number;
  thicknessSource: 'htir-build-descriptor' | 'derived-default' | 'derived-unmapped-build';
  buildDescriptor: string | null;
}

const DEFAULT_HEIGHT_M = 1.7;
const DEFAULT_SHOULDER_RATIO = 0.23;
const DEFAULT_HEAD_RATIO = 0.13;

const BUILD_THICKNESS: Record<string, number> = {
  slim: 0.85,
  average: 1.0,
  athletic: 1.05,
};

/**
 * Derive the emitter's body proportions from the HTIR. Every default used is
 * SOURCE-TAGGED so the manifest can state it honestly (structural verbatim
 * vs derived-default with the canonical value).
 */
export function deriveProportions(htir: HtirForExport): BodyProportions {
  const h = htir.heightEstimateCm;
  const heightMeters = h !== null && h >= 50 && h <= 250 ? h / 100 : DEFAULT_HEIGHT_M;
  const heightSource: BodyProportions['heightSource'] =
    h !== null && h >= 50 && h <= 250 ? 'htir' : 'derived-default';

  const shoulderRatio = htir.measurements.shoulderRatio;
  const shoulderHalf =
    typeof shoulderRatio === 'number' && Number.isFinite(shoulderRatio) && shoulderRatio > 0 && shoulderRatio < 1
      ? (shoulderRatio * heightMeters) / 2
      : (DEFAULT_SHOULDER_RATIO * heightMeters) / 2;
  const shoulderSource: BodyProportions['shoulderSource'] =
    typeof shoulderRatio === 'number' && Number.isFinite(shoulderRatio) && shoulderRatio > 0 && shoulderRatio < 1
      ? 'htir'
      : 'derived-default';

  const headRatio = htir.measurements.headRatio;
  const headLength =
    typeof headRatio === 'number' && Number.isFinite(headRatio) && headRatio > 0 && headRatio < 1
      ? headRatio * heightMeters
      : DEFAULT_HEAD_RATIO * heightMeters;
  const headSource: BodyProportions['headSource'] =
    typeof headRatio === 'number' && Number.isFinite(headRatio) && headRatio > 0 && headRatio < 1
      ? 'htir'
      : 'derived-default';

  const build = htir.build;
  const known = build !== null && Object.prototype.hasOwnProperty.call(BUILD_THICKNESS, build.toLowerCase());
  const thicknessFactor = known ? BUILD_THICKNESS[build.toLowerCase()] : 1.0;
  const thicknessSource: BodyProportions['thicknessSource'] = known
    ? 'htir-build-descriptor'
    : build !== null
      ? 'derived-unmapped-build'
      : 'derived-default';

  return {
    heightMeters,
    heightSource,
    shoulderHalf,
    shoulderSource,
    headLength,
    headSource,
    thicknessFactor,
    thicknessSource,
    buildDescriptor: build,
  };
}

// ─── The deterministic segment-mesh generator ───────────────────────────────

/**
 * A rigid-skinned axis-aligned box primitive. 24 vertices (4 per face, flat
 * normals), 36 indices (12 triangles), CCW winding from outside — the
 * standard flat-shaded box. Everything is plain arithmetic: deterministic.
 */
interface BoxPrimitive {
  boneIndex: number;
  positions: Float32Array; // 24 × 3
  normals: Float32Array; // 24 × 3
  joints: Uint8Array; // 24 × 4
  weights: Float32Array; // 24 × 4
  indices: Uint16Array; // 36
  /** true when this primitive carries the facial blendshape morph targets. */
  isHead: boolean;
}

interface BoxBounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

// (face corner offsets + per-face normal), in the order [+, −, +Y, −Y, +X, −X];
// each face's 4 corners are CCW when viewed from outside (cross-product
// verified: every face's triangles wind outward).
const BOX_FACES: Array<{ normal: [number, number, number]; corners: Array<[number, number, number]> }> = [
  { normal: [0, 0, 1], corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { normal: [0, 0, -1], corners: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
  { normal: [0, 1, 0], corners: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { normal: [0, -1, 0], corners: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  { normal: [1, 0, 0], corners: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { normal: [-1, 0, 0], corners: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
];

function emitBox(bounds: BoxBounds, boneIndex: number, isHead: boolean): BoxPrimitive {
  const hx = (bounds.maxX - bounds.minX) / 2;
  const hy = (bounds.maxY - bounds.minY) / 2;
  const hz = (bounds.maxZ - bounds.minZ) / 2;
  const cx = bounds.minX + hx;
  const cy = bounds.minY + hy;
  const cz = bounds.minZ + hz;
  const positions = new Float32Array(24 * 3);
  const normals = new Float32Array(24 * 3);
  const joints = new Uint8Array(24 * 4);
  const weights = new Float32Array(24 * 4);
  const indices = new Uint16Array(36);
  let v = 0;
  let t = 0;
  for (const face of BOX_FACES) {
    const base = v;
    for (const [ox, oy, oz] of face.corners) {
      positions[v * 3] = cx + ox * hx;
      positions[v * 3 + 1] = cy + oy * hy;
      positions[v * 3 + 2] = cz + oz * hz;
      normals[v * 3] = face.normal[0];
      normals[v * 3 + 1] = face.normal[1];
      normals[v * 3 + 2] = face.normal[2];
      joints[v * 4] = boneIndex;
      weights[v * 4] = 1;
      v += 1;
    }
    // two triangles per face, CCW from outside
    indices[t++] = base;
    indices[t++] = base + 1;
    indices[t++] = base + 2;
    indices[t++] = base;
    indices[t++] = base + 2;
    indices[t++] = base + 3;
  }
  return { boneIndex, positions, normals, joints, weights, indices, isHead };
}

/** Bone rest-pose global positions in meters (deterministic from proportions). */
export interface EmittedBone {
  def: BoneDef;
  index: number;
  global: [number, number, number];
}

function buildBones(p: BodyProportions): EmittedBone[] {
  const H = p.heightMeters;
  const shoulderHalf = p.shoulderHalf;
  const upperArmLen = 0.16 * H;
  const lowerArmLen = 0.16 * H;
  return BONES.map((def, index) => {
    const [cx, cy, cz] = def.canonical;
    let global: [number, number, number];
    switch (def.id) {
      case 'leftUpperArm':
        global = [-shoulderHalf, cy * H, cz * H];
        break;
      case 'rightUpperArm':
        global = [shoulderHalf, cy * H, cz * H];
        break;
      case 'leftLowerArm':
        global = [-(shoulderHalf + upperArmLen), cy * H, cz * H];
        break;
      case 'rightLowerArm':
        global = [shoulderHalf + upperArmLen, cy * H, cz * H];
        break;
      case 'leftHand':
        global = [-(shoulderHalf + upperArmLen + lowerArmLen), cy * H, cz * H];
        break;
      case 'rightHand':
        global = [shoulderHalf + upperArmLen + lowerArmLen, cy * H, cz * H];
        break;
      default:
        global = [cx * H, cy * H, cz * H];
    }
    return { def, index, global };
  });
}

interface SegmentSpec {
  boneIndex: number;
  /** Span start = the bone's global position. */
  from: [number, number, number];
  /** Span end (child bone position or canonical extension). */
  to: [number, number, number];
  /** Cross-section radii (x, y, z) — the non-dominant pair is used. */
  radii: [number, number, number];
  isHead: boolean;
  /** Foot boxes get a custom vertical extent (down to near the ground). */
  foot: boolean;
}

function boneGlobal(bones: EmittedBone[], id: string): [number, number, number] {
  const b = bones.find((x) => x.def.id === id);
  if (!b) throw new Error(`internal: bone ${id} missing from the canonical table`);
  return b.global;
}

function buildSegments(bones: EmittedBone[], p: BodyProportions): SegmentSpec[] {
  const H = p.heightMeters;
  const T = p.thicknessFactor;
  const out: SegmentSpec[] = [];
  const seg = (
    boneId: string,
    to: [number, number, number],
    radii: [number, number, number],
    opts?: { isHead?: boolean; foot?: boolean },
  ) => {
    const bone = bones.find((x) => x.def.id === boneId);
    if (!bone) throw new Error(`internal: bone ${boneId} missing`);
    out.push({
      boneIndex: bone.index,
      from: bone.global,
      to,
      radii: [radii[0] * T, radii[1] * T, radii[2] * T],
      isHead: opts?.isHead === true,
      foot: opts?.foot === true,
    });
  };
  const outward = (side: 'left' | 'right'): [number, number, number] => [
    (side === 'left' ? -1 : 1) * 0.09 * H,
    0,
    0,
  ];

  // torso chain (hips → spine → chest → neck)
  seg('hips', boneGlobal(bones, 'spine'), [0.085 * H, 0, 0.055 * H]);
  seg('spine', boneGlobal(bones, 'chest'), [0.085 * H, 0, 0.055 * H]);
  seg('chest', boneGlobal(bones, 'neck'), [0.09 * H, 0, 0.055 * H]);
  // neck + head
  seg('neck', boneGlobal(bones, 'head'), [0.028 * H, 0, 0.028 * H]);
  seg(
    'head',
    [0, boneGlobal(bones, 'head')[1] + p.headLength, 0],
    [0.35 * p.headLength, 0, 0.4 * p.headLength],
    { isHead: true },
  );
  // clavicles + arms + hands (both sides)
  for (const side of ['left', 'right'] as const) {
    seg(`${side}Shoulder`, boneGlobal(bones, `${side}UpperArm`), [0, 0.028 * H, 0.028 * H]);
    seg(`${side}UpperArm`, boneGlobal(bones, `${side}LowerArm`), [0, 0.032 * H, 0.032 * H]);
    seg(`${side}LowerArm`, boneGlobal(bones, `${side}Hand`), [0, 0.032 * H, 0.032 * H]);
    const hand = boneGlobal(bones, `${side}Hand`);
    seg(
      `${side}Hand`,
      [hand[0] + outward(side)[0], hand[1], hand[2]],
      [0, 0.024 * H, 0.024 * H],
    );
    // legs + feet
    seg(`${side}UpperLeg`, boneGlobal(bones, `${side}LowerLeg`), [0.048 * H, 0, 0.048 * H]);
    seg(`${side}LowerLeg`, boneGlobal(bones, `${side}Foot`), [0.04 * H, 0, 0.04 * H]);
    const foot = boneGlobal(bones, `${side}Foot`);
    seg(`${side}Foot`, [foot[0], foot[1], foot[2] + 0.1 * H], [0.038 * H, 0, 0.038 * H], { foot: true });
  }
  return out;
}

/** Segment bounds from a span + radii (dominant axis spans exactly; foot special-cased). */
function segmentBounds(s: SegmentSpec): BoxBounds {
  const dx = Math.abs(s.to[0] - s.from[0]);
  const dy = Math.abs(s.to[1] - s.from[1]);
  const dz = Math.abs(s.to[2] - s.from[2]);
  const mid: [number, number, number] = [
    (s.from[0] + s.to[0]) / 2,
    (s.from[1] + s.to[1]) / 2,
    (s.from[2] + s.to[2]) / 2,
  ];
  if (s.foot) {
    // the foot box extends down toward the ground and forward to the toe
    return {
      minX: mid[0] - s.radii[0],
      maxX: mid[0] + s.radii[0],
      minY: s.from[1] - s.radii[1] * 1.25,
      maxY: s.from[1] + 0.012,
      minZ: s.from[2] - 0.02,
      maxZ: s.to[2],
    };
  }
  if (dx >= dy && dx >= dz) {
    return {
      minX: Math.min(s.from[0], s.to[0]),
      maxX: Math.max(s.from[0], s.to[0]),
      minY: mid[1] - s.radii[1],
      maxY: mid[1] + s.radii[1],
      minZ: mid[2] - s.radii[2],
      maxZ: mid[2] + s.radii[2],
    };
  }
  if (dy >= dz) {
    return {
      minX: mid[0] - s.radii[0],
      maxX: mid[0] + s.radii[0],
      minY: Math.min(s.from[1], s.to[1]),
      maxY: Math.max(s.from[1], s.to[1]),
      minZ: mid[2] - s.radii[2],
      maxZ: mid[2] + s.radii[2],
    };
  }
  return {
    minX: mid[0] - s.radii[0],
    maxX: mid[0] + s.radii[0],
    minY: mid[1] - s.radii[1],
    maxY: mid[1] + s.radii[1],
    minZ: Math.min(s.from[2], s.to[2]),
    maxZ: Math.max(s.from[2], s.to[2]),
  };
}

// ─── LOD construction (REAL decimation, counts from real output) ────────────

export interface LodMesh {
  level: ExportLodLevel;
  primitives: BoxPrimitive[];
  /** Measured from the emitted arrays — never claimed without emission. */
  triangles: number;
  vertices: number;
}

const SPLIT_SEGMENTS = new Set([
  'hips',
  'spine',
  'chest',
  'leftUpperArm',
  'rightUpperArm',
  'leftLowerArm',
  'rightLowerArm',
  'leftUpperLeg',
  'rightUpperLeg',
  'leftLowerLeg',
  'rightLowerLeg',
]);

function splitBounds(b: BoxBounds): [BoxBounds, BoxBounds] {
  const midX = (b.minX + b.maxX) / 2;
  const midY = (b.minY + b.maxY) / 2;
  const midZ = (b.minZ + b.maxZ) / 2;
  const dx = b.maxX - b.minX;
  const dy = b.maxY - b.minY;
  const dz = b.maxZ - b.minZ;
  if (dx >= dy && dx >= dz) {
    return [
      { ...b, maxX: midX },
      { ...b, minX: midX },
    ];
  }
  if (dy >= dz) {
    return [
      { ...b, maxY: midY },
      { ...b, minY: midY },
    ];
  }
  return [
    { ...b, maxZ: midZ },
    { ...b, minZ: midZ },
  ];
}

function buildLodMeshes(
  segments: SegmentSpec[],
  bones: EmittedBone[],
  p: BodyProportions,
  includeFacialControls: boolean,
): LodMesh[] {
  // LOD0 — split long segments into two stacked boxes
  const lod0: BoxPrimitive[] = [];
  for (const s of segments) {
    const bone = bones[s.boneIndex];
    const bounds = segmentBounds(s);
    if (SPLIT_SEGMENTS.has(bone.def.id)) {
      const [a, b] = splitBounds(bounds);
      lod0.push(emitBox(a, s.boneIndex, false));
      lod0.push(emitBox(b, s.boneIndex, false));
    } else {
      lod0.push(emitBox(bounds, s.boneIndex, s.isHead && includeFacialControls));
    }
  }
  // LOD1 — exactly one box per bone segment
  const lod1: BoxPrimitive[] = segments.map((s) =>
    emitBox(segmentBounds(s), s.boneIndex, s.isHead && includeFacialControls),
  );
  // LOD2 — merged limb chains (hands/feet omitted, honestly recorded)
  const H = p.heightMeters;
  const T = p.thicknessFactor;
  const lod2: BoxPrimitive[] = [];
  const hips = boneGlobal(bones, 'hips');
  const neck = boneGlobal(bones, 'neck');
  const spineIndex = bones.find((b) => b.def.id === 'spine')!.index;
  lod2.push(
    emitBox(
      {
        minX: -0.09 * H * T,
        maxX: 0.09 * H * T,
        minY: hips[1],
        maxY: neck[1],
        minZ: -0.055 * H * T,
        maxZ: 0.055 * H * T,
      },
      spineIndex,
      false,
    ),
  );
  const neckIndex = bones.find((b) => b.def.id === 'neck')!.index;
  const head = boneGlobal(bones, 'head');
  lod2.push(
    emitBox(
      {
        minX: -0.028 * H * T,
        maxX: 0.028 * H * T,
        minY: neck[1],
        maxY: head[1],
        minZ: -0.028 * H * T,
        maxZ: 0.028 * H * T,
      },
      neckIndex,
      false,
    ),
  );
  const headIndex = bones.find((b) => b.def.id === 'head')!.index;
  lod2.push(
    emitBox(
      {
        minX: -0.35 * p.headLength,
        maxX: 0.35 * p.headLength,
        minY: head[1],
        maxY: head[1] + p.headLength,
        minZ: -0.4 * p.headLength,
        maxZ: 0.4 * p.headLength,
      },
      headIndex,
      includeFacialControls,
    ),
  );
  for (const side of ['left', 'right'] as const) {
    const clavicle = boneGlobal(bones, `${side}Shoulder`);
    const hand = boneGlobal(bones, `${side}Hand`);
    const upperArmIndex = bones.find((b) => b.def.id === `${side}UpperArm`)!.index;
    lod2.push(
      emitBox(
        {
          minX: Math.min(clavicle[0], hand[0] + 0.09 * H * (side === 'left' ? -1 : 1)),
          maxX: Math.max(clavicle[0], hand[0] + 0.09 * H * (side === 'left' ? -1 : 1)),
          minY: clavicle[1] - 0.032 * H * T,
          maxY: clavicle[1] + 0.032 * H * T,
          minZ: -0.032 * H * T,
          maxZ: 0.032 * H * T,
        },
        upperArmIndex,
        false,
      ),
    );
    const upperLeg = boneGlobal(bones, `${side}UpperLeg`);
    const foot = boneGlobal(bones, `${side}Foot`);
    const lowerLegIndex = bones.find((b) => b.def.id === `${side}LowerLeg`)!.index;
    lod2.push(
      emitBox(
        {
          minX: upperLeg[0] - 0.045 * H * T,
          maxX: upperLeg[0] + 0.045 * H * T,
          minY: foot[1],
          maxY: upperLeg[1],
          minZ: -0.045 * H * T,
          maxZ: 0.045 * H * T,
        },
        lowerLegIndex,
        false,
      ),
    );
  }
  return [lod0, lod1, lod2].map((primitives, i) => ({
    level: i as ExportLodLevel,
    primitives,
    triangles: primitives.reduce((sum, pr) => sum + pr.indices.length / 3, 0),
    vertices: primitives.length * 24,
  }));
}

// ─── The GLB/glTF 2.0 binary emitter ────────────────────────────────────────

const GLB_MAGIC = 0x46546c67; // 'glTF'
const GLB_JSON_CHUNK_TYPE = 0x4e4f534a; // 'JSON'
const GLB_BIN_CHUNK_TYPE = 0x004e4942; // 'BIN\0'

/** sRGB hex → linear baseColorFactor (the glTF color space), deterministic. */
export function skinHexToLinearFactor(hex: string): [number, number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return [0.8, 0.72, 0.66, 1];
  const linear = (byteHex: string): number => {
    const c = parseInt(byteHex, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return [linear(m[1]), linear(m[2]), linear(m[3]), 1];
}

interface BufferViewRef {
  byteOffset: number;
  byteLength: number;
}

class BufferBuilder {
  private parts: Uint8Array[] = [];
  private length = 0;

  add(data: Uint8Array): BufferViewRef {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad > 0) {
      this.parts.push(new Uint8Array(pad));
      this.length += pad;
    }
    const view = { byteOffset: this.length, byteLength: data.length };
    this.parts.push(data);
    this.length += data.length;
    return view;
  }

  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  get byteLength(): number {
    return this.length;
  }
}

interface AccessorRef {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}

const COMPONENT_FLOAT = 5126;
const COMPONENT_UNSIGNED_BYTE = 5121;
const COMPONENT_UNSIGNED_SHORT = 5123;

interface GltfPrimitive {
  attributes: { POSITION: number; NORMAL: number; JOINTS_0: number; WEIGHTS_0: number };
  indices: number;
  targets?: Array<{ POSITION: number }>;
  material: number;
}

interface EmittedGltf {
  json: Record<string, unknown>;
  bin: Uint8Array;
  lods: Array<{ level: ExportLodLevel; meshIndex: number; triangles: number; primitives: number; vertices: number }>;
  boneNodeIndices: number[];
  blendshapeCount: number;
}

function accessorMin(positions: Float32Array): number[] {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i] < minX) minX = positions[i];
    if (positions[i + 1] < minY) minY = positions[i + 1];
    if (positions[i + 2] < minZ) minZ = positions[i + 2];
  }
  return [minX, minY, minZ];
}

function accessorMax(positions: Float32Array): number[] {
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i] > maxX) maxX = positions[i];
    if (positions[i + 1] > maxY) maxY = positions[i + 1];
    if (positions[i + 2] > maxZ) maxZ = positions[i + 2];
  }
  return [maxX, maxY, maxZ];
}

/**
 * Assemble the full glTF 2.0 document + binary buffer from the emitted LOD
 * meshes and bones. Deterministic: fixed node/accessor construction order,
 * fixed JSON key order, 4-byte alignment, space-padded JSON chunk.
 */
function assembleGltf(
  lods: LodMesh[],
  bones: EmittedBone[],
  options: { format: ExportFormat; lodLevel: ExportLodLevel; includeFacialControls: boolean },
  p: BodyProportions,
  htir: HtirForExport,
): EmittedGltf {
  const builder = new BufferBuilder();
  const bufferViews: BufferViewRef[] = [];
  const accessors: AccessorRef[] = [];

  const addBufferView = (data: Uint8Array): number => {
    bufferViews.push(builder.add(data));
    return bufferViews.length - 1;
  };
  const addAccessor = (ref: AccessorRef): number => {
    accessors.push(ref);
    return accessors.length - 1;
  };

  // ── nodes: 19 bones (fixed canonical order) then 3 LOD mesh nodes ──
  // glTF hierarchy law: parents carry children arrays (a `parent` property
  // is NOT part of the node schema) — built after the bone pass below.
  const nodes: Array<Record<string, unknown>> = [];
  const boneNodeIndices: number[] = [];
  for (const bone of bones) {
    const parentBone = bone.def.parent === null ? null : bones.find((b) => b.def.id === bone.def.parent)!;
    const translation = parentBone
      ? [
          round6(bone.global[0] - parentBone.global[0]),
          round6(bone.global[1] - parentBone.global[1]),
          round6(bone.global[2] - parentBone.global[2]),
        ]
      : [round6(bone.global[0]), round6(bone.global[1]), round6(bone.global[2])];
    boneNodeIndices.push(nodes.length);
    nodes.push({ name: bone.def.id, translation });
  }
  // parent → children (parents always precede children in the canonical order)
  for (const bone of bones) {
    if (bone.def.parent === null) continue;
    const parentNodeIdx = boneNodeIndices[bones.find((b) => b.def.id === bone.def.parent)!.index];
    const parentRec = nodes[parentNodeIdx] as { children?: number[] };
    if (!Array.isArray(parentRec.children)) parentRec.children = [];
    parentRec.children.push(boneNodeIndices[bone.index]);
  }
  const rootNodeIndex = boneNodeIndices[0]; // hips

  // ── skin: one shared skeleton, inverse bind matrices from global rest pose ──
  const ibmData = new Float32Array(bones.length * 16);
  for (const bone of bones) {
    const at = bone.index * 16;
    // column-major mat4: identity rotation/scale, translation = −global position
    ibmData[at] = 1;
    ibmData[at + 5] = 1;
    ibmData[at + 10] = 1;
    ibmData[at + 15] = 1;
    ibmData[at + 12] = -bone.global[0];
    ibmData[at + 13] = -bone.global[1];
    ibmData[at + 14] = -bone.global[2];
  }
  const ibmView = addBufferView(new Uint8Array(ibmData.buffer, ibmData.byteOffset, ibmData.byteLength));
  const ibmAccessor = addAccessor({
    bufferView: ibmView,
    componentType: COMPONENT_FLOAT,
    count: bones.length,
    type: 'MAT4',
  });

  // ── meshes: one per LOD, one primitive per box, morph targets on the head ──
  const meshes: Array<Record<string, unknown>> = [];
  const lodStats: EmittedGltf['lods'] = [];
  const blendshapeNames = options.includeFacialControls ? htir.blendshapeNames : [];
  let blendshapeCount = 0;
  for (const lod of lods) {
    const primitives: GltfPrimitive[] = [];
    for (const box of lod.primitives) {
      const posView = addBufferView(
        new Uint8Array(box.positions.buffer, box.positions.byteOffset, box.positions.byteLength),
      );
      const posAccessor = addAccessor({
        bufferView: posView,
        componentType: COMPONENT_FLOAT,
        count: 24,
        type: 'VEC3',
        min: accessorMin(box.positions),
        max: accessorMax(box.positions),
      });
      const normView = addBufferView(
        new Uint8Array(box.normals.buffer, box.normals.byteOffset, box.normals.byteLength),
      );
      const normAccessor = addAccessor({ bufferView: normView, componentType: COMPONENT_FLOAT, count: 24, type: 'VEC3' });
      const jointsView = addBufferView(
        new Uint8Array(box.joints.buffer, box.joints.byteOffset, box.joints.byteLength),
      );
      const jointsAccessor = addAccessor({ bufferView: jointsView, componentType: COMPONENT_UNSIGNED_BYTE, count: 24, type: 'VEC4' });
      const weightsView = addBufferView(
        new Uint8Array(box.weights.buffer, box.weights.byteOffset, box.weights.byteLength),
      );
      const weightsAccessor = addAccessor({ bufferView: weightsView, componentType: COMPONENT_FLOAT, count: 24, type: 'VEC4' });
      const idxView = addBufferView(new Uint8Array(box.indices.buffer, box.indices.byteOffset, box.indices.byteLength));
      const idxAccessor = addAccessor({ bufferView: idxView, componentType: COMPONENT_UNSIGNED_SHORT, count: 36, type: 'SCALAR' });
      const primitive: GltfPrimitive = {
        attributes: { POSITION: posAccessor, NORMAL: normAccessor, JOINTS_0: jointsAccessor, WEIGHTS_0: weightsAccessor },
        indices: idxAccessor,
        material: 0,
      };
      if (box.isHead && blendshapeNames.length > 0) {
        // zero-delta morph target placeholders — honest: no per-vertex deltas
        // exist in the HTIR; engines drive them through retargeting
        const zeros = new Float32Array(24 * 3);
        const targets: Array<{ POSITION: number }> = [];
        for (let i = 0; i < blendshapeNames.length; i += 1) {
          const zeroView = addBufferView(new Uint8Array(zeros.buffer, zeros.byteOffset, zeros.byteLength));
          targets.push({
            POSITION: addAccessor({
              bufferView: zeroView,
              componentType: COMPONENT_FLOAT,
              count: 24,
              type: 'VEC3',
              min: [0, 0, 0],
              max: [0, 0, 0],
            }),
          });
        }
        primitive.targets = targets;
        blendshapeCount = targets.length;
      }
      primitives.push(primitive);
    }
    const meshIndex = meshes.length;
    const mesh: Record<string, unknown> = { name: `LOD${lod.level}`, primitives };
    if (blendshapeNames.length > 0) {
      mesh.extras = { targetNames: [...blendshapeNames] };
    }
    meshes.push(mesh);
    lodStats.push({
      level: lod.level,
      meshIndex,
      triangles: lod.triangles,
      primitives: lod.primitives.length,
      vertices: lod.vertices,
    });
  }

  // ── LOD mesh nodes (scene carries all three; engines pick by name) ──
  const lodNodeIndices: number[] = [];
  for (const lod of lods) {
    lodNodeIndices.push(nodes.length);
    nodes.push({ name: `LOD${lod.level}-mesh`, mesh: lodStats.find((s) => s.level === lod.level)!.meshIndex, skin: 0 });
  }

  // ── material: base color from the HTIR palette skin hex (or the honest default) ──
  const baseColor = htir.skinHex !== null ? skinHexToLinearFactor(htir.skinHex) : [0.8, 0.72, 0.66, 1];
  const materials = [
    {
      name: htir.skinHex !== null ? 'YOU-skin' : 'YOU-skin-default',
      pbrMetallicRoughness: {
        baseColorFactor: baseColor.map((c) => round6(c)),
        metallicFactor: 0,
        roughnessFactor: 1,
      },
      doubleSided: true,
    },
  ];

  const bin = builder.toUint8Array();

  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'you-glb-1 (YOU game-export adapter)' },
    scene: 0,
    // the skeleton root (hips) is in the scene so every joint is reachable;
    // the three LOD mesh nodes ship side by side — engines pick by name
    scenes: [{ name: 'YOU-twin-export', nodes: [rootNodeIndex, ...lodNodeIndices] }],
    nodes,
    skins: [
      {
        name: 'you-generic-v1',
        joints: [...boneNodeIndices],
        skeleton: rootNodeIndex,
        inverseBindMatrices: ibmAccessor,
      },
    ],
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
  };

  if (options.format === 'vrm') {
    json.extensionsUsed = ['VRM'];
    json.extensions = { VRM: buildVrmExtension(lodStats, boneNodeIndices, blendshapeNames, options.lodLevel) };
  }

  return { json, bin, lods: lodStats, boneNodeIndices, blendshapeCount };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// ─── VRM 0.x extension (on the same emitter) ────────────────────────────────

function buildVrmExtension(
  lodStats: EmittedGltf['lods'],
  boneNodeIndices: number[],
  blendshapeNames: string[],
  primaryLod: ExportLodLevel,
): Record<string, unknown> {
  const primaryMeshIndex = lodStats.find((s) => s.level === primaryLod)!.meshIndex;
  const mappings = mapBlendshapes(blendshapeNames);
  const groups = mappings.map((m, targetIndex) => ({
    name: m.htirName,
    presetName: m.vrmPresetExact && m.vrmPreset !== null ? m.vrmPreset : 'Unknown',
    binds: [{ mesh: primaryMeshIndex, index: targetIndex }],
    materialValues: [],
  }));
  const headNode = boneNodeIndices[4]; // canonical table position of 'head'
  const humanoidBones = BONES.map((bone, i) => ({ bone: bone.id, node: boneNodeIndices[i] }));
  const meshAnnotations = lodStats.map((s) => ({ mesh: s.meshIndex, firstPersonFlag: 'Both' }));
  return {
    exporterVersion: 'you-glb-1',
    specVersion: '0.0',
    meta: {
      title: 'YOU Twin Export',
      author: 'YOU platform (game-export-1 adapter, on behalf of the twin subject)',
      contactInformation: '',
      reference: '',
      licenseName: 'Other',
      allowedUserName: 'ExplicitlyLicensedPersonals',
      violentUsageName: 'Disallowed',
      sexualUsageName: 'Disallowed',
      commercialUssageName: 'Personal',
      characterPermission: 'OnlyAuthor',
    },
    humanoid: { humanoid: humanoidBones },
    blendShapeMaster: { blendShapeGroups: groups },
    firstPerson: {
      firstPersonBone: headNode,
      firstPersonBoneLevel: 0,
      firstPersonOffset: { x: 0, y: 0, z: 0 },
      meshAnnotations,
    },
  };
}

// ─── GLB container writer ───────────────────────────────────────────────────

/** Write the binary GLB container: 12-byte header + JSON chunk + BIN chunk. */
export function writeGlb(json: Record<string, unknown>, bin: Uint8Array): Uint8Array {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const jsonChunkLength = jsonBytes.length + jsonPad;
  const binChunkLength = bin.length + binPad;
  const totalLength = 12 + 8 + jsonChunkLength + 8 + binChunkLength;
  const out = Buffer.alloc(totalLength);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(totalLength, 8);
  out.writeUInt32LE(jsonChunkLength, 12);
  out.writeUInt32LE(GLB_JSON_CHUNK_TYPE, 16);
  jsonBytes.copy(out, 20);
  for (let i = 0; i < jsonPad; i += 1) out[20 + jsonBytes.length + i] = 0x20; // space padding
  out.writeUInt32LE(binChunkLength, 20 + jsonChunkLength);
  out.writeUInt32LE(GLB_BIN_CHUNK_TYPE, 24 + jsonChunkLength);
  out.set(bin, 28 + jsonChunkLength);
  return new Uint8Array(out);
}

// ─── The honest manifest (structural vs derived — THE CONTRACT) ─────────────

export interface ManifestEntry {
  field: string;
  value: unknown;
  basis: string;
}

export interface LodStat {
  level: ExportLodLevel;
  label: string;
  triangles: number;
  primitives: number;
  vertices: number;
  note: string;
}

export interface ExportManifest {
  adapterId: string;
  adapterVersion: string;
  format: ExportFormat;
  lodLevel: ExportLodLevel;
  includeFacialControls: boolean;
  determinism: string;
  skeleton: string;
  boneCount: number;
  /** Fields that came from the TwinVersion's HTIR VERBATIM. */
  structural: ManifestEntry[];
  /** Fields that were synthesized/estimated — each with its basis. */
  derived: ManifestEntry[];
  /** REAL emitted counts per LOD (measured from the arrays in the GLB). */
  lods: LodStat[];
  facialControls: {
    included: boolean;
    htirBlendshapes: string[];
    placeholderDeltas: boolean;
    note: string;
  };
  claims: string;
}

function buildManifest(input: {
  format: ExportFormat;
  lodLevel: ExportLodLevel;
  includeFacialControls: boolean;
  htir: HtirForExport;
  proportions: BodyProportions;
  lods: EmittedGltf['lods'];
  boneCount: number;
}): ExportManifest {
  const { htir, p } = { htir: input.htir, p: input.proportions };
  const structural: ManifestEntry[] = [
    { field: 'geometry.skeleton', value: htir.skeleton, basis: 'HTIR TwinVersion verbatim — the node hierarchy + skin skeleton are built from this convention' },
  ];
  for (const [key, value] of Object.entries(htir.measurements)) {
    structural.push({
      field: `geometry.measurements.${key}`,
      value,
      basis: 'HTIR TwinVersion verbatim — this proportion parameterizes the emitted mesh',
    });
  }
  if (input.htir.heightEstimateCm !== null) {
    structural.push({
      field: 'morphology.heightEstimateCm',
      value: input.htir.heightEstimateCm,
      basis: 'HTIR TwinVersion verbatim — the model height in meters',
    });
  }
  if (htir.skinHex !== null) {
    structural.push({
      field: 'appearance.palette.skin',
      value: htir.skinHex,
      basis: 'HTIR TwinVersion verbatim — the material base color (converted sRGB→linear)',
    });
  }
  if (htir.blendshapeNames.length > 0) {
    structural.push({
      field: 'articulation.blendshapes',
      value: htir.blendshapeNames,
      basis: 'HTIR TwinVersion verbatim — facial blendshape placeholders are emitted ONLY for these names',
    });
  }
  if (htir.geometryConfidence !== null) {
    structural.push({
      field: 'confidence.byDomain.geometry',
      value: htir.geometryConfidence,
      basis: 'HTIR TwinVersion verbatim — the reconstruction confidence behind this geometry',
    });
  }

  const derived: ManifestEntry[] = [
    {
      field: 'mesh.segmentGeometry',
      value: `${input.lods.reduce((s, l) => s + l.triangles, 0)} triangles across 3 LODs`,
      basis: 'parametric axis-aligned segment boxes scaled from the HTIR proportions — NOT scanned surface geometry and NOT a photorealistic representation of the subject',
    },
    {
      field: 'mesh.absoluteHeight',
      value: round6(p.heightMeters),
      basis:
        p.heightSource === 'htir'
          ? 'HTIR heightEstimateCm converted to meters'
          : `the HTIR carries no absolute height (single photos cannot honestly establish one) — canonical ${DEFAULT_HEIGHT_M}m default applied`,
    },
    {
      field: 'mesh.shoulderHalf',
      value: round6(p.shoulderHalf),
      basis:
        p.shoulderSource === 'htir'
          ? 'HTIR shoulderRatio × height / 2'
          : `the HTIR carries no shoulderRatio — canonical ${DEFAULT_SHOULDER_RATIO} ratio default applied`,
    },
    {
      field: 'mesh.headLength',
      value: round6(p.headLength),
      basis:
        p.headSource === 'htir'
          ? 'HTIR headRatio × height'
          : `the HTIR carries no headRatio — canonical ${DEFAULT_HEAD_RATIO} ratio default applied`,
    },
    {
      field: 'mesh.segmentThickness',
      value: round6(p.thicknessFactor),
      basis:
        p.thicknessSource === 'htir-build-descriptor'
          ? `the HTIR build descriptor "${p.buildDescriptor}" mapped to a thickness factor — the descriptor is structural, the numeric mapping is an estimate`
          : p.thicknessSource === 'derived-unmapped-build'
            ? `the HTIR build descriptor "${p.buildDescriptor}" has no characterized thickness mapping — neutral 1.0 factor applied`
            : 'the HTIR carries no build descriptor — neutral 1.0 thickness factor applied',
    },
    {
      field: 'mesh.canonicalProportions',
      value: 'bone offsets and segment radii are canonical humanoid proportions × height',
      basis: 'platform defaults — only the ratio-measured proportions above come from the HTIR',
    },
    {
      field: 'facialControls.morphTargetDeltas',
      value: 'zero-delta placeholders',
      basis: 'no per-vertex blendshape deltas exist in the HTIR — engines drive the named targets through retargeting, never fabricated deltas',
    },
    {
      field: 'material.baseColor',
      value: htir.skinHex !== null ? htir.skinHex : 'default skin tone',
      basis:
        htir.skinHex !== null
          ? 'HTIR palette skin hex converted to linear (the conversion is estimated from a descriptor hex, itself an approximation)'
          : 'the HTIR carries no palette skin hex — neutral default base color applied',
    },
  ];

  const lods: LodStat[] = input.lods.map((l) => ({
    level: l.level,
    label: LOD_LEVEL_LABELS[l.level],
    triangles: l.triangles,
    primitives: l.primitives,
    vertices: l.vertices,
    note:
      l.level === 2
        ? 'merged limb chains — hands and feet are OMITTED at this level (a real decimation decision, recorded here rather than silently dropped)'
        : 'counts measured from the emitted arrays that ship in the GLB',
  }));

  return {
    adapterId: GAME_EXPORT_ADAPTER.adapterId,
    adapterVersion: GAME_EXPORT_ADAPTER.version,
    format: input.format,
    lodLevel: input.lodLevel,
    includeFacialControls: input.includeFacialControls,
    determinism: 'byte-identical for an identical TwinVersion + options (sha256-stable; no clocks, no randomness)',
    skeleton: htir.skeleton,
    boneCount: input.boneCount,
    structural,
    derived,
    lods,
    facialControls: {
      included: input.includeFacialControls,
      htirBlendshapes: htir.blendshapeNames,
      placeholderDeltas: true,
      note: input.includeFacialControls
        ? 'placeholders emitted only for the HTIR articulation set; every target carries zero deltas'
        : 'omitted by export option (includeFacialControls=false) — no blendshape groups or morph targets emitted',
    },
    claims: EXPORT_CLAIMS,
  };
}

// ─── The retargeting mapping table (machine-readable surface) ───────────────

export interface BoneMappingEntry {
  youBone: string;
  gltfNode: number;
  nodeName: string;
  vrmHumanoidBone: string;
  unityMecanim: string;
  unrealMannequin: string;
  mapped: boolean;
  source: string;
  note: string;
}

export interface ExportMappingTable {
  adapterId: string;
  adapterVersion: string;
  format: ExportFormat;
  skeleton: string;
  boneCount: number;
  bones: BoneMappingEntry[];
  blendshapes: Array<BlendshapeMapping & { emitted: boolean }>;
  lodLevels: Array<{ level: ExportLodLevel; meshIndex: number; meshName: string; triangles: number; primitives: number }>;
  facialControls: { included: boolean; placeholderDeltas: boolean; note: string };
  engineNotes: {
    unity: string;
    unreal: string;
    arkit: string;
  };
}

function buildMappingTable(input: {
  format: ExportFormat;
  boneNodeIndices: number[];
  lods: EmittedGltf['lods'];
  htir: HtirForExport;
  includeFacialControls: boolean;
}): ExportMappingTable {
  const bones: BoneMappingEntry[] = BONES.map((bone, i) => ({
    youBone: bone.id,
    gltfNode: input.boneNodeIndices[i],
    nodeName: bone.id,
    vrmHumanoidBone: bone.id,
    unityMecanim: bone.unity,
    unrealMannequin: bone.unreal,
    mapped: true,
    source: 'structural — the you-generic-v1 convention defines these bones; engine names are industry conventions',
    note:
      bone.id === 'chest'
        ? 'partial on Unreal: UE5 mannequins split the chest into spine_02/spine_03 — this skeleton has a single chest bone mapped to spine_02; verify against your project skeleton'
        : 'verify the Unreal name against your project skeleton (conventions vary across rigs)',
  }));
  const blendshapeMappings = mapBlendshapes(input.htir.blendshapeNames);
  return {
    adapterId: GAME_EXPORT_ADAPTER.adapterId,
    adapterVersion: GAME_EXPORT_ADAPTER.version,
    format: input.format,
    skeleton: SUPPORTED_SKELETON,
    boneCount: BONES.length,
    bones,
    blendshapes: blendshapeMappings.map((m) => ({ ...m, emitted: input.includeFacialControls })),
    lodLevels: input.lods.map((l) => ({
      level: l.level,
      meshIndex: l.meshIndex,
      meshName: `LOD${l.level}`,
      triangles: l.triangles,
      primitives: l.primitives,
    })),
    facialControls: {
      included: input.includeFacialControls,
      placeholderDeltas: true,
      note: input.includeFacialControls
        ? 'zero-delta morph targets named by the HTIR articulation set — drive them through engine retargeting'
        : 'omitted by export option (includeFacialControls=false)',
    },
    engineNotes: {
      unity:
        'import the GLB with a glTF importer (e.g. glTFast) and map bones via the unityMecanim column into a Mecanim Humanoid rig; this package provides NO Unity prefab, NO animator controller and NO scripts',
      unreal:
        'import the GLB through the glTF importer and retarget via the unrealMannequin column (UE5 mannequin convention — verify per project); this package provides NO Unreal plugin, NO blueprint and NO animation assets',
      arkit:
        'live-link ARKit facial animation through the arkitNames column of blendshapes; unmapped HTIR names carry no correspondence and are never guessed',
    },
  };
}

// ─── The engine package manifest (honest Unity/Unreal surface) ──────────────

export interface PackageFileRef {
  role: 'model' | 'retargeting-mapping' | 'export-manifest';
  artifactId: string;
  storageKey: string;
  contentHash: string;
  bytes: number;
  mime: string;
}

export interface ExportPackageManifest {
  adapterId: string;
  adapterVersion: string;
  packageVersion: string;
  format: ExportFormat;
  files: PackageFileRef[];
  engineIntegration: {
    unity: { provided: string[]; notProvided: string[] };
    unreal: { provided: string[]; notProvided: string[] };
  };
  readme: string;
}

/**
 * Build the honest engine package manifest: exactly which files ship, and a
 * README that states what is and is NOT included. No fake engine plugins.
 */
export function buildPackageManifest(input: {
  format: ExportFormat;
  files: PackageFileRef[];
}): ExportPackageManifest {
  const { format } = input;
  return {
    adapterId: GAME_EXPORT_ADAPTER.adapterId,
    adapterVersion: GAME_EXPORT_ADAPTER.version,
    packageVersion: '1',
    format,
    files: input.files.map((f) => ({ ...f })),
    engineIntegration: {
      unity: {
        provided: ['the model file (GLB)', 'the bone/blendshape retargeting mapping table (JSON)', 'the structural-vs-derived export manifest (JSON)'],
        notProvided: ['a Unity prefab or scene', 'a Mecanim animator controller', 'any C# scripts or editor tooling'],
      },
      unreal: {
        provided: ['the model file (GLB)', 'the bone/blendshape retargeting mapping table (JSON)', 'the structural-vs-derived export manifest (JSON)'],
        notProvided: ['an Unreal plugin or module', 'blueprints or animation assets', 'any engine-side code'],
      },
    },
    readme: [
      'YOU game/AR export package (game-export-1).',
      `This package contains exactly three files: the model (${format === 'vrm' ? 'a VRM 0.x avatar in a glTF-binary container — rename the file extension to .vrm for VRM-aware importers' : 'GLB — glTF 2.0 binary'}), the machine-readable retargeting mapping table, and the export manifest.`,
      'IS included: a deterministic, spec-valid glTF-binary model with the you-generic-v1 humanoid skeleton (19 bones, one shared skin), three emitted LOD meshes with triangle/primitive counts measured from the real output, and — when the HTIR articulation set supports them — named facial blendshape placeholder targets.',
      'is NOT included: any Unity prefab/controller/scripts, any Unreal plugin/blueprints/animations, engine-ready rigs beyond the bone mapping table, textures or UV coordinates (the material is a flat base color), and per-vertex blendshape deltas (the targets are zero-delta placeholders by contract).',
      EXPORT_CLAIMS,
    ].join(' '),
  };
}

// ─── The pipeline fold (pure; the executor composes it with real seams) ─────

export interface ExportPipelineResult {
  format: ExportFormat;
  /** The GLB (or VRM-in-GLB) binary bytes — byte-deterministic. */
  bytes: Uint8Array;
  manifest: ExportManifest;
  mappingTable: ExportMappingTable;
}

/**
 * Contract assertion: a composed export result is only valid when the honest
 * split is present (≥1 structural AND ≥1 derived entry), the claims statement
 * is verbatim, every LOD count is real and strictly decimating, the GLB magic
 * is intact, and the mapping table is complete + honest (mapped entries carry
 * engine names; unmapped entries carry the explicit note).
 */
export function assertExportSuccess(result: ExportPipelineResult): ExportPipelineResult {
  if (result.bytes.length < 20) {
    throw new ExportRefusal('validation_failed', 'export contract violation: the emitted GLB is too short to be a valid container');
  }
  const magic = Buffer.from(result.bytes.slice(0, 4)).readUInt32LE(0);
  if (magic !== GLB_MAGIC) {
    throw new ExportRefusal('validation_failed', 'export contract violation: the emitted bytes are not a GLB container (bad magic)');
  }
  const m = result.manifest;
  if (!claimsAreIntact(m.claims)) {
    throw new ExportRefusal(
      'validation_failed',
      'export contract violation: the manifest claims statement is missing or altered — an export may never ship without the verbatim honest-claims text',
    );
  }
  if (m.structural.length === 0 || m.derived.length === 0) {
    throw new ExportRefusal(
      'validation_failed',
      'export contract violation: the structural-vs-derived split is part of the contract — both halves must be present and non-empty',
    );
  }
  if (m.lods.length !== 3) {
    throw new ExportRefusal('validation_failed', 'export contract violation: exactly three LOD levels must be emitted');
  }
  for (let i = 0; i < m.lods.length; i += 1) {
    const lod = m.lods[i];
    if (lod.level !== i) {
      throw new ExportRefusal('validation_failed', `export contract violation: LOD levels must be ordered 0,1,2 (got ${lod.level} at ${i})`);
    }
    if (!(lod.triangles > 0) || !(lod.primitives > 0) || !(lod.vertices > 0)) {
      throw new ExportRefusal('validation_failed', `export contract violation: LOD ${lod.level} carries non-positive counts — counts are only recorded when geometry is actually emitted`);
    }
    if (i > 0 && lod.triangles >= m.lods[i - 1].triangles) {
      throw new ExportRefusal(
        'validation_failed',
        `export contract violation: LOD ${lod.level} does not decimate (triangles ${lod.triangles} ≥ previous ${m.lods[i - 1].triangles})`,
      );
    }
  }
  const t = result.mappingTable;
  if (t.bones.length !== BONES.length) {
    throw new ExportRefusal('validation_failed', 'export contract violation: the mapping table must cover the full bone set');
  }
  for (const b of t.bones) {
    if (b.mapped && !b.vrmHumanoidBone && !b.unityMecanim && !b.unrealMannequin) {
      throw new ExportRefusal('validation_failed', `export contract violation: mapped bone "${b.youBone}" carries no engine names`);
    }
  }
  for (const b of t.blendshapes) {
    if (b.mapped && b.arkitNames.length === 0 && b.htirName !== 'neutral') {
      throw new ExportRefusal(
        'validation_failed',
        `export contract violation: mapped blendshape "${b.htirName}" (other than neutral) carries no ARKit names`,
      );
    }
    if (!b.mapped && !/unmapped/i.test(b.note)) {
      throw new ExportRefusal('validation_failed', `export contract violation: unmapped blendshape "${b.htirName}" must carry the explicit unmapped note`);
    }
  }
  return result;
}

/**
 * Run the pure export pipeline: parse + usable-geometry gate (fail-closed) →
 * derive proportions (source-tagged) → emit the three LOD meshes → assemble
 * the GLB/VRM → build the honest manifest + mapping table → assert the
 * contract. Fully local and deterministic — no provider, no network.
 */
export function runExportPipeline(
  rawHtir: unknown,
  options: ValidatedExportInput,
): ExportPipelineResult {
  const parsed = parseHtirForExport(rawHtir);
  const gate = checkGeometryUsable(parsed);
  if (!gate.ok) {
    throw new ExportRefusal('geometry_unavailable', gate.reason);
  }
  const htir = gate.htir;
  const proportions = deriveProportions(htir);
  const bones = buildBones(proportions);
  const segments = buildSegments(bones, proportions);
  const lods = buildLodMeshes(segments, bones, proportions, options.includeFacialControls);
  const emitted = assembleGltf(lods, bones, options, proportions, htir);
  const bytes = writeGlb(emitted.json, emitted.bin);
  const manifest = buildManifest({
    format: options.format,
    lodLevel: options.lodLevel,
    includeFacialControls: options.includeFacialControls,
    htir,
    proportions,
    lods: emitted.lods,
    boneCount: bones.length,
  });
  const mappingTable = buildMappingTable({
    format: options.format,
    boneNodeIndices: emitted.boneNodeIndices,
    lods: emitted.lods,
    htir,
    includeFacialControls: options.includeFacialControls,
  });
  return assertExportSuccess({ format: options.format, bytes, manifest, mappingTable });
}

// ─── Route decision folds (pure; the routes compose them with real rows) ────

export interface ExportRouteGrant {
  id: string;
  scopes: string[];
  revokedAt: Date | null;
  expiresAt: Date;
}

export type ExportCreateDecision =
  | { kind: 'error'; status: number; code: string; message: string }
  | { kind: 'replay'; jobId: string; exportJobId: string }
  | { kind: 'proceed'; input: ValidatedExportInput; consentGrantId: string };

/**
 * The POST /api/v1/exports decision fold — the exact order the route applies:
 * validate → twin tenant-scope (404) → twin version scope (404) → consent
 * (server-enforced reconstruct scope, 403) → idempotent replay (the ORIGINAL
 * ids, never a second row) → proceed. Pure: the route passes loaded rows in.
 */
export function decideCreateExport(args: {
  body: {
    twinId?: unknown;
    twinVersionId?: unknown;
    format?: unknown;
    lodLevel?: unknown;
    includeFacialControls?: unknown;
  };
  twin: { id: string; tenantId: string; subjectId: string } | null;
  twinVersion: { id: string; twinId: string } | null;
  /** The caller's tenant. */
  tenantId: string;
  idempotencyKey?: string | undefined;
  /** A durable job already carrying the idempotency key (if any). */
  existingJob: { id: string; kind: string; input: Record<string, unknown> } | null;
  activeGrants: ExportRouteGrant[];
  now?: Date;
}): ExportCreateDecision {
  let input: ValidatedExportInput;
  try {
    input = validateExportInput(args.body);
  } catch (err) {
    if (err instanceof ExportRefusal) {
      return { kind: 'error', status: REFUSAL_STATUS[err.code], code: err.code, message: err.message };
    }
    throw err;
  }
  if (!args.twin || args.twin.tenantId !== args.tenantId) {
    return { kind: 'error', status: 404, code: 'not_found', message: `twin "${input.twinId}" not found` };
  }
  if (!args.twinVersion || args.twinVersion.twinId !== args.twin.id) {
    return {
      kind: 'error',
      status: 404,
      code: 'not_found',
      message: `twin version "${input.twinVersionId}" not found for this twin`,
    };
  }
  // server-enforced consent — an export reconstructs the twin's geometry
  // into a new representation: the reconstruct scope law (fail-closed)
  const now = args.now ?? new Date();
  const covering = args.activeGrants.find(
    (g) => g.revokedAt === null && g.expiresAt.getTime() > now.getTime() && g.scopes.includes('reconstruct'),
  );
  if (!covering) {
    return {
      kind: 'error',
      status: 403,
      code: 'consent_required',
      message: `no active consent grant with scope "reconstruct" for subject ${args.twin.subjectId} — grant or renew consent first`,
    };
  }
  // idempotent replay: the ORIGINAL ids — never a second ExportJob row
  if (args.idempotencyKey && args.existingJob) {
    const expectedKind = exportJobKindFor(input.format);
    if (args.existingJob.kind === expectedKind) {
      const existingInput = args.existingJob.input ?? {};
      const exportJobId = typeof existingInput.exportJobId === 'string' ? existingInput.exportJobId : '';
      if (exportJobId) {
        return { kind: 'replay', jobId: args.existingJob.id, exportJobId };
      }
    }
  }
  return { kind: 'proceed', input, consentGrantId: covering.id };
}

/**
 * The GET /api/v1/exports/:id decision fold — the routes' scoping law
 * exactly: findFirst({ where: { id, tenantId } }); a miss (unknown id OR
 * another tenant's row) is an honest not_found, never a leak.
 */
export function decideGetExport(
  row: { id: string; tenantId: string } | null,
  id: string,
  tenantId: string,
): { status: 200; row: { id: string; tenantId: string } } | { status: 404; code: string; message: string } {
  if (!row || row.tenantId !== tenantId) {
    return { status: 404, code: 'not_found', message: `export job "${id}" not found` };
  }
  return { status: 200, row };
}
