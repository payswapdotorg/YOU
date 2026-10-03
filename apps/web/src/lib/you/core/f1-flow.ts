// ═══════════════════════════════════════════════════════════════════════════
// YOU core — F1 operator capture guided flow (Worker B lane, P6.B3).
//
// The operator-facing side of docs/F1_OPERATOR_CAPTURE.md (THE LAW for this
// item): a guided 8-step capture protocol with persisted instruction text,
// a server-enforced consent gate that demands the six F1 consent statements
// (what / why / tests / retention / training-default-DENIED / deletion),
// per-step heuristic quality+liveness checkpoints, a content-addressed
// evidence manifest, review→TwinVersion linkage with the acceptance chain,
// and a retention-honoring deletion path.
//
// Honesty laws mirrored from the C-lane pipeline (lab/f1-recon.ts):
// - FAIL-CLOSED GATES: every create/advance re-verifies consent server-side;
//   a machine-readable 403 lists exactly which statements are missing.
// - DECLARED ≠ OBSERVED: region coverage counts as DECLARED evidence only.
// - NO FABRICATED CHECKS: video/audio duration is disclosed as not
//   verifiable from container sniffing at this wave — never guessed.
// - The 8-step protocol and byte-level checkpoint taxonomy are REUSED from
//   the C-lane module (single source of truth; this lane adds the operator
//   flow around it, it does not redefine the protocol).
// ═══════════════════════════════════════════════════════════════════════════
import { createHash } from 'crypto';
import type { ConsentGrant } from '@prisma/client';
import { db } from '@/lib/db';
import type {
  CaptureRegion, ConsentScope, F1AcceptanceChain, F1ConsentStatements,
  F1EvidenceManifest, F1GuidedStep, F1ProtocolState, F1ReviewState,
  F1StepCheckpoint,
} from '../contracts';
import { consentRequired } from './errors';
import { parseJson } from './views';
import { F1_PROTOCOL_STEPS, f1LivenessCheckpoint, type F1EvidenceRecord } from '../lab/f1-recon';
import { getObject, sha256Buffer } from './storage';

// ─── The six F1 consent statements (docs/F1_OPERATOR_CAPTURE.md) ─────────────

export const F1_REQUIRED_STATEMENTS = ['what', 'why', 'tests', 'retention', 'training', 'deletion'] as const;
export type F1RequiredStatement = (typeof F1_REQUIRED_STATEMENTS)[number];

const STATEMENT_TEXT_MAX = 400;
const STATEMENT_TESTS_MAX = 10;

export type F1StatementValidation =
  | { ok: true; statements: F1ConsentStatements }
  | { ok: false; missing: F1RequiredStatement[]; invalid: F1RequiredStatement[] };

/**
 * Validate raw statement data against the F1 law. Machine-checkable coverage
 * means: every one of the six statements is present and non-empty, tests is a
 * non-empty list, retention carries an explicit mayBeRetained + policy, and
 * training carries an EXPLICIT boolean (the grant-creation seam fills the
 * default-DENIED value when the subject left it unset — the law's default).
 */
