// ═══════════════════════════════════════════════════════════════════════════
// Organization Compiler (Worker C lane) — docs/LAB_DESIGN.md:
// Task -> required capabilities -> candidate roles -> body graph ->
// tools/skills -> Soul assignment -> budget/latency policy.
//
// Always benchmark three baselines: generalist, hand-designed, searched.
// Bodies are compiled FROM the pipeline genome (data-driven: one body per
// genome stage), so a mutated genome compiles to a mutated organization.
// Souls are assigned per ADR-0002 (bodies are swappable infrastructure).
// ═══════════════════════════════════════════════════════════════════════════
import type { OrganizationDescriptor, PipelineGenome } from '../contracts';

export interface PipelineRef {
  id: string;
  name: string;
  genome: PipelineGenome;
}

export interface CompiledOrganization {
  descriptor: OrganizationDescriptor;
  genome: PipelineGenome;
}

const STAGE_CAPABILITIES: Record<string, string[]> = {
  'lab-segment-1': ['segmentation', 'region-coverage-check'],
  'vlm-recon-1': ['appearance-analysis', 'morphology-estimation', 'evidence-quality'],
  'lab-merge-1': ['evidence-merge', 'confidence-aggregation'],
  'lab-qa-1': ['qa-gating', 'deficiency-detection'],
};

const STAGE_ROLE: Record<string, string> = {
  'lab-segment-1': 'segmenter',
  'vlm-recon-1': 'analyzer',
  'lab-merge-1': 'merger',
  'lab-qa-1': 'qa',
};

/** The analysis stage gets the deliberative soul; infrastructure stages the fast soul. */
export const STAGE_SOUL: Record<string, string> = {
  'vlm-recon-1': 'soul-two-deep',
  'lab-segment-1': 'soul-one-fast',
  'lab-merge-1': 'soul-one-fast',
  'lab-qa-1': 'soul-two-deep',
};

/**
 * Compile ONE organization from a genome (P6.C10: exported — the lab.mutate
 * executor's two-org benchmark path compiles the parent and the offspring
 * directly, without the three-baseline scaffolding).
 */
export function compileFromGenome(
  genome: PipelineGenome,
  origin: OrganizationDescriptor['origin'],
  organizationId: string,
  label: string,
  pipelineId: string
): CompiledOrganization {
  const bodies = genome.stages.map((stage, i) => {
    const isFallbackQa = stage.adapterId === 'lab-qa-1' && stage.params.role === 'fallback';
    return {
      role: isFallbackQa ? 'qa-fallback' : (STAGE_ROLE[stage.adapterId] ?? `stage-${i + 1}`),
      capabilities: STAGE_CAPABILITIES[stage.adapterId] ?? [`stage-${stage.adapterId}`],
      soulKey: STAGE_SOUL[stage.adapterId] ?? 'soul-one-fast',
    };
  });
  return {
    descriptor: { organizationId, label, origin, bodies, pipelineId },
    genome,
  };
}

/**
 * Compile the three mandatory baselines. `seed` is recorded for audit; the
 * organization structure itself is fully determined by the pipeline genomes
 * (the searched genome was produced by mutateGenome with its own fixed seed).
 */
export function compileOrganizations(
  _seed: number,
  pipelines: { generalist: PipelineRef; handDesigned: PipelineRef; searched: PipelineRef }
): CompiledOrganization[] {
  void _seed; // recorded by callers in benchmark detail; structure is genome-driven
  return [
    compileFromGenome(
      pipelines.generalist.genome,
      'generalist',
      'org-generalist-vlm-recon',
      'Generalist — single VLM recon body (generalist-vlm-recon)',
      pipelines.generalist.id
    ),
    compileFromGenome(
      pipelines.handDesigned.genome,
      'hand-designed',
      'org-hand-designed-hybrid',
      'Hand-designed — staged segment → analyze → merge → qa (hand-designed-hybrid)',
      pipelines.handDesigned.id
    ),
    compileFromGenome(
      pipelines.searched.genome,
      'searched',
      'org-searched-gen1',
      'Searched gen-1 — mutated hand-designed genome (searched-gen1)',
      pipelines.searched.id
    ),
  ];
}
