// ═══════════════════════════════════════════════════════════════════════════
// YOU core — verification sessions (Worker A lane, W2.A / A4)
// POST /api/v1/verification-sessions per docs/API_CONTRACTS.md §Trust;
// semantics per docs/SECURITY_PRIVACY.md:
//   control 1 — capture/verification can require ACTIVE liveness challenges;
//   control 2 — ownership/verification confidence is separate from
//               reconstruction fidelity;
//   control 3 — identity/liveness evidence is DISTINCT from visual similarity.
//
// Honesty rules (non-negotiables):
// - this surface NEVER claims an identity match: no identity/face-matching
//   adapter exists in the registry, so `identityMatch` and `visualSimilarity`
//   are reported as null with an explicit note — not fabricated;
// - ownershipConfidence is derived ONLY from real machine signals (the
//   evidence assets' VLM quality scores, when present); when no machine
//   analysis exists it is null — never invented;
// - liveness pass/fail is deterministic over declared + analyzed coverage of
//   the challenge's required regions, and the anti-replay window;
// - consent is server-enforced at creation (see compatibility note: the frozen
//   ConsentScope union has no 'verify' scope — the 'capture' scope governs
//   collection of subject evidence and is reused here).
// ═══════════════════════════════════════════════════════════════════════════
import { randomBytes } from 'crypto';
import type { EvidenceAsset, VerificationSession } from '@prisma/client';
import type { CaptureRegion } from '../contracts';
import { parseJson } from './views';

// ─── View shapes (lane-owned; contracts/index.ts stays frozen) ──────────────

export type VerificationMethod = 'liveness-challenge';

export interface LivenessChallenge {
  challengeId: string;
  nonce: string; // anti-replay binding for submitted evidence
  variant: string;
  prompt: string; // the active challenge shown to the subject
  instructions: string;
  requiredRegions: CaptureRegion[]; // evidence regions that must be covered
  issuedAt: string;
  expiresAt: string; // anti-replay window (distinct from session expiry)
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
  /** evidence-quality-derived ownership signal (mean VLM quality score); null
   *  when no submitted asset carries machine analysis — never fabricated */
  ownershipConfidence: number | null;
  /** ALWAYS null on this surface — visual similarity is distinct from
   *  identity/liveness evidence and no matching adapter is registered */
  visualSimilarity: null;
  /** ALWAYS null — this surface never claims an identity match */
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

// ─── Challenge bank (active liveness challenges, control 1) ─────────────────

interface ChallengeVariant {
  key: string;
  prompt: string;
  instructions: string;
  requiredRegions: CaptureRegion[];
}

const CHALLENGE_BANK: ChallengeVariant[] = [
  {
    key: 'head-turn-smile',
    prompt: 'Look at the camera, turn your head slowly to one side, then return to front and smile briefly showing your teeth.',
    instructions:
      'Record a short clip or take three photos during the challenge: front, turned, and smiling. Even lighting, plain background.',
    requiredRegions: ['face.front', 'face.profile', 'teeth'],
  },
  {
    key: 'hairline-reveal',
    prompt: 'Face the camera and sweep your hair back briefly so your forehead and hairline are fully visible.',
    instructions:
      'Take a front photo with the hairline fully visible before releasing the hair.',
    requiredRegions: ['face.front', 'face.hairline'],
  },
  {
    key: 'hands-raise',
    prompt: 'Face the camera, then raise both hands to chest height with palms open and fingers spread.',
    instructions:
      'One photo of the face and one of both palms at chest height, fingers relaxed and spread.',
    requiredRegions: ['face.front', 'hands'],
  },
  {
    key: 'silhouette-turn',
    prompt: 'Stand at full height facing the camera, then turn 90° so a full side silhouette is visible.',
    instructions:
      'Two full-body photos against a plain background: front-facing, then side-facing.',
    requiredRegions: ['silhouette.front', 'silhouette.side'],
  },
];

export const SESSION_TTL_MINUTES = 60;
export const CHALLENGE_WINDOW_MINUTES = 10;

/** Deterministic variant pick from the nonce (no hidden state). */
function pickVariant(nonce: string): ChallengeVariant {
  let acc = 0;
  for (let i = 0; i < nonce.length; i += 1) acc = (acc * 31 + nonce.charCodeAt(i)) % 100003;
  return CHALLENGE_BANK[acc % CHALLENGE_BANK.length];
}

export function generateChallenge(): LivenessChallenge {
  const nonce = randomBytes(12).toString('hex');
  const variant = pickVariant(nonce);
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_WINDOW_MINUTES * 60 * 1000);
  return {
    challengeId: `vc_${randomBytes(8).toString('hex')}`,
    nonce,
    variant: variant.key,
    prompt: variant.prompt,
    instructions: variant.instructions,
    requiredRegions: [...variant.requiredRegions],
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    consumedAt: null,
  };
}