export function validateF1Statements(raw: unknown): F1StatementValidation {
  const missing: F1RequiredStatement[] = [];
  const invalid: F1RequiredStatement[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, missing: [...F1_REQUIRED_STATEMENTS], invalid: [] };
  }
  const rec = raw as Record<string, unknown>;

  const text = (key: F1RequiredStatement): string | null => {
    const v = rec[key];
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return null; // missing
    if (typeof v !== 'string') return ''; // present but invalid shape
    const t = v.trim();
    if (!t) return null;
    return t.length > STATEMENT_TEXT_MAX ? '' : t;
  };

  const what = text('what');
  if (what === null) missing.push('what'); else if (what === '') invalid.push('what');
  const why = text('why');
  if (why === null) missing.push('why'); else if (why === '') invalid.push('why');
  const deletion = text('deletion');
  if (deletion === null) missing.push('deletion'); else if (deletion === '') invalid.push('deletion');

  // tests: non-empty array of non-empty strings
  let tests: string[] | null = null;
  if (rec.tests === undefined || rec.tests === null) {
    missing.push('tests');
  } else if (!Array.isArray(rec.tests)
    || rec.tests.length === 0
    || rec.tests.length > STATEMENT_TESTS_MAX
    || rec.tests.some((t) => typeof t !== 'string' || !t.trim() || t.trim().length > 120)) {
    invalid.push('tests');
  } else {
    tests = (rec.tests as string[]).map((t) => t.trim());
  }

  // retention: { mayBeRetained: boolean, retainUntil?: ISO, policy: non-empty }
  let retention: F1ConsentStatements['retention'] | null = null;
  if (rec.retention === undefined || rec.retention === null) {
    missing.push('retention');
  } else if (typeof rec.retention !== 'object' || Array.isArray(rec.retention)) {
    invalid.push('retention');
  } else {
    const r = rec.retention as Record<string, unknown>;
    const mayBeRetained = r.mayBeRetained;
    const policy = typeof r.policy === 'string' ? r.policy.trim() : '';
    const retainUntil = r.retainUntil;
    const retainUntilOk = retainUntil === undefined || retainUntil === null
      || (typeof retainUntil === 'string' && !Number.isNaN(new Date(retainUntil).getTime()));
    if (typeof mayBeRetained !== 'boolean' || !policy || policy.length > STATEMENT_TEXT_MAX || !retainUntilOk) {
      invalid.push('retention');
    } else {
      retention = {
        mayBeRetained,
        policy,
        ...(typeof retainUntil === 'string' && retainUntil.trim() ? { retainUntil } : {}),
      };
    }
  }

  // training: { permitted: boolean } — separate and default-DENIED. Absent at
  // grant creation is normalized to { permitted: false } THERE (the seam); a
  // grant that reaches this validator without the field is NOT covered.
  let training: F1ConsentStatements['training'] | null = null;
  if (rec.training === undefined || rec.training === null) {
    missing.push('training');
  } else if (typeof rec.training !== 'object' || Array.isArray(rec.training)
    || typeof (rec.training as Record<string, unknown>).permitted !== 'boolean') {
    invalid.push('training');
  } else {
    const t = rec.training as { permitted: boolean; note?: unknown };
    training = {
      permitted: t.permitted,
      ...(typeof t.note === 'string' && t.note.trim() ? { note: t.note.trim() } : {}),
    };
  }

  if (missing.length > 0 || invalid.length > 0) return { ok: false, missing, invalid };
  return {
    ok: true,
    statements: {
      what: what as string,
      why: why as string,
      tests: tests as string[],
      retention: retention as F1ConsentStatements['retention'],
      training: training as F1ConsentStatements['training'],
      deletion: deletion as string,
    },
  };
}

/** Parse + validate a grant row's stored statements (null when not covered). */
export function grantF1Statements(grant: ConsentGrant): F1ConsentStatements | null {
  const raw = parseJson<unknown>(grant.statements, null);
  const v = validateF1Statements(raw);
  return v.ok ? v.statements : null;
}

/**
 * Normalize raw statements for STORAGE at grant-creation time: fills the
 * training default-DENIED when absent (docs/F1_OPERATOR_CAPTURE.md: "Training
 * permission is separate and default-denied") and trims text. Throws nothing —
 * invalid shapes are stored verbatim-ish and the GATE will refuse them with
 * the precise missing/invalid lists (never a silent pass).
 */
export function normalizeF1StatementsForStorage(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const rec = { ...(raw as Record<string, unknown>) };
  if (rec.training === undefined || rec.training === null) {
    rec.training = { permitted: false, note: 'not granted — training is default-denied' };
  }
  return rec;
}

export interface F1ConsentDecision {
  grant: ConsentGrant;
  statements: F1ConsentStatements;
}

/**
 * SERVER-ENFORCED F1 consent gate (create + every advance). Requires an
 * active (not revoked, not expired) grant with the capture scope whose
 * statements cover all six F1 requirements. Honest 403 consent_required with
 * a machine-readable details block — never a silent pass.
 */
