// ═══════════════════════════════════════════════════════════════════════════
// Pipeline Genome (Worker C lane) — docs/LAB_DESIGN.md "Pipeline Genome":
// a PipelineCandidate is a graph of adapter versions, parameters, skills,
// organizations, Souls, compute and evaluation configuration. The Lab mutates
// this graph and benchmarks offspring.
//
// mutateGenome is fully deterministic: same genome + same seed → same mutant.
// Every mutation is recorded as a human-readable string inside
// `parameters.mutations` so search lineage stays auditable.
// ═══════════════════════════════════════════════════════════════════════════
import type { PipelineGenome } from '../contracts';
// NOTE: relative imports carry explicit .ts extensions (the ai/render-provider.ts
// precedent) so node:test's type-stripping resolver can load this module chain
// directly — the extensionless bundler specifiers are not resolvable under
// plain Node ESM.
import { makeRng, round } from './determinism.ts';

const SYMBOLIC_SUFFIXES = ['-fine', '-coarse', '-v2'] as const;

/**
 * Deterministically mutate a pipeline genome.
 * Mutation operators (Lab search dimensions):
 *  1. numeric parameter jitter (±20%) per stage;
 *  2. occasional symbolic parameter variant (fixed suffix alphabet);
 *  3. structural mutation — add a fallback QA stage or drop a trailing QA stage;
 *  4. compute budget jitter (±10%).
 * The evaluation seed is deliberately preserved for comparability across
 * generations (benchmark reproducibility gate).
 */
export function mutateGenome(genome: PipelineGenome, seed: number): PipelineGenome {
  const rng = makeRng(seed);
  const mutations: string[] = [];

  const stages = genome.stages.map((stage) => {
    const params: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(stage.params)) {
      if (typeof v === 'number') {
        const mutated = round(v * rng.float(0.8, 1.2), 4);
        params[k] = mutated;
        mutations.push(`param ${stage.adapterId}.${k}: ${v} → ${mutated}`);
      } else if (typeof v === 'string' && v.length > 0 && rng.chance(0.25)) {
        const mutated = `${v}${rng.pick(SYMBOLIC_SUFFIXES)}`;
        params[k] = mutated;
        mutations.push(`param ${stage.adapterId}.${k}: "${v}" → "${mutated}"`);
      } else {
        params[k] = v;
      }
    }
    return { ...stage, params };
  });

  if (rng.chance(0.5)) {
    const hasFallback = stages.some((s) => s.adapterId === 'lab-qa-1' && s.params.role === 'fallback');
    if (!hasFallback) {
      stages.push({
        adapterId: 'lab-qa-1',
        version: '1',
        params: { role: 'fallback', recheckPolicy: 'deficiencies-only' },
      });
      mutations.push('structural: added fallback QA stage (lab-qa-1, role=fallback)');
    }
  } else {
    const lastQa = stages.map((s) => s.adapterId).lastIndexOf('lab-qa-1');
    if (lastQa > 0) {
      const removed = stages.splice(lastQa, 1)[0];
      mutations.push(`structural: removed QA stage (${removed.adapterId})`);
    }
  }

  const compute = { ...genome.compute };
  if (typeof compute.maxCostUsd === 'number') {
    const mutated = round(compute.maxCostUsd * rng.float(0.9, 1.1), 4);
    compute.maxCostUsd = mutated;
    mutations.push(`compute.maxCostUsd: → ${mutated}`);
  }

  return {
    ...genome,
    stages,
    parameters: {
      ...genome.parameters,
      mutatedBy: `mutateGenome(seed=${seed})`,
      mutations,
    },
    skills: [...genome.skills],
    compute,
    evaluation: { ...genome.evaluation }, // seed preserved — reproducibility gate
  };
}
