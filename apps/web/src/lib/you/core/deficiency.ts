// ═══════════════════════════════════════════════════════════════════════════
// YOU core — quality deficiency aggregation (Worker B lane, P6.B4).
//
// PURE MODULE — no db, no '@/…' aliases, type-only imports: node:test
// imports it directly (same law as lab/f1-recon.ts and client/degraded.ts).
//
// Aggregates the REAL persisted quality state of a twin into a structured,
// honest DeficiencyReport: per-capability rows (face | hair | hands |
// silhouette | motion | speech) with state `ok | deficient | unknown`,
// severity, citable sources, and a ready-to-POST targeted-evidence remedy.
//
// HONESTY LAWS (mirrored from the C-lane pipeline and B3 flow):
// - UNKNOWN IS UNKNOWN: a capability with no signal either way is `unknown` —
//   never coerced into `ok`, and no quality number is ever invented.
// - DEFICIENT ONLY WITH A SOURCE: every `deficient` row cites at least one
//   real, persisted signal (an HTIR deficiency entry from the reconstruction,
//   a skipped required F1 step, a failed byte-level checkpoint, an unusable
//   analyzed asset, a waived checklist item).
// - DECLARED ≠ OBSERVED: rows carry a `basis` tier — `observed` signals come
//   from machine analysis (reconstruction coverage / analyzed assets);
//   `declared` signals only prove bytes exist with declared regions.
// - NUMBERS ARE QUOTED, NEVER DERIVED: checkpoint scores and confidence
//   values appear verbatim inside source details.
// ═══════════════════════════════════════════════════════════════════════════
import type {
  CaptureChecklistItem, CaptureRegion, EvidenceQuality, F1ProtocolState,
  HtirConfidence, HtirConfidenceDeficiency,
} from '../contracts';
// NOTE: explicit .ts extension (tsconfig has allowImportingTsExtensions) so
// this PURE module stays importable by node:test type-stripping too — the
// same import law the contract suites rely on.
import { F1_PROTOCOL_STEPS } from '../lab/f1-recon.ts';

// ─── Report contract (lane-owned view of the aggregation) ────────────────────

export const DEFICIENCY_REPORT_VERSION = 'deficiency-report/v1';
export const DEFICIENCY_DELTA_VERSION = 'deficiency-delta/v1';

/** Capability rows the map always shows (fixed catalog, honest order). */
export const DEFICIENCY_CAPABILITIES = ['face', 'hair', 'hands', 'silhouette', 'motion', 'speech'] as const;
export type DeficiencyCapability = (typeof DEFICIENCY_CAPABILITIES)[number];

export type DeficiencyState = 'ok' | 'deficient' | 'unknown';
export type DeficiencySeverity = 'low' | 'medium' | 'high';
/** Signal basis tier — observed beats declared; declared is never observed. */
export type DeficiencyBasis = 'observed' | 'declared' | 'none';

export type DeficiencySignalKind =
  | 'htir-deficiency'   // reconstruction (twin.compile / f1.reconstruct) listed it deficient
  | 'htir-coverage'     // reconstruction machine-observed the region (no deficiency entry)
  | 'capture-step'      // guided F1 step state (done / skipped-with-reason)
  | 'capture-checkpoint'// guided F1 per-step byte-level checkpoint
  | 'asset-quality'     // capture.quality job analysis of an evidence asset
  | 'checklist-item';   // legacy checklist item state

/** One citable source signal — the drill-down unit of the map.
 * `superseded: true` marks a REAL negative record that newer evidence has
 * since resolved (kept for honest drill-down; it does not affect the state). */
export interface DeficiencySource {
  kind: DeficiencySignalKind;
  signal: 'negative' | 'positive';
  superseded?: boolean;
  captureSessionId?: string;
  stepId?: string;
  assetId?: string;
  region?: string;
  twinVersionId?: string;
  detail: string;
}

/** Ready-to-POST payload for POST /api/v1/evidence-requests (the remedy). */
export interface DeficiencyRemedy {
  reason: string;
  capability: string;
  instructions: string;
  expectedSignal: string;
  scope: string;
  twinVersionId: string | null;
}

export interface DeficiencyRow {
  capability: DeficiencyCapability;
  label: string;
  state: DeficiencyState;
  severity: DeficiencySeverity | null;
  basis: DeficiencyBasis;
  reason: string;
  sources: DeficiencySource[];
  remedy: DeficiencyRemedy | null;
}