export async function requireF1CaptureConsent(
  tenantId: string,
  subjectId: string,
): Promise<F1ConsentDecision> {
  const grants = await db.consentGrant.findMany({
    where: { tenantId, subjectId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'asc' },
  });
  const covering = grants.filter((g) => parseJson<string[]>(g.scopes, []).includes('capture' as ConsentScope));
  if (covering.length === 0) {
    throw consentRequired(
      `no active consent grant with scope "capture" for subject ${subjectId} — the F1 guided capture flow requires one before a session can be created or advanced`,
      {
        subjectId,
        scope: 'capture',
        f1: true,
        reason: 'no_active_grant',
        requiredStatements: [...F1_REQUIRED_STATEMENTS],
        grantsConsidered: grants.length,
      },
    );
  }
  for (const grant of covering) {
    const statements = grantF1Statements(grant);
    if (statements) return { grant, statements };
  }
  const first = validateF1Statements(parseJson<unknown>(covering[0].statements, null));
  const missing = first.ok ? [] : first.missing;
  const invalid = first.ok ? [] : first.invalid;
  throw consentRequired(
    `the active capture-scope consent grant(s) for subject ${subjectId} do not state the required F1 capture consent — missing or invalid: ${[...missing, ...invalid].join(', ') || 'unknown'}`,
    {
      subjectId,
      scope: 'capture',
      f1: true,
      reason: 'statements_incomplete',
      missingStatements: missing,
      invalidStatements: invalid,
      requiredStatements: [...F1_REQUIRED_STATEMENTS],
      grantIdsConsidered: covering.map((g) => g.id),
      guidance: 're-grant consent with the six F1 statements (what, why, tests, retention, training — default denied, deletion/withdrawal process)',
    },
  );
}

// ─── The guided 8-step protocol with persisted operator instructions ─────────

/**
 * Operator-facing instruction text per protocol step — THE text persisted on
 * the capture record (docs/F1_OPERATOR_CAPTURE.md: the protocol may be
 * optimized, but the actual instructions for the acceptance fixture must be
 * persisted with the capture). Written for a consenting internal tester /
 * contractor / advisor / volunteer — the product owner does NOT need to be
 * the captured person.
 */
const STEP_INSTRUCTIONS: Record<string, string> = {
  'face-front':
    'Stand or sit facing the camera straight on. Look directly into the lens with a neutral expression, eyes open, hair away from the face. Remove glasses if comfortable. Use even, front-facing light and a plain background. Hold still for one clear photo.',
  'face-turn':
    'Turn your head slowly to the LEFT until your left ear faces the camera and hold for one photo; then turn to the RIGHT until your right ear faces the camera and hold for one photo. Keep the jawline and nose silhouette visible against a plain background. Two photos total (left profile, right profile).',
  'upper-body':
    'Face the camera from the waist up. Arms relaxed at your sides, shoulders square, fitted clothing so the shoulder line is visible. Even front light, plain background. One clear photo.',
  'full-body':
    'Stand at full height, facing the camera, head to feet fully in frame. Arms slightly away from the body, feet shoulder-width. Fitted clothing, plain background, enough distance to fit the whole body. One clear photo.',
  'hands':
    'Show both hands: palms open toward the camera (fingers relaxed and slightly spread), then the backs of both hands. Fill the frame with the hands without cropping fingers. Two photos total.',
  'turn-around':
    'Slowly turn a full circle: pause with your BACK to the camera so the back of your head, hairline and full back silhouette are visible. Plain background. One clear photo of the back (a short turning clip also works if easier).',
  'walking':
    'Walk naturally toward and/or across the camera for a few steps (about 3–5 seconds), normal pace and arm swing, full body in frame. Record a short video clip.',
  speech:
    'OPTIONAL: read a short passage aloud or perform a brief spoken piece on camera (about 20 seconds) at a natural pace. This enables voice and mouth-motion profiles. Skip freely with a reason if you prefer not to.',
};

/**
 * Allowed upload mimes per step. Steps 1–6 are images, the walking sequence
 * is a video clip, and the optional speech/performance step accepts audio
 * OR an on-camera video (the F1 instruction offers both).
 */
export const F1_STEP_MIMES: Record<string, readonly string[]> = {
  'face-front': ['image/png', 'image/jpeg', 'image/webp'],
  'face-turn': ['image/png', 'image/jpeg', 'image/webp'],
  'upper-body': ['image/png', 'image/jpeg', 'image/webp'],
  'full-body': ['image/png', 'image/jpeg', 'image/webp'],
  'hands': ['image/png', 'image/jpeg', 'image/webp'],
  'turn-around': ['image/png', 'image/jpeg', 'image/webp'],
  walking: ['video/mp4', 'video/webm'],
  speech: ['audio/wav', 'audio/mpeg', 'audio/ogg', 'video/mp4', 'video/webm'],
};