export function sessionExpiry(from = new Date()): Date {
  return new Date(from.getTime() + SESSION_TTL_MINUTES * 60 * 1000);
}

// ─── View serialization ──────────────────────────────────────────────────────

export function verificationSessionView(s: VerificationSession): VerificationSessionView {
  return {
    id: s.id,
    subjectId: s.subjectId,
    twinId: s.twinId,
    purpose: s.purpose,
    method: s.method as VerificationMethod,
    status: s.status as VerificationSessionView['status'],
    challenge: parseJson<LivenessChallenge | null>(s.challenge, null),
    evidenceAssetIds: parseJson<string[]>(s.evidenceAssetIds, []),
    result: parseJson<VerificationResult | null>(s.result, null),
    consentGrantId: s.consentGrantId,
    expiresAt: s.expiresAt.toISOString(),
    createdAt: s.createdAt.toISOString(),
    submittedAt: s.submittedAt ? s.submittedAt.toISOString() : null,
    evaluatedAt: s.evaluatedAt ? s.evaluatedAt.toISOString() : null,
  };
}

// ─── Deterministic evaluation (controls 2 & 3) ─────────────────────────────

/**
 * Evaluate a verification session against its submitted evidence.
 * Deterministic and honest: coverage comes from declared regions ∪ VLM-analyzed
 * coverage; ownership confidence only from real quality scores; identity and
 * visual similarity are never claimed.
 */
export function evaluateVerification(
  session: VerificationSession,
  assets: EvidenceAsset[],
): VerificationResult {
  const challenge = parseJson<LivenessChallenge | null>(session.challenge, null);
  const requiredRegions = challenge?.requiredRegions ?? [];
  const submittedAt = session.submittedAt;
  const windowEnd = challenge ? new Date(challenge.expiresAt).getTime() : 0;
  const onTime = !!(submittedAt && windowEnd > 0 && submittedAt.getTime() <= windowEnd);

  // coverage = declared regions ∪ machine-observed coverage (when analyzed)
  const covered = new Set<string>();
  const analyzedScores: number[] = [];
  for (const asset of assets) {
    for (const r of parseJson<string[]>(asset.regions, [])) covered.add(r);
    const quality = parseJson<{ coverage?: string[]; score?: number } | null>(asset.quality, null);
    if (quality) {
      for (const r of quality.coverage ?? []) covered.add(r);
      if (typeof quality.score === 'number' && Number.isFinite(quality.score)) {
        analyzedScores.push(Math.min(1, Math.max(0, quality.score)));
      }
    }
  }

  const missing = requiredRegions.filter((r) => !covered.has(r));
  const notes: string[] = [];

  let livenessStatus: 'passed' | 'failed' | 'inconclusive';
  let outcome: VerificationResult['outcome'];
  let livenessNote: string;
  if (!onTime) {
    // anti-replay window elapsed before evidence submission — active-challenge fail
    livenessStatus = 'failed';
    outcome = 'liveness-failed';
    livenessNote = 'evidence was submitted after the active challenge window expired — the liveness challenge failed (anti-replay)';
  } else if (missing.length === 0 && requiredRegions.length > 0) {
    livenessStatus = 'passed';
    outcome = 'liveness-verified';
    livenessNote = `all required regions covered within the challenge window (${requiredRegions.join(', ')})`;
  } else {
    livenessStatus = 'inconclusive';
    outcome = 'inconclusive';
    livenessNote = `required regions not covered by submitted evidence: ${missing.join(', ') || '(challenge had no required regions)'}`;
  }

  const ownershipConfidence =
    analyzedScores.length > 0
      ? Number((analyzedScores.reduce((a, b) => a + b, 0) / analyzedScores.length).toFixed(3))
      : null;
  if (ownershipConfidence === null) {
    notes.push(
      'ownershipConfidence is null: none of the submitted evidence assets carries machine quality analysis (run capture.quality on the source capture session first) — no confidence is invented',
    );
  } else {
    notes.push(
      `ownershipConfidence ${ownershipConfidence} is the mean VLM quality score over ${analyzedScores.length} analyzed asset(s) — an evidence-quality signal, NOT an identity proof`,
    );
  }
  notes.push(
    'visualSimilarity is null: visual similarity is distinct from identity/liveness evidence (SECURITY_PRIVACY controls 2–3) and no identity-matching adapter is registered',
  );
  notes.push('identityMatch is null: this surface never claims an identity match');

  return {
    outcome,
    liveness: {
      status: livenessStatus,
      onTime,
      coveredRegions: [...covered],
      missingRegions: missing,
      note: livenessNote,
    },
    ownershipConfidence,
    visualSimilarity: null,
    identityMatch: null,
    evaluatedAt: new Date().toISOString(),
    evidenceAssetIds: assets.map((a) => a.id),
    notes,
  };
}