export interface DeficiencyReport {
  version: typeof DEFICIENCY_REPORT_VERSION;
  twinId: string;
  twinVersionId: string | null;
  twinVersionNumber: number | null;
  generatedAt: string;
  capabilities: DeficiencyRow[];
  summary: { ok: number; deficient: number; unknown: number; total: number };
  /** Honest report-level notes (no captures, in-progress sessions, …). */
  disclosures: string[];
}

// ─── Version delta (compare two reports) ─────────────────────────────────────

export type DeficiencyDeltaKind = 'improved' | 'regressed' | 'unchanged' | 'unknown';

export interface DeficiencyDeltaRow {
  capability: DeficiencyCapability;
  label: string;
  delta: DeficiencyDeltaKind;
  from: { state: DeficiencyState; severity: DeficiencySeverity | null };
  to: { state: DeficiencyState; severity: DeficiencySeverity | null };
  reason: string;
}

export interface DeficiencyDelta {
  version: typeof DEFICIENCY_DELTA_VERSION;
  baseline: { twinVersionId: string | null; twinVersionNumber: number | null };
  comparison: { twinVersionId: string | null; twinVersionNumber: number | null };
  rows: DeficiencyDeltaRow[];
  summary: { improved: number; regressed: number; unchanged: number; unknown: number };
}

// ─── Inputs (already-fetched persisted state; the route does the DB work) ────

export interface DeficiencyAssetInput {
  id: string;
  regions: CaptureRegion[];
  /** capture.quality job analysis result (null = uploaded but not analyzed). */
  quality: EvidenceQuality | null;
}

/** Mirror of the persisted f1-checkpoint-summary/v1 (all fields optional —
 * the per-step reports in `protocol` are the primary per-step truth; this
 * summary is used for disclosures only). */
export interface DeficiencyCheckpointSummaryInput {
  stepsChecked?: number;
  stepsPassed?: number;
  stepsDone?: number;
  averageStepScore?: number | null;
  manifestVerified?: boolean;
}

export interface DeficiencyCaptureInput {
  id: string;
  status: string; // pending | uploading | analyzing | complete | failed
  createdAt: string;
  completedAt: string | null;
  error?: string | null;
  /** guided F1 protocol (null on legacy sessions). */
  protocol: F1ProtocolState | null;
  checkpoints: DeficiencyCheckpointSummaryInput | null;
  checklist: CaptureChecklistItem[];
  assets: DeficiencyAssetInput[];
}

export interface DeficiencyVersionInput {
  id: string;
  version: number;
  createdAt: string;
  /** HtirConfidence from the reconstruction (null when never reconstructed). */
  confidenceSummary: HtirConfidence | null;
}

export interface DeficiencyInput {
  twinId: string;
  version: DeficiencyVersionInput | null;
  captures: DeficiencyCaptureInput[];
}

// ─── Capability catalog (regions/steps per capability) ───────────────────────

interface CapabilitySpec {
  capability: DeficiencyCapability;
  label: string;
  regions: CaptureRegion[];
  steps: string[]; // F1 guided-protocol step ids (single source: F1_PROTOCOL_STEPS)
  required: boolean; // F1 law: steps 1–7 required, step 8 (speech) optional
  remedy: { instructions: string; expectedSignal: string };
}