/** Media family each step primarily expects (fallback for size bounds). */
const STEP_MEDIA_FAMILY: Record<string, 'image' | 'video' | 'audio'> = {
  'face-front': 'image', 'face-turn': 'image', 'upper-body': 'image', 'full-body': 'image',
  'hands': 'image', 'turn-around': 'image', walking: 'video', speech: 'audio',
};

/** Plausible byte bounds per family (the size leg of the heuristic). */
const FAMILY_BYTES: Record<'image' | 'video' | 'audio', { min: number; max: number }> = {
  image: { min: 512, max: 10 * 1024 * 1024 },
  video: { min: 1024, max: 50 * 1024 * 1024 },
  audio: { min: 512, max: 20 * 1024 * 1024 },
};

export function f1StepMediaFamily(stepId: string): 'image' | 'video' | 'audio' {
  return STEP_MEDIA_FAMILY[stepId] ?? 'image';
}

export function f1StepByteLimits(stepId: string): { min: number; max: number } {
  return FAMILY_BYTES[f1StepMediaFamily(stepId)];
}

/** Build the initial guided protocol state (step 1 current, rest pending). */
export function buildF1ProtocolState(): F1ProtocolState {
  const steps: F1GuidedStep[] = F1_PROTOCOL_STEPS.map((s) => ({
    step: s.step,
    id: s.id,
    label: s.label,
    instruction: STEP_INSTRUCTIONS[s.id] ?? `Capture: ${s.label}.`,
    regions: [...s.regions],
    ...(s.coarseGrainingNote ? { coarseGrainingNote: s.coarseGrainingNote } : {}),
    required: s.step !== 8, // step 8 (speech/performance) is optional per the F1 law
    state: s.step === 1 ? ('current' as const) : ('pending' as const),
  }));
  return {
    version: 'f1-operator-capture/v1',
    source: 'docs/F1_OPERATOR_CAPTURE.md',
    steps,
    currentStepId: steps[0]?.id ?? null,
  };
}

/** Parse a session's persisted protocol (null when not a guided session). */
export function parseF1Protocol(session: { protocol: string | null }): F1ProtocolState | null {
  return parseJson<F1ProtocolState | null>(session.protocol, null);
}

// ─── Per-step quality + liveness checkpoint (heuristic, honest) ──────────────

/**
 * Run the per-step checkpoint over the just-uploaded bytes. Reuses the C-lane
 * f1LivenessCheckpoint byte taxonomy (present / size / container / mime /
 * aspect) and layers the operator-flow heuristics: plausible size bounds for
 * the step's media family and declared-region coverage. Region coverage is
 * DECLARED evidence only (declared ≠ observed — the C-lane law); video/audio
 * duration is disclosed as not verifiable from container sniffing at this
 * wave, never guessed.
 */
