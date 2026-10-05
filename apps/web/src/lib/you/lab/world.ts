// ═══════════════════════════════════════════════════════════════════════════
// Lab World generation (Worker C lane) — docs/LAB_DESIGN.md "World".
// Deterministic by seed, explicitly labeled as SIMULATED research truth:
// a Lab world is never production human truth.
//
// Output conforms to contracts/lab/v1/world.schema.json
// (required: worldId, seed, actors, sensors, groundTruth).
// ═══════════════════════════════════════════════════════════════════════════
import type { LabWorldSpec } from '../contracts';
// NOTE: relative imports carry explicit .ts extensions (the ai/render-provider.ts
// precedent) so node:test's type-stripping resolver can load this module chain
// directly — the extensionless bundler specifiers are not resolvable under
// plain Node ESM.
import { makeRng, round } from './determinism.ts';

export interface WorldActorRegionTruth {
  region: string;
  visible: boolean; // in the actor's ground truth
  difficulty: number; // 0..1 — how hard this region is to capture given the world
}

export interface WorldActor {
  actorId: string;
  archetype: string; // synthetic persona archetype (simulated)
  groundTruth: {
    regions: WorldActorRegionTruth[];
    morphology: { build: string; heightCm: number; ageBand: string; presentation: string };
    appearance: { hair: string; palette: { skin: string; hair: string; eyes: string } };
    geometry: { shoulderRatio: number; headRatio: number };
  };
}

export const WORLD_SIMULATED_LABEL =
  'SIMULATED research truth — Lab world generated deterministically from seed; never production human truth';

const CANONICAL_REGIONS = [
  'face.front', 'face.profile', 'face.hairline', 'teeth',
  'hands', 'hair.back', 'silhouette.front', 'silhouette.side',
  'walking', 'speech',
];

/** Base difficulty of each canonical region (research-heuristic priors, fixed). */
const REGION_DIFFICULTY: Record<string, number> = {
  'face.front': 0.1,
  'face.hairline': 0.3,
  'face.profile': 0.35,
  teeth: 0.55,
  'hair.back': 0.5,
  hands: 0.6,
  'silhouette.front': 0.25,
  'silhouette.side': 0.45,
  walking: 0.7,
  speech: 0.65,
};

const BUILDS = ['slim', 'athletic', 'average', 'stocky'];
const AGE_BANDS = ['young adult', 'adult', 'middle-aged'];
const PRESENTATIONS = ['feminine', 'masculine', 'neutral'];
const HAIR = ['short textured', 'shoulder-length wavy', 'long straight', 'curly medium'];
const SKINS = ['#f0d9c8', '#e8c4a2', '#c8956c', '#a06a42', '#6f4629'];
const HAIR_CS = ['#1c1a17', '#3b2a20', '#5a3d28', '#7a3b22', '#c9a86a', '#b9b6b0'];
const EYES = ['#4a342a', '#4f6d8f', '#5c7a52', '#8a7350'];

/** Deterministically generate a Lab world from `seed`. */
export function generateWorld(seed: number): LabWorldSpec {
  const rng = makeRng(seed);

  const actorCount = rng.int(2, 3);
  const actors: WorldActor[] = [];
  for (let i = 0; i < actorCount; i++) {
    const regionNoise = rng.float(0, 0.25);
    const regions: WorldActorRegionTruth[] = CANONICAL_REGIONS.map((region) => ({
      region,
      visible: true, // ground truth: the person fully exists in the world
      difficulty: round(Math.min(1, REGION_DIFFICULTY[region] + regionNoise * rng.float(0.4, 1)), 3),
    }));
    actors.push({
      actorId: `actor-${seed}-${i + 1}`,
      archetype: rng.pick(['synthetic-pedestrian', 'synthetic-studio-subject', 'synthetic-performer']),
      groundTruth: {
        regions,
        morphology: {
          build: rng.pick(BUILDS),
          heightCm: rng.int(150, 195),
          ageBand: rng.pick(AGE_BANDS),
          presentation: rng.pick(PRESENTATIONS),
        },
        appearance: {
          hair: rng.pick(HAIR),
          palette: { skin: rng.pick(SKINS), hair: rng.pick(HAIR_CS), eyes: rng.pick(EYES) },
        },
        geometry: {
          shoulderRatio: round(rng.float(0.7, 1.4), 3),
          headRatio: round(rng.float(0.75, 1.3), 3),
        },
      },
    });
  }

  const cameraCount = rng.int(1, 3);
  const cameras = Array.from({ length: cameraCount }, (_, i) => ({
    cameraId: `cam-${seed}-${i + 1}`,
    position: rng.pick(['front', 'three-quarter', 'side', 'elevated-front']),
    fovDeg: rng.int(55, 90),
    resolution: rng.pick(['1080p', '1440p', '4K']),
    fps: rng.pick([24, 30, 60]),
    motion: rng.pick(['static', 'handheld', 'slow-orbit']),
  }));

  const lighting = {
    mode: rng.pick(['studio-softbox', 'natural-window', 'mixed']),
    intensity: round(rng.float(0.5, 1), 3),
    directionality: round(rng.float(0.2, 0.9), 3),
  };

  const environment = {
    backdrop: rng.pick(['plain-seamless', 'office', 'outdoor-urban']),
    clutter: round(rng.float(0, 0.6), 3),
  };

  const sensors = [
    { sensorId: `rgb-${seed}-1`, kind: 'rgb-camera', modality: 'image+video' },
    ...(rng.chance(0.4) ? [{ sensorId: `mic-${seed}-1`, kind: 'microphone', modality: 'audio' }] : []),
  ];

  const noise = {
    simulated: true,
    sensorNoise: round(rng.float(0.05, 0.5), 3),
    motionBlur: round(rng.float(0, 0.4), 3),
    compression: round(rng.float(0, 0.3), 3),
  };

  const occlusionCount = rng.int(0, 3);
  const occlusions = Array.from({ length: occlusionCount }, (_, i) => {
    const region = rng.pick(['face.front', 'hands', 'hair.back', 'silhouette.side']);
    return {
      occlusionId: `occ-${seed}-${i + 1}`,
      type: rng.pick(['hand-near-face', 'hair-over-shoulder', 'object-in-frame', 'self-occlusion']),
      affectsRegion: region,
      severity: round(rng.float(0.2, 0.8), 3),
    };
  });

  return {
    worldId: `world-human-recon-${seed}`,
    seed,
    actors: actors as unknown as LabWorldSpec['actors'],
    cameras: cameras as unknown as LabWorldSpec['cameras'],
    lighting: lighting as unknown as LabWorldSpec['lighting'],
    environment: environment as unknown as LabWorldSpec['environment'],
    sensors: sensors as unknown as LabWorldSpec['sensors'],
    noise: noise as unknown as LabWorldSpec['noise'],
    occlusions: occlusions as unknown as LabWorldSpec['occlusions'],
    groundTruth: {
      simulated: true,
      note: WORLD_SIMULATED_LABEL,
      expectedRegions: CANONICAL_REGIONS,
      actorCount,
      perActor: actors.map((a) => ({
        actorId: a.actorId,
        visibleRegionCount: a.groundTruth.regions.filter((r) => r.visible).length,
      })),
    },
  };
}

/** Typed view over the world's actors (the JSON shape keeps them as objects). */
export function worldActors(world: LabWorldSpec): WorldActor[] {
  return world.actors as unknown as WorldActor[];
}