const CAPABILITY_SPECS: CapabilitySpec[] = [
  {
    capability: 'face',
    label: 'Face',
    regions: ['face.front', 'face.profile', 'face.hairline', 'teeth'],
    steps: ['face-front', 'face-turn'],
    required: true,
    remedy: {
      instructions: 'Capture the face again: one front-facing photo (neutral expression, eyes open, even light, plain background) and one photo per side profile with the jawline and nose silhouette clearly visible.',
      expectedSignal: 'Sharp frontal and profile views — the full face oval, hairline and profile contour clearly delimited against a plain background.',
    },
  },
  {
    capability: 'hair',
    label: 'Hair',
    regions: ['hair.back', 'face.hairline'],
    steps: ['turn-around'],
    required: true,
    remedy: {
      instructions: 'Capture the hair from behind: pause with your back to the camera so the back of the head, hairline and volume are visible; a side view helps. Plain background, even light.',
      expectedSignal: 'Hair coverage, color and silhouette visible from back and side views, including the back hairline.',
    },
  },
  {
    capability: 'hands',
    label: 'Hands',
    regions: ['hands'],
    steps: ['hands'],
    required: true,
    remedy: {
      instructions: 'Show both hands: palms open toward the camera with fingers relaxed and slightly spread, then the backs of both hands. Fill the frame without cropping fingers. Two photos total.',
      expectedSignal: 'Resolvable finger geometry and knuckle detail from both sides of both hands.',
    },
  },
  {
    capability: 'silhouette',
    label: 'Silhouette',
    regions: ['silhouette.front', 'silhouette.side'],
    steps: ['upper-body', 'full-body', 'turn-around'],
    required: true,
    remedy: {
      instructions: 'Capture full-body silhouettes against a plain background: one front-facing photo head-to-feet and one full side view, arms slightly away from the body, fitted clothing.',
      expectedSignal: 'A clean full-body outline for anthropometric measurement from front and side views.',
    },
  },
  {
    capability: 'motion',
    label: 'Motion',
    regions: ['walking'],
    steps: ['walking'],
    required: true,
    remedy: {
      instructions: 'Record a short walking clip (about 3–5 seconds): walk naturally toward and/or across the camera, full body in frame, normal pace and arm swing.',
      expectedSignal: 'A full gait cycle — stride, posture and arm swing visible.',
    },
  },
  {
    capability: 'speech',
    label: 'Speech',
    regions: ['speech'],
    steps: ['speech'],
    required: false, // F1 law: step 8 is optional (skip freely with a reason)
    remedy: {
      instructions: 'Optionally record about 20 seconds of natural speech on camera or as audio — this enables voice and mouth-motion profiles. Skip freely with a reason if you prefer not to.',
      expectedSignal: 'Clean audio with pitch, pace and articulation characteristics.',
    },
  },
];

/**
 * Region → severity, MIRRORING the C-lane REGION_IMPORTANCE in
 * adapters/vlm-recon.ts (not exported there; this lane quotes the same values
 * so capture-level gaps rank identically to reconstruction-level ones).
 */
const REGION_SEVERITY: Record<string, DeficiencySeverity> = {
  'face.front': 'high',
  'face.profile': 'high',
  'hands': 'high',
  'hair.back': 'high',
  'silhouette.side': 'high',
  'face.hairline': 'medium',
  'silhouette.front': 'medium',
  'teeth': 'medium',
  'walking': 'low',
  'speech': 'low',
  'custom': 'low',
};

const SEVERITY_RANK: Record<DeficiencySeverity, number> = { low: 0, medium: 1, high: 2 };

/** Step id → canonical regions (from F1_PROTOCOL_STEPS — single source). */
const STEP_REGIONS: ReadonlyMap<string, readonly CaptureRegion[]> = new Map(
  F1_PROTOCOL_STEPS.map((s) => [s.id, s.regions as readonly CaptureRegion[]]),
);

const REMEDY_SCOPE = 'single additional capture for the stated deficiency; derived outputs only';

// ─── Internal signal collection ──────────────────────────────────────────────

/**
 * One collected signal. `negative` is the STATE-AFFECTING flag (only an
 * unsuperseded deficiency record sets it); `source.signal` keeps the RECORD's
 * polarity for display — a superseded gap is still a negative record, shown
 * in the drill-down with its superseded marker, but it cannot flip the row.
 */
interface Signal {
  negative: boolean;
  severity: DeficiencySeverity | null; // null for positive signals
  source: DeficiencySource;
}

const TERMINAL_SESSION = ['complete', 'failed'];

function regionSeverity(regions: readonly string[]): DeficiencySeverity {
  let rank = -1;
  let worst: DeficiencySeverity = 'low';
  for (const r of regions) {
    const s = REGION_SEVERITY[r] ?? 'low';
    if (SEVERITY_RANK[s] > rank) { rank = SEVERITY_RANK[s]; worst = s; }
  }
  return worst;
}

function fmt(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : 'null';
}

