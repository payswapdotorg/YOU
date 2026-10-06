// ═══════════════════════════════════════════════════════════════════════════
// The Capture Scientist (Worker C lane, P6.C10) — docs/LAB_DESIGN.md:
// "The Lab may discover better capture instructions and request only the
// additional evidence needed for a missing region/action."
//
// Derives a TARGETED EvidenceRequest from the REAL failure data: region →
// F1 capability mapping (the same capability vocabulary B5's guided
// fulfillment focuses), instructions from the recorded remediation +
// suspected cause, expectedSignal referencing the failing pipeline's next
// benchmark. HONEST LAW: no fabricated guidance — a failure without a
// region, or a region no capture protocol maps to, is a refusal.
// PURE + zero-import (node:test-importable).
// ═══════════════════════════════════════════════════════════════════════════

export interface ScientistFailureInput {
  id: string;
  benchmarkRunId?: string | null;
  inputConditions: Record<string, unknown>;
  suspectedCause: string;
  remediation?: string | null;
  confidence: number;
}

export interface ScientistRequestDraft {
  reason: string;
  capability: string;
  instructions: string;
  expectedSignal: string;
  scope: string;
}

export type ScientistResult = ScientistRequestDraft | { refusal: string };

export function isScientistRefusal(draft: ScientistResult): draft is { refusal: string } {
  return typeof (draft as { refusal?: unknown }).refusal === 'string';
}

/**
 * Region → the F1 capture capability that targets it. Mirrors the canonical
 * world regions (lab/world.ts) onto the EvidenceRequest capability
 * vocabulary (core/f1-flow.ts F1_CAPABILITY_STEPS maps these onto the
 * focused protocol steps — the same capabilities B5's guided fulfillment
 * uses, so a scientist request fulfills through the EXISTING closed loop).
 */
const REGION_CAPABILITY: Record<string, string> = {
  'face.front': 'face',
  'face.profile': 'face',
  'face.hairline': 'face',
  teeth: 'face',
  hands: 'hands',
  'hair.back': 'hair',
  'silhouette.front': 'silhouette',
  'silhouette.side': 'silhouette',
  walking: 'motion',
  speech: 'speech',
};

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const cut = trimmed.search(/[.!?]/);
  return cut > 0 ? trimmed.slice(0, cut + 1) : trimmed;
}

/**
 * Derive the targeted request from the failure's real data. Every string is
 * built from recorded facts (region, difficulty, seed, suspected cause,
 * remediation) — nothing invented.
 */
export function buildScientistRequest(failure: ScientistFailureInput): ScientistResult {
  const region = typeof failure.inputConditions.region === 'string'
    ? failure.inputConditions.region
    : null;
  if (!region) {
    return {
      refusal:
        'the failure records no region — there is nothing targeted to capture, and a request without a target would be fabricated guidance',
    };
  }
  const capability = REGION_CAPABILITY[region];
  if (!capability) {
    return {
      refusal: `no capture protocol maps region "${region}" — refusing to fabricate guidance for an unmapped region`,
    };
  }

  const cause = firstSentence(failure.suspectedCause || 'the recorded suspected cause');
  const remediation = (failure.remediation ?? '').trim();
  const worldSeed = typeof failure.inputConditions.worldSeed === 'number'
    ? failure.inputConditions.worldSeed
    : null;
  const difficulty = typeof failure.inputConditions.regionDifficulty === 'number'
    ? failure.inputConditions.regionDifficulty
    : null;
  const pct = Number.isFinite(failure.confidence)
    ? Math.round(Math.min(1, Math.max(0, failure.confidence)) * 100)
    : null;

  const instructions = [
    `TARGETED EVIDENCE REQUEST — the Lab's Capture Scientist derived this from a recorded benchmark failure (region "${region}"${worldSeed !== null ? `, world seed ${worldSeed}` : ''}${difficulty !== null ? `, capture difficulty ${difficulty}` : ''}).`,
    `Suspected cause: ${cause}`,
    remediation
      ? `Recorded remediation: ${remediation}`
      : 'No remediation was recorded for this failure — capture the standard targeted evidence for this region.',
    `Focus on the "${capability}" capability: capture ONLY the additional evidence needed to cover this region.`,
  ].join('\n');

  return {
    reason: `Lab-derived targeted evidence for region "${region}" (${pct !== null ? `${pct}% confidence failure` : 'recorded failure'}) — the Capture Scientist requests only what the missing region needs`,
    capability,
    instructions,
    expectedSignal: `Region "${region}" captured in the failing pipeline's next benchmark${worldSeed !== null ? ` on world seed ${worldSeed}` : ''} — the same failure must not reproduce`,
    scope:
      'Scoped to the targeted capture this failure motivates; the covering consent statement governs retention and revocation; no training on biometric data.',
  };
}