export function assessF1StepCheckpoint(
  step: F1GuidedStep,
  asset: { id: string; kind: string; mime: string; declaredBytes: number; regions: CaptureRegion[] },
  bytes: Buffer | null,
): F1StepCheckpoint {
  const family = f1StepMediaFamily(step.id);
  const record: F1EvidenceRecord = {
    assetId: asset.id,
    storageKey: 'pending', // the checkpoint runs before the row is created; key unknown here
    kind: asset.kind,
    mime: asset.mime,
    contentHash: '',
    declaredBytes: asset.declaredBytes,
    regions: asset.regions,
  };
  const verdict = f1LivenessCheckpoint(record, bytes);

  const checks: F1StepCheckpoint['checks'] = {
    filePresent: bytes !== null && bytes !== undefined,
    plausibleSize: false,
    decodable: false,
    plausibleAspect: null,
    requiredRegionsCovered: 'none',
  };
  const issues: string[] = [];

  if (checks.filePresent && bytes) {
    // size bounds follow the SNIFFED family when the container decoded
    // (speech accepts audio or video); the step's expected family is the
    // pre-sniff fallback.
    const bounds = FAMILY_BYTES[verdict.sniffed?.mimeFamily ?? family];
    checks.plausibleSize = bytes.length >= bounds.min && bytes.length <= bounds.max;
    if (bytes.length < bounds.min) issues.push(`file is ${bytes.length} bytes — below the plausible ${(verdict.sniffed?.mimeFamily ?? family)} minimum of ${bounds.min}`);
    if (bytes.length > bounds.max) issues.push(`file is ${bytes.length} bytes — above the ${(verdict.sniffed?.mimeFamily ?? family)} limit of ${bounds.max}`);
  }

  if (verdict.passed && verdict.sniffed) {
    checks.decodable = true;
    checks.plausibleAspect = verdict.sniffed.width !== undefined && verdict.sniffed.height !== undefined
      ? true // f1LivenessCheckpoint already refused implausible aspects
      : null;
    if (verdict.sniffed.mimeFamily === 'video' || verdict.sniffed.mimeFamily === 'audio') {
      issues.push(`${verdict.sniffed.mimeFamily} duration is not verifiable from container sniffing at this wave — size and container checks only (never guessed)`);
    }
  } else if (verdict.refusal) {
    issues.push(verdict.refusal.message);
  }

  const covered = asset.regions.some((r) => step.regions.includes(r));
  checks.requiredRegionsCovered = covered ? 'declared' : 'none';
  if (!covered) {
    issues.push(`declared regions [${asset.regions.join(', ') || 'none'}] do not cover the step's required regions [${step.regions.join(', ')}]`);
  }

  const scoreParts = [
    checks.filePresent, checks.plausibleSize, checks.decodable,
    checks.plausibleAspect !== false, covered,
  ];
  const score = scoreParts.filter(Boolean).length / scoreParts.length;

  return {
    stepId: step.id,
    ...(asset.id ? { assetId: asset.id } : {}),
    passed: verdict.passed && checks.plausibleSize && covered,
    checks,
    ...(verdict.sniffed ? { sniffed: verdict.sniffed } : {}),
    ...(verdict.refusal ? { refusal: verdict.refusal } : {}),
    issues,
    score,
  };
}

// ─── Content-addressed evidence manifest ─────────────────────────────────────

export interface F1ManifestInput {
  captureSessionId: string;
  twinId: string;
  subjectId: string;
  consentGrantId: string;
  statements: F1ConsentStatements;
  assets: {
    id: string; stepId: string | null; storageKey: string; contentHash: string;
    bytes: number; mime: string; regions: CaptureRegion[]; checkpointPassed: boolean | null;
  }[];
}

/**
 * Build the content-addressed evidence manifest: every asset's stored bytes
 * are re-hashed (sha256) and compared against the recorded contentHash —
 * `verified` is the honest result of that comparison, never assumed.
 * Provenance (twin/subject/covering grant) and the deletion policy from the
 * consent statements are recorded on the manifest per the F1 law.
 */
export async function buildF1Manifest(input: F1ManifestInput): Promise<F1EvidenceManifest> {
  const entries: F1EvidenceManifest['assets'] = [];
  let verified = 0;
  let totalBytes = 0;
  for (const a of input.assets) {
    const bytes = await getObject(a.storageKey).catch(() => null);
    const rehash = bytes ? sha256Buffer(bytes) : null;
    const ok = rehash === a.contentHash;
    if (ok) verified += 1;
    totalBytes += a.bytes;
    entries.push({
      assetId: a.id,
      stepId: a.stepId,
      storageKey: a.storageKey,
      contentHash: a.contentHash,
      verified: ok,
      bytes: a.bytes,
      mime: a.mime,
      regions: a.regions,
      checkpointPassed: a.checkpointPassed,
    });
  }
  return {
    version: 'f1-evidence-manifest/v1',
    algorithm: 'sha256',
    captureSessionId: input.captureSessionId,
    provenance: {
      twinId: input.twinId,
      subjectId: input.subjectId,
      consentGrantId: input.consentGrantId,
      capturedVia: 'f1-guided-flow/v1',
    },
    deletionPolicy: {
      ...input.statements.retention,
      deletionProcess: input.statements.deletion,
    },
    assets: entries,
    totals: { assets: entries.length, verified, bytes: totalBytes },
    builtAt: new Date().toISOString(),
  };
}

// ─── Retention-honoring deletion decision ────────────────────────────────────

export type F1DeletionDecision =
  | { allowed: true }
  | { allowed: false; reason: string; policy: string; retainUntil?: string };

/**
 * Decide whether the F1 deletion path may run NOW, honoring the consent
 * statements' retention policy (docs/F1_OPERATOR_CAPTURE.md). Deletion is
 * allowed when any of:
 *   - the consent did not grant retention (mayBeRetained: false);
 *   - the covering grant is gone, revoked (withdrawal) or expired;
 *   - the stated retainUntil window has elapsed.
 * Otherwise refused with the policy + window (honest 409 policy_blocked).
 */