/** HTIR (reconstruction) signals for one capability from the version. */
function htirSignals(
  spec: CapabilitySpec,
  version: DeficiencyVersionInput,
): Signal[] {
  const conf = version.confidenceSummary;
  if (!conf) return [];
  const out: Signal[] = [];
  const listed = new Set<string>();

  for (const d of conf.deficiencies ?? []) {
    const cap = d?.capability;
    if (typeof cap !== 'string') continue;
    const matchesRegion = spec.regions.includes(cap as CaptureRegion);
    const matchesCapability = cap === spec.capability || cap.startsWith(`${spec.capability}.`);
    if (!matchesRegion && !matchesCapability) continue;
    listed.add(cap);
    const severity: DeficiencySeverity =
      d.severity === 'high' || d.severity === 'medium' || d.severity === 'low' ? d.severity : 'medium';
    out.push({
      negative: true,
      severity,
      source: {
        kind: 'htir-deficiency',
        signal: 'negative',
        region: matchesRegion ? cap : undefined,
        twinVersionId: version.id,
        detail: `reconstruction v${version.version} lists "${cap}" as deficient (${severity}): ${d.reason ?? 'no reason recorded'}`,
      },
    });
  }

  // Complement coverage: the C-lane aggregation (aggregateHtirDraft — shared
  // by twin.compile and f1.reconstruct) emits ONE deficiency entry per
  // canonical region NOT observed by the analysis. A capability region absent
  // from the list was therefore machine-observed — a real, citable positive.
  for (const r of spec.regions) {
    if (!listed.has(r)) {
      out.push({
        negative: false,
        severity: null,
        source: {
          kind: 'htir-coverage',
          signal: 'positive',
          region: r,
          twinVersionId: version.id,
          detail: `reconstruction v${version.version} machine-observed region "${r}" (no deficiency entry for it)`,
        },
      });
    }
  }
  return out;
}

/**
 * Guided F1 protocol signals with CROSS-SESSION slot resolution.
 *
 * Evidence is immutable: a step done with a passing checkpoint in ANY session
 * keeps proving the capability has valid evidence — an older (or parallel)
 * session's skip or failed checkpoint for the same step cannot un-capture it.
 * Resolution per step (across all sessions):
 *   done(+checkpoint passed) anywhere → POSITIVE (older gaps disclosed as
 *   negative-flagged sources — history is never dropped);
 *   else failed checkpoint → NEGATIVE (latest cited first);
 *   else skipped-required → NEGATIVE;
 *   else neutral (pending / optional-skip — never a positive).
 */
