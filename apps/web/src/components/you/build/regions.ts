// Capture region vocabulary + capability→evidence-request presets.
// Region labels are presentation-only; values are the frozen contract values.
import type { CaptureRegion } from '@/lib/you/contracts';

export const REGION_OPTIONS: { value: CaptureRegion; label: string }[] = [
  { value: 'face.front', label: 'Face — front' },
  { value: 'face.profile', label: 'Face — profile' },
  { value: 'face.hairline', label: 'Face — hairline' },
  { value: 'teeth', label: 'Teeth' },
  { value: 'hands', label: 'Hands' },
  { value: 'hair.back', label: 'Hair — back' },
  { value: 'silhouette.front', label: 'Silhouette — front' },
  { value: 'silhouette.side', label: 'Silhouette — side' },
  { value: 'walking', label: 'Walking (video)' },
  { value: 'speech', label: 'Speech (audio)' },
  { value: 'custom', label: 'Custom' },
];

export function regionLabel(region: string): string {
  return REGION_OPTIONS.find((r) => r.value === region)?.label ?? region;
}

/**
 * Prefill presets for targeted evidence requests derived from an HTIR
 * confidence deficiency (docs/SOLUTION_ARTIFACT.md "Targeted evidence").
 * Keys are matched by substring against the deficiency capability.
 */
export interface EvidencePreset {
  instructions: string;
  expectedSignal: string;
}

const CAPABILITY_PRESETS: { match: RegExp; preset: EvidencePreset }[] = [
  { match: /face\.profile|profile/i, preset: { instructions: 'Capture a clear side-profile photo of the face: full head and neck visible, neutral expression, eyes open, even lighting, no hair covering the profile line.', expectedSignal: 'A sharp lateral head outline — nose, chin and forehead contour clearly delimited against a plain background.' } },
  { match: /face\.front|front/i, preset: { instructions: 'Capture a front-facing photo of the face: neutral expression, eyes open looking at the camera, even lighting, no occlusions.', expectedSignal: 'A sharp frontal view with both eyes, full face oval and hairline visible.' } },
  { match: /hair/i, preset: { instructions: 'Capture the hair from behind and from the side, showing hairline, volume and length under even lighting.', expectedSignal: 'Hair coverage, color under neutral light and silhouette from back/side views.' } },
  { match: /teeth/i, preset: { instructions: 'Capture a photo of the person smiling naturally with teeth visible, face well lit.', expectedSignal: 'Visible upper and lower teeth arrangement for dental detail reconstruction.' } },
  { match: /hand/i, preset: { instructions: 'Capture photos of both hands: palms and backs, fingers spread naturally, close enough to resolve finger detail.', expectedSignal: 'Resolvable finger geometry and knuckle detail from multiple angles.' } },
  { match: /silhouette|body|shape|proportion/i, preset: { instructions: 'Capture front and side full-body photos against a plain background, arms relaxed at the sides, form-fitting clothing.', expectedSignal: 'Clean body outline for anthropometric measurement from two orthogonal views.' } },
  { match: /walk|gait|motion|movement/i, preset: { instructions: 'Record a short video (5–10 s) of the person walking naturally toward and past the camera.', expectedSignal: 'A full gait cycle — stride, posture and arm swing visible.' } },
  { match: /speech|voice/i, preset: { instructions: 'Record 20–30 s of natural speech in a quiet room, at a consistent distance from the microphone.', expectedSignal: 'Clean audio with pitch, pace and articulation characteristics.' } },
  { match: /skin|appearance|texture/i, preset: { instructions: 'Capture close-up, evenly lit photos of the face and hands without makeup artifacts or strong shadows.', expectedSignal: 'Skin texture and tone sampled under neutral lighting.' } },
];

export function evidencePresetFor(capability: string, remediation: string): EvidencePreset {
  const hit = CAPABILITY_PRESETS.find((c) => c.match.test(capability));
  if (hit) return hit.preset;
  return {
    instructions: remediation || `Capture additional evidence covering "${capability}".`,
    expectedSignal: `Signal that improves the "${capability}" capability.`,
  };
}
