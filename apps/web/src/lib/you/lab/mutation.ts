// ═══════════════════════════════════════════════════════════════════════════
// Pipeline Genome mutation lineage helpers (Worker C lane, P6.C10).
// The mutate route + the lab.mutate executor consume these; the contract
// suite asserts them pure. Deterministic throughout: same parent + same
// mutation seed → the same child (natural key), same scores → the same
// comparison. No db, no clock, no randomness.
// PURE (node:test-importable — runtime import follows the .ts law).
// ═══════════════════════════════════════════════════════════════════════════
import type { JobKind } from '../contracts';
import { clamp, hashString, round } from './determinism.ts';

/**
 * P6.C10 lane-local widening: the frozen contracts JobKind union does not
 * yet include 'lab.mutate'. The value flows through Job.kind rows/views
 * unchanged; TL adds the union member at landing (the tryon.render /
 * export.glb law, core/jobs.ts).
 */
export const LAB_MUTATE_JOB_KIND = 'lab.mutate' as JobKind;

/**
 * Deterministic natural key for an offspring pipeline: same parent name +
 * same mutation seed → the same child name, so repeated mutations of the
 * same (parent, seed) pair REUSE the child row instead of duplicating it.
 */
export function naturalChildName(parentName: string, mutationSeed: number): string {
  const tag = (hashString(`${parentName}::${mutationSeed}`) % 1_000_000).toString(36);
  return `${parentName}-m${tag}`;
}

/** Offspring generation is always parent + 1 (lineage depth). */
export function childGeneration(parentGeneration: number): number {
  return parentGeneration + 1;
}

export interface WeightedScoreInput {
  coverage: number;
  confidence: number;
  determinism: number;
  latencyMs: number;
}

/**
 * The documented weighted formula — mirrors lab/benchmark.ts's ranking
 * verbatim (the same constants, the same latencyScore clamp).
 */
export const WEIGHTED_FORMULA =
  'weightedScore = 0.45\u00b7coverage + 0.35\u00b7confidence + 0.10\u00b7determinism + 0.10\u00b7latencyScore, latencyScore = clamp(1 \u2212 latencyMs/60000, 0, 1)';

export function weightedScore(s: WeightedScoreInput): number {
  return round(
    0.45 * s.coverage +
      0.35 * s.confidence +
      0.1 * s.determinism +
      0.1 * clamp(1 - s.latencyMs / 60_000, 0, 1),
    4,
  );
}

export interface OffspringComparison {
  childBetter: boolean;
  delta: number;
  parentScore: number;
  childScore: number;
  formula: string;
  note: string;
}

/**
 * The honest parent-vs-offspring comparison on the documented weighted
 * formula. latencyMs is a REAL measurement when the grounding call
 * succeeded — with a live provider the verdict can vary between runs (the
 * 0.10 latencyScore weight); modeled-only environments are fully
 * deterministic. Callers never silently flip a loss into a win.
 */
export function compareOffspring(parent: WeightedScoreInput, child: WeightedScoreInput): OffspringComparison {
  const parentScore = weightedScore(parent);
  const childScore = weightedScore(child);
  const childBetter = childScore > parentScore;
  return {
    childBetter,
    delta: round(childScore - parentScore, 4),
    parentScore,
    childScore,
    formula: WEIGHTED_FORMULA,
    note: childBetter
      ? 'offspring wins on the documented weighted formula'
      : childScore === parentScore
        ? 'tie on the documented weighted formula — no auto-draft'
        : 'offspring loses on the documented weighted formula — no auto-draft',
  };
}

export interface MutationLineageSummary {
  parentId: string;
  parentName: string;
  parentGeneration: number;
  childGeneration: number;
  mutationSeed: number;
  mutations: string[];
}

/** The lineage block the lab.mutate executor records in its job output. */
export function lineageSummary(
  parent: { id: string; name: string; generation: number },
  mutationSeed: number,
  mutations: unknown,
): MutationLineageSummary {
  return {
    parentId: parent.id,
    parentName: parent.name,
    parentGeneration: parent.generation,
    childGeneration: childGeneration(parent.generation),
    mutationSeed,
    mutations: Array.isArray(mutations)
      ? mutations.filter((m): m is string => typeof m === 'string')
      : [],
  };
}