function guidedStepSignals(
  spec: CapabilitySpec,
  captures: DeficiencyCaptureInput[],
): { signals: Signal[]; notes: string[] } {
  const signals: Signal[] = [];
  const notes: string[] = [];

  for (const stepId of spec.steps) {
    const stepRegions = (STEP_REGIONS.get(stepId) ?? spec.regions).filter((r) => spec.regions.includes(r));
    const severity = regionSeverity(stepRegions.length > 0 ? stepRegions : spec.regions);

    // records for this step, deterministic order (createdAt, sessionId)
    const records = captures
      .map((c) => ({ capture: c, step: (c.protocol?.steps ?? []).find((s) => s && s.id === stepId) }))
      .filter((r): r is { capture: DeficiencyCaptureInput; step: NonNullable<typeof r.step> } => !!r.step)
      .sort((x, y) => (x.capture.createdAt < y.capture.createdAt ? -1 : x.capture.createdAt > y.capture.createdAt ? 1 : x.capture.id < y.capture.id ? -1 : 1));
    if (records.length === 0) continue;

    const dones = records.filter((r) => r.step.state === 'done' && r.step.checkpoint?.passed !== false);
    const faileds = records.filter((r) => r.step.checkpoint?.passed === false);
    const skippedRequired = records.filter((r) => r.step.state === 'skipped' && spec.required && r.step.required !== false);
    const optionalSkips = records.filter((r) => r.step.state === 'skipped' && (r.step.required === false || !spec.required));

    const resolved: Signal[] = [];
    for (const r of [...dones].reverse()) { // newest done cited first
      const cp = r.step.checkpoint;
      resolved.push({
        negative: false,
        severity: null,
        source: {
          kind: 'capture-step',
          signal: 'positive',
          captureSessionId: r.capture.id,
          stepId,
          ...(r.step.assetId ? { assetId: r.step.assetId } : {}),
          detail: cp && cp.passed === true
            ? `step "${stepId}" done — byte-level checkpoint passed (score ${fmt(cp.score)}; region coverage ${cp.checks?.requiredRegionsCovered ?? 'unknown'})`
            : `step "${stepId}" done — no checkpoint report persisted (declared evidence only; quality not verified)`,
        },
      });
    }
    for (const r of [...faileds].reverse()) {
      const cp = r.step.checkpoint;
      resolved.push({
        negative: true,
        severity,
        source: {
          kind: 'capture-checkpoint',
          signal: 'negative',
          captureSessionId: r.capture.id,
          stepId,
          ...(r.step.assetId ? { assetId: r.step.assetId } : {}),
          detail: `checkpoint FAILED for step "${stepId}" (score ${fmt(cp?.score)}${r.step.state !== 'done' ? `; step remains ${r.step.state}` : ''})${(cp?.issues ?? []).length > 0 ? ` — ${(cp?.issues ?? []).join('; ')}` : ''}`,
        },
      });
    }
    for (const r of [...skippedRequired].reverse()) {
      resolved.push({
        negative: true,
        severity,
        source: {
          kind: 'capture-step',
          signal: 'negative',
          captureSessionId: r.capture.id,
          stepId,
          detail: `required step "${stepId}" skipped${r.step.skipReason ? ` — ${r.step.skipReason}` : ' (no reason recorded)'}: no evidence for regions [${stepRegions.join(', ')}]`,
        },
      });
    }

    if (dones.length > 0) {
      // evidence EXISTS and passed: the positives resolve the slot's state;
      // stale gaps stay as SUPERSEDED sources (history disclosed, never
      // state-affecting — an old skip cannot un-capture newer evidence)
      signals.push(...resolved.filter((s) => !s.negative));
      for (const s of resolved.filter((x) => x.negative)) {
        signals.push({ ...s, negative: false, source: { ...s.source, superseded: true } });
      }
    } else if (faileds.length > 0 || skippedRequired.length > 0) {
      signals.push(...resolved.filter((s) => s.negative));
    } else if (optionalSkips.length > 0) {
      const r = optionalSkips[optionalSkips.length - 1];
      notes.push(`optional step "${stepId}" skipped${r.step.skipReason ? ` (${r.step.skipReason})` : ''} in session ${r.capture.id}`);
    } else {
      const r = records[records.length - 1];
      notes.push(`step "${stepId}" not terminal (${r.step.state}) in session ${r.capture.id}`);
    }
  }
  return { signals, notes };
}

/**
 * Legacy checklist signals with cross-session slot resolution: provided in
 * ANY session → positive; otherwise waived → negative (low — deliberate,
 * disclosed); otherwise pending → neutral (never a positive).
 */
function checklistSignals(spec: CapabilitySpec, captures: DeficiencyCaptureInput[]): Signal[] {
  const signals: Signal[] = [];
  const provided: Signal[] = [];
  const waived: Signal[] = [];

  for (const capture of [...captures].sort(
    (a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1),
  )) {
    for (const item of capture.checklist ?? []) {
      if (!item) continue;
      const matches = item.capability === spec.capability
        || spec.regions.includes(item.region as CaptureRegion)
        || (typeof item.capability === 'string' && item.capability.startsWith(`${spec.capability}.`));
      if (!matches) continue;
      if (item.status === 'provided') {
        provided.push({
          negative: false,
          severity: null,
          source: {
            kind: 'checklist-item',
            signal: 'positive',
            captureSessionId: capture.id,
            detail: `checklist item "${item.item || item.region}" provided (region ${item.region})`,
          },
        });
      } else if (item.status === 'waived') {
        // a real, persisted record that evidence was deliberately not captured
        waived.push({
          negative: true,
          severity: 'low',
          source: {
            kind: 'checklist-item',
            signal: 'negative',
            captureSessionId: capture.id,
            detail: `checklist item "${item.item || item.region}" waived (region ${item.region}) — deliberately not captured in this session`,
          },
        });
      }
      // 'pending' → neutral (never a positive — the honesty law)
    }
  }

  if (provided.length > 0) {
    // positives resolve the slot; waivers stay as superseded disclosures
    signals.push(...provided);
    for (const w of waived) {
      signals.push({ ...w, negative: false, source: { ...w.source, superseded: true } });
    }
  } else if (waived.length > 0) {
    signals.push(...waived);
  }
  return signals;
}