export function f1DeletionDecision(
  retention: F1ConsentStatements['retention'] | null,
  grant: { revokedAt: Date | null; expiresAt: Date } | null,
  now: Date = new Date(),
): F1DeletionDecision {
  if (!retention || !grant) {
    return { allowed: true };
  }
  if (!retention.mayBeRetained) {
    return { allowed: true };
  }
  const withdrawn = !!grant.revokedAt || grant.expiresAt.getTime() <= now.getTime();
  if (withdrawn) {
    return { allowed: true };
  }
  if (retention.retainUntil) {
    const until = new Date(retention.retainUntil);
    if (!Number.isNaN(until.getTime()) && until.getTime() <= now.getTime()) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `the consent grants retention until ${retention.retainUntil} — deletion is available after the window elapses or when the subject withdraws (revoke the grant)`,
      policy: retention.policy,
      retainUntil: retention.retainUntil,
    };
  }
  return {
    allowed: false,
    reason: 'the consent grants retention while the grant is active — deletion is available when the subject withdraws (revoke the grant)',
    policy: retention.policy,
  };
}

// ─── Review / acceptance chain ───────────────────────────────────────────────

/** Parse a session's review state ("{}" → the neutral none state). */
export function parseF1Review(session: { review: string }): F1ReviewState {
  const parsed = parseJson<Partial<F1ReviewState> | null>(session.review, null);
  if (
    !parsed || typeof parsed !== 'object'
    || (parsed.status !== 'none' && parsed.status !== 'promoted' && parsed.status !== 'rejected')
  ) {
    return { status: 'none' };
  }
  return parsed as F1ReviewState;
}

/**
 * Assemble the F1 acceptance chain — capture → consent → liveness → quality →
 * reconstruction → TwinVersion → review — from the persisted session state.
 * Every leg cites the evidence actually recorded on the session; nothing is
 * invented (skipped required steps are listed by id in the quality leg).
 */
export function buildF1AcceptanceChain(args: {
  session: { id: string; createdAt: Date; completedAt: Date | null };
  protocol: F1ProtocolState;
  statements: F1ConsentStatements;
  grantId: string;
  /** per-ASSET checkpoint accounting from the persisted manifest (a failed
   * submission's report is never overwritten by a retry — the honest count). */
  assetCheckpoints: { checked: number; failed: number };
  twinVersion: { id: string; version: number; compiledBy?: string; pipelineId?: string | null };
  review: { verdict: 'approve' | 'reject'; note?: string; decidedAt: string };
}): F1AcceptanceChain {
  const steps = args.protocol.steps;
  const done = steps.filter((s) => s.state === 'done');
  const skipped = steps.filter((s) => s.state === 'skipped');
  const skippedRequired = skipped.filter((s) => s.required).map((s) => s.id);
  const scores = done.map((s) => s.checkpoint?.score).filter((sc): sc is number => typeof sc === 'number');
  return {
    capture: {
      captureSessionId: args.session.id,
      createdAt: args.session.createdAt.toISOString(),
      completedAt: args.session.completedAt ? args.session.completedAt.toISOString() : null,
    },
    consent: { grantId: args.grantId, statements: args.statements },
    liveness: {
      stepsChecked: args.assetCheckpoints.checked,
      refusals: args.assetCheckpoints.failed,
      summary: `${args.assetCheckpoints.checked} evidence submission(s) carry a persisted liveness/quality checkpoint; ${args.assetCheckpoints.failed} recorded a failing checkpoint (disclosed, never dropped)`,
    },
    quality: {
      stepsDone: done.length,
      stepsSkipped: skipped.length,
      skippedRequired,
      score: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    },
    reconstruction: {
      twinVersionId: args.twinVersion.id,
      version: args.twinVersion.version,
      ...(args.twinVersion.compiledBy ? { compiledBy: args.twinVersion.compiledBy } : {}),
      ...(args.twinVersion.pipelineId !== undefined ? { pipelineId: args.twinVersion.pipelineId } : {}),
    },
    review: args.review,
  };
}

/** sha256 of a buffer (re-exported convenience for route-level verification). */
export { sha256Buffer, createHash };
