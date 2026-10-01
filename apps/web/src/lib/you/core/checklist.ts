// ═══════════════════════════════════════════════════════════════════════════
// YOU core — capture checklist builder (Worker A lane)
// Base checklist: face.front, face.profile, silhouette.front, hands, plus
// optional hair.back and speech. When a capture session fulfills an
// EvidenceRequest, the requested capability stays pending and everything
// else is waived (targeted capture, per SECURITY_PRIVACY.md example 3).
// ═══════════════════════════════════════════════════════════════════════════
import type { CaptureChecklistItem, CaptureRegion } from '../contracts';

interface ChecklistSpec {
  item: string;
  capability: string;
  region: CaptureRegion;
  instructions: string;
  expectedSignal: string;
  optional: boolean;
}

export const BASE_CHECKLIST: ChecklistSpec[] = [
  {
    item: 'Frontal face',
    capability: 'face',
    region: 'face.front',
    instructions:
      'Look straight into the camera with a neutral expression, even lighting, hair away from the face. Remove glasses if comfortable.',
    expectedSignal: 'frontal landmarks, facial proportions, skin detail',
    optional: false,
  },
  {
    item: 'Profile face',
    capability: 'face',
    region: 'face.profile',
    instructions:
      'Turn 90° so one ear faces the camera. Keep the jawline and nose silhouette visible against a plain background.',
    expectedSignal: 'profile geometry, nose/jaw depth cues',
    optional: false,
  },
  {
    item: 'Frontal silhouette',
    capability: 'silhouette',
    region: 'silhouette.front',
    instructions:
      'Stand at full height facing the camera, arms slightly away from the body, fitted clothing, plain background.',
    expectedSignal: 'body proportions, shoulder/hip ratios',
    optional: false,
  },
  {
    item: 'Hands',
    capability: 'hands',
    region: 'hands',
    instructions:
      'Show both hands: palms open toward the camera, then backs of the hands, fingers relaxed and spread. Optional but improves articulation.',
    expectedSignal: 'hand geometry, finger articulation range',
    optional: true,
  },
  {
    item: 'Back of hair',
    capability: 'hair',
    region: 'hair.back',
    instructions:
      'Turn away from the camera to capture the back of your head and hairline. Optional — needed for high hair coverage.',
    expectedSignal: 'hair coverage, hairline geometry',
    optional: true,
  },
  {
    item: 'Speech sample',
    capability: 'speech',
    region: 'speech',
    instructions:
      'Read a short passage aloud on camera (≈20s), natural pace. Optional — enables voice and mouth-motion profiles.',
    expectedSignal: 'viseme/voice profile, mouth articulation',
    optional: true,
  },
];

export interface ChecklistOptions {
  /** when fulfilling an EvidenceRequest: the requested capability */
  focusCapability?: string;
  requestReason?: string;
  requestInstructions?: string;
  requestExpectedSignal?: string;
}

export function buildChecklist(opts: ChecklistOptions = {}): CaptureChecklistItem[] {
  const focus = opts.focusCapability?.trim();
  const items: CaptureChecklistItem[] = BASE_CHECKLIST.map((spec) => {
    // focus matches either the family capability ("face") or the exact region
    // ("face.profile") — deficiencies and evidence requests use region-style
    // capability ids, so both forms must resolve to the focused item
    const focused = !!focus && (spec.capability === focus || spec.region === focus);
    return {
      item: spec.item,
      capability: spec.capability,
      region: spec.region,
      instructions: focused && opts.requestInstructions
        ? `${opts.requestInstructions}${opts.requestReason ? ` (requested because: ${opts.requestReason})` : ''}`
        : spec.instructions,
      status: focus ? (focused ? 'pending' : 'waived') : 'pending',
      expectedSignal: focused && opts.requestExpectedSignal ? opts.requestExpectedSignal : spec.expectedSignal,
    };
  });

  // a requested capability outside the base checklist gets a custom item
  if (focus && !BASE_CHECKLIST.some((s) => s.capability === focus || s.region === focus)) {
    items.push({
      item: `Requested: ${focus}`,
      capability: focus,
      region: 'custom',
      instructions: opts.requestInstructions ?? `Capture additional evidence for capability "${focus}".`,
      status: 'pending',
      expectedSignal: opts.requestExpectedSignal ?? `signal supporting ${focus}`,
    });
  }

  return items;
}

/** Mark checklist items covered by an upload's regions as provided. */
export function markProvided(
  checklist: CaptureChecklistItem[],
  regions: CaptureRegion[],
): CaptureChecklistItem[] {
  return checklist.map((item) =>
    item.status === 'pending' && regions.includes(item.region) ? { ...item, status: 'provided' } : item,
  );
}