/**
 * Asset-quality signals with PER-REGION slot resolution: a usable analyzed
 * asset for a region proves evidence quality for it (an unusable or
 * unanalyzed sibling cannot un-prove it); else unusable → negative; else an
 * unanalyzed asset → declared-only positive (quality unknown, never guessed).
 */
function assetSignals(spec: CapabilitySpec, captures: DeficiencyCaptureInput[]): Signal[] {
  const signals: Signal[] = [];
  // deterministic citation order: (createdAt, sessionId, assetId) — the report
  // must be byte-identical regardless of the captures array order
  const orderedCaptures = [...captures].sort(
    (a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1),
  );
  for (const region of spec.regions) {
    const covering: { capture: DeficiencyCaptureInput; asset: DeficiencyAssetInput }[] = [];
    for (const capture of orderedCaptures) {
      for (const asset of [...(capture.assets ?? [])].sort((x, y) => (x.id < y.id ? -1 : 1))) {
        if ((asset.regions ?? []).includes(region)) covering.push({ capture, asset });
      }
    }
    if (covering.length === 0) continue;

    const usable = covering.filter((c) => c.asset.quality?.usable === true);
    const unusable = covering.filter((c) => c.asset.quality?.usable === false);
    const unanalyzed = covering.filter((c) => !c.asset.quality);

    const mk = (c: { capture: DeficiencyCaptureInput; asset: DeficiencyAssetInput }, negative: boolean): Signal => {
      const q = c.asset.quality;
      return {
        negative,
        severity: negative ? 'high' : null,
        source: {
          kind: 'asset-quality',
          signal: negative ? 'negative' : 'positive',
          captureSessionId: c.capture.id,
          assetId: c.asset.id,
          region,
          detail: q?.usable === false
            ? `analyzed evidence asset for region "${region}" marked UNUSABLE (blur ${q.blur ?? 'unknown'}, lighting ${q.lighting ?? 'unknown'}${(q.issues ?? []).length > 0 ? `; issues: ${q.issues.join('; ')}` : ''})`
            : q?.usable === true
              ? `analyzed evidence asset for region "${region}" usable (score ${fmt(q.score)}, blur ${q.blur ?? 'unknown'}, lighting ${q.lighting ?? 'unknown'})`
              : `evidence asset for region "${region}" uploaded — not analyzed yet (quality unknown, never guessed)`,
        },
      };
    };

    if (usable.length > 0) {
      // usable evidence exists: it resolves the region's state; the unusable
      // siblings stay as superseded disclosures
      signals.push(...usable.map((c) => mk(c, false)));
      for (const s of unusable.map((c) => mk(c, true))) {
        signals.push({ ...s, negative: false, source: { ...s.source, superseded: true } });
      }
    } else if (unusable.length > 0) {
      signals.push(...unusable.map((c) => mk(c, true)));
    } else {
      signals.push(...unanalyzed.map((c) => mk(c, false)));
    }
  }
  return signals;
}

// ─── Row assembly ────────────────────────────────────────────────────────────

function buildRemedy(
  spec: CapabilitySpec,
  row: { state: DeficiencyState; severity: DeficiencySeverity | null; reason: string },
  primaryRegion: string | null,
  versionId: string | null,
): DeficiencyRemedy {
  const why = row.state === 'deficient'
    ? `Targeted evidence for the ${spec.label.toLowerCase()} capability: ${row.reason}`
    : `Establish the ${spec.label.toLowerCase()} capability: ${row.reason}`;
  return {
    reason: why.length > 900 ? `${why.slice(0, 897)}…` : why,
    capability: primaryRegion ?? spec.capability,
    instructions: spec.remedy.instructions,
    expectedSignal: spec.remedy.expectedSignal,
    scope: REMEDY_SCOPE,
    twinVersionId: versionId,
  };
}

function buildRow(
  spec: CapabilitySpec,
  input: DeficiencyInput,
): DeficiencyRow {
  const signals: Signal[] = [];
  const notes: string[] = [];

  if (input.version) signals.push(...htirSignals(spec, input.version));
  const guided = guidedStepSignals(spec, input.captures);
  signals.push(...guided.signals);
  notes.push(...guided.notes);
  signals.push(...checklistSignals(spec, input.captures));
  signals.push(...assetSignals(spec, input.captures));

  const negatives = signals.filter((s) => s.negative); // state-affecting only
  const positives = signals.filter((s) => !s.negative && s.source.signal === 'positive');
  const superseded = signals.filter((s) => !s.negative && s.source.signal === 'negative');

  let state: DeficiencyState;
  let severity: DeficiencySeverity | null = null;
  let reason: string;
  let basis: DeficiencyBasis = 'none';

  if (negatives.length > 0) {
    state = 'deficient';
    severity = negatives.reduce<DeficiencySeverity>(
      (worst, s) => (s.severity && SEVERITY_RANK[s.severity] > SEVERITY_RANK[worst] ? s.severity : worst),
      'low',
    );
    const cited = negatives.slice(0, 3).map((s) => s.source.detail).join(' · ');
    reason = positives.length > 0
      ? `${cited} — while ${positives.length} positive signal(s) also exist, the deficiency stands`
      : cited;
  } else if (positives.length > 0) {
    state = 'ok';
    basis = positives.some((s) => s.source.kind === 'htir-coverage' || s.source.kind === 'asset-quality')
      ? 'observed'
      : 'declared';
    const cited = positives.slice(0, 3).map((s) => s.source.detail).join(' · ');
    reason = basis === 'observed'
      ? `${cited} (machine-observed signals exist; none report a deficiency)`
      : `${cited} — declared-level evidence only (bytes present with regions declared; no machine-observed quality signal yet)`;
    if (superseded.length > 0) {
      reason += `; ${superseded.length} earlier gap(s) were superseded by newer evidence (see sources)`;
    }
  } else {
    state = 'unknown';
    if (input.captures.length === 0) {
      reason = 'no capture sessions exist for this twin yet — nothing is known about this capability (never coerced to ok)';
    } else if (notes.length > 0) {
      reason = `no signal either way — ${notes.slice(0, 2).join('; ')}`;
    } else {
      reason = 'no capture or reconstruction signal covers this capability — its quality is unknown';
    }
    if (!input.version) {
      reason += '; no reconstructed TwinVersion exists yet';
    } else if (!input.version.confidenceSummary) {
      reason += `; TwinVersion v${input.version.version} carries no confidence summary (no reconstruction-level signals)`;
    }
  }

  const primaryRegion = negatives.find((s) => s.source.region)?.source.region
    ?? (input.version?.confidenceSummary?.deficiencies ?? []).find((d) => d && spec.regions.includes(d.capability as CaptureRegion))?.capability as string | undefined
    ?? null;

  return {
    capability: spec.capability,
    label: spec.label,
    state,
    severity,
    basis,
    reason,
    sources: signals.map((s) => s.source),
    remedy: state === 'ok' ? null : buildRemedy(spec, { state, severity, reason }, primaryRegion, input.version?.id ?? null),
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Build the honest DeficiencyReport for a twin (pure — the route fetches and
 * decodes the persisted state, this function aggregates it).
 */
export function buildDeficiencyReport(input: DeficiencyInput, now: Date = new Date()): DeficiencyReport {
  const disclosures: string[] = [];

  if (input.captures.length === 0) {
    disclosures.push('no capture sessions exist for this twin — every capability is reported unknown (honest empty state, never fake green)');
  }
  const inProgress = input.captures.filter((c) => !TERMINAL_SESSION.includes(c.status));
  if (inProgress.length > 0) {
    disclosures.push(`${inProgress.length} capture session(s) not yet terminal (${inProgress.map((c) => c.status).join(', ')}) — their evidence is incomplete and only uploaded assets count as declared signals`);
  }
  const failed = input.captures.filter((c) => c.status === 'failed');
  if (failed.length > 0) {
    disclosures.push(`${failed.length} capture session(s) failed${failed.some((c) => c.error) ? ` — last error: ${failed.find((c) => c.error)?.error}` : ''}`);
  }
  if (!input.version) {
    disclosures.push('no TwinVersion exists yet — reconstruction-level (machine-observed) signals are unavailable');
  } else if (!input.version.confidenceSummary) {
    disclosures.push(`TwinVersion v${input.version.version} carries no confidence summary — reconstruction-level signals unavailable for it`);
  }
  const guidedSummaries = input.captures.filter((c) => c.checkpoints);
  if (guidedSummaries.length > 0) {
    // deterministic pick: the LATEST session carrying a checkpoint summary
    // (max createdAt, then id) — independent of the captures array order
    const latest = [...guidedSummaries].sort(
      (a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1),
    )[0].checkpoints;
    if (typeof latest?.stepsChecked === 'number') {
      disclosures.push(`guided checkpoint summary (latest completed session): ${latest.stepsChecked} checked, ${latest.stepsPassed ?? '?'} passed${typeof latest.averageStepScore === 'number' ? `, average step score ${fmt(latest.averageStepScore)}` : ''}`);
    }
  }

  const capabilities = CAPABILITY_SPECS.map((spec) => buildRow(spec, input));
  const summary = {
    ok: capabilities.filter((r) => r.state === 'ok').length,
    deficient: capabilities.filter((r) => r.state === 'deficient').length,
    unknown: capabilities.filter((r) => r.state === 'unknown').length,
    total: capabilities.length,
  };

  return {
    version: DEFICIENCY_REPORT_VERSION,
    twinId: input.twinId,
    twinVersionId: input.version?.id ?? null,
    twinVersionNumber: input.version?.version ?? null,
    generatedAt: now.toISOString(),
    capabilities,
    summary,
    disclosures,
  };
}

/**
 * Diff two DeficiencyReports per capability. Honest ordering: a transition
 * involving `unknown` on either side is `unknown` (cannot be compared — the
 * signal never existed or was lost), never guessed as improved/regressed.
 */
export function diffDeficiencyReports(
  baseline: DeficiencyReport,
  comparison: DeficiencyReport,
): DeficiencyDelta {
  const rows: DeficiencyDeltaRow[] = CAPABILITY_SPECS.map((spec) => {
    const a = baseline.capabilities.find((r) => r.capability === spec.capability);
    const b = comparison.capabilities.find((r) => r.capability === spec.capability);
    const from = { state: a?.state ?? 'unknown', severity: a?.severity ?? null };
    const to = { state: b?.state ?? 'unknown', severity: b?.severity ?? null };

    let delta: DeficiencyDeltaKind;
    let reason: string;
    if (from.state === 'unknown' || to.state === 'unknown') {
      delta = 'unknown';
      const which = from.state === 'unknown' && to.state === 'unknown'
        ? 'neither side has a signal'
        : from.state === 'unknown'
          ? `the baseline (${baseline.twinVersionNumber !== null ? `v${baseline.twinVersionNumber}` : 'no version'}) reported unknown — nothing to compare against`
          : `the comparison (${comparison.twinVersionNumber !== null ? `v${comparison.twinVersionNumber}` : 'no version'}) reported unknown — the signal does not exist for it`;
      reason = `cannot compare honestly: ${which}`;
    } else if (from.state === 'deficient' && to.state === 'deficient') {
      const ra = SEVERITY_RANK[from.severity ?? 'low'];
      const rb = SEVERITY_RANK[to.severity ?? 'low'];
      delta = rb < ra ? 'improved' : rb > ra ? 'regressed' : 'unchanged';
      reason = delta === 'unchanged'
        ? `still deficient (${to.severity ?? 'low'} severity) in both reports`
        : delta === 'improved'
          ? `deficiency severity eased (${from.severity ?? 'low'} → ${to.severity ?? 'low'})`
          : `deficiency severity worsened (${from.severity ?? 'low'} → ${to.severity ?? 'low'})`;
    } else if (from.state === 'deficient' && to.state === 'ok') {
      delta = 'improved';
      reason = 'the deficiency was resolved (deficient → ok)';
    } else if (from.state === 'ok' && to.state === 'deficient') {
      delta = 'regressed';
      reason = 'a new deficiency appeared (ok → deficient)';
    } else {
      delta = 'unchanged';
      reason = 'ok in both reports';
    }

    return {
      capability: spec.capability,
      label: spec.label,
      delta,
      from,
      to,
      reason,
    };
  });

  return {
    version: DEFICIENCY_DELTA_VERSION,
    baseline: {
      twinVersionId: baseline.twinVersionId,
      twinVersionNumber: baseline.twinVersionNumber,
    },
    comparison: {
      twinVersionId: comparison.twinVersionId,
      twinVersionNumber: comparison.twinVersionNumber,
    },
    rows,
    summary: {
      improved: rows.filter((r) => r.delta === 'improved').length,
      regressed: rows.filter((r) => r.delta === 'regressed').length,
      unchanged: rows.filter((r) => r.delta === 'unchanged').length,
      unknown: rows.filter((r) => r.delta === 'unknown').length,
    },
  };
}
