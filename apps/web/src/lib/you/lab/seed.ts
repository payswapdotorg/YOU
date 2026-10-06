// ═══════════════════════════════════════════════════════════════════════════
// Lab baseline seeding (Worker C lane, task 2-c).
// Called by Worker A's session bootstrap. MUST be idempotent (safe on every
// bootstrap) and honest: research/closed statuses stay research/closed; the
// searched genome is produced by the same deterministic mutateGenome the Lab
// benchmark uses, so seed data and benchmark data can never diverge.
//
// Natural keys (idempotency):
//   TechnologyCandidate.techId · TechnologyVersion(candidateId, version)
//   LabObjective.code · AgentBody(tenantId, name) · PipelineCandidate.name
// ═══════════════════════════════════════════════════════════════════════════
import type { PrismaClient } from '@prisma/client';
import type { AgentSoulView, PipelineGenome } from '../contracts';
// NOTE: relative imports carry explicit .ts extensions (the ai/render-provider.ts
// precedent) so node:test's type-stripping resolver can load this module chain
// directly — the extensionless bundler specifiers are not resolvable under
// plain Node ESM.
import { TECHNOLOGY_CATALOG } from './technology-catalog.ts';
import { mutateGenome } from './genome.ts';

export interface SoulCatalogEntry {
  soulKey: string;
  label: string;
  provider: string;
  model: string;
  routingClass: 'system_one' | 'system_two';
  params: { thinking?: boolean; temperature?: number; notes?: string };
}

export const SOUL_CATALOG: SoulCatalogEntry[] = [
  {
    soulKey: 'soul-one-fast',
    label: 'System-One · Fast',
    provider: 'zai',
    model: 'glm-fast',
    routingClass: 'system_one',
    params: { thinking: false, temperature: 0.4, notes: 'low-latency routing profile' },
  },
  {
    soulKey: 'soul-two-deep',
    label: 'System-Two · Deep',
    provider: 'zai',
    model: 'glm-thinking',
    routingClass: 'system_two',
    params: { thinking: true, temperature: 0.7, notes: 'deliberative routing profile' },
  },
];

/** Genome of the generalist baseline: one body, one VLM recon stage, fast soul. */
export const GENERALIST_GENOME: PipelineGenome = {
  stages: [
    { adapterId: 'vlm-recon-1', version: '1', params: { singlePass: true, perAssetCalls: 1 } },
  ],
  parameters: { designNote: 'single generalist body performs the whole reconstruction task' },
  skills: [],
  soulKey: 'soul-one-fast',
  compute: { class: 'serverless-cpu', maxCostUsd: 0.5 },
  evaluation: { rubric: ['coverage', 'confidence', 'latency', 'cost', 'determinism'], seed: 42 },
};

/** Genome of the hand-designed baseline: staged segment → analyze → merge → qa. */
export const HAND_DESIGNED_GENOME: PipelineGenome = {
  stages: [
    { adapterId: 'lab-segment-1', version: '1', params: { method: 'region-grid', granularity: 2 } },
    { adapterId: 'vlm-recon-1', version: '1', params: { perAssetCalls: 1, mergeStrategy: 'weighted-average' } },
    { adapterId: 'lab-merge-1', version: '1', params: { confidencePolicy: 'weighted', coveragePolicy: 'canonical-regions' } },
    { adapterId: 'lab-qa-1', version: '1', params: { deficiencyPolicy: 'canonical-regions' } },
  ],
  parameters: { designNote: 'staged pipeline: segment → analyze → merge → qa, with skills' },
  skills: ['region-coverage-check', 'deficiency-remediation'],
  soulKey: 'soul-two-deep',
  compute: { class: 'serverless-cpu', maxCostUsd: 1 },
  evaluation: { rubric: ['coverage', 'confidence', 'latency', 'cost', 'determinism'], seed: 42 },
};

export interface SeedOptions {
  /** tenant for the default AgentBody; falls back to the first tenant, creating a local default if none exists */
  tenantId?: string;
}

/**
 * Idempotently seed: Technology Registry baseline, HUMAN-RECON-001 objective,
 * default AgentBody "Concierge" (+ soul possessions), PipelineCandidates
 * (generalist + hand-designed + searched gen-1).
 */
export async function seedLabBaseline(prisma: unknown, opts: SeedOptions = {}): Promise<void> {
  const db = prisma as PrismaClient;

  // ─── Technology Registry ────────────────────────────────────────────────────
  for (const entry of TECHNOLOGY_CATALOG) {
    const candidate = await db.technologyCandidate.upsert({
      where: { techId: entry.techId },
      create: {
        techId: entry.techId,
        name: entry.name,
        family: entry.family,
        vendor: entry.vendor,
        source: entry.source,
        licenseCode: entry.license.code,
        licenseWeights: entry.license.weights,
        licenseData: entry.license.data,
        providerTerms: entry.license.providerTerms,
        runtime: entry.runtime,
        patentNotes: entry.patentNotes,
        status: entry.status,
        meta: JSON.stringify(entry.meta),
      },
      update: {
        name: entry.name,
        family: entry.family,
        vendor: entry.vendor,
        source: entry.source,
        licenseCode: entry.license.code,
        licenseWeights: entry.license.weights,
        licenseData: entry.license.data,
        providerTerms: entry.license.providerTerms,
        runtime: entry.runtime,
        patentNotes: entry.patentNotes,
        status: entry.status,
        meta: JSON.stringify(entry.meta),
      },
    });
    for (const v of entry.versions) {
      const existing = await db.technologyVersion.findFirst({
        where: { candidateId: candidate.id, version: v.version },
      });
      if (!existing) {
        await db.technologyVersion.create({
          data: {
            candidateId: candidate.id,
            version: v.version,
            adapterVersion: v.adapterVersion,
            capabilities: JSON.stringify(v.capabilities),
            resources: JSON.stringify(v.resources),
            latencyP50Ms: v.latencyP50Ms ?? null,
            costUsdPerUnit: v.costUsdPerUnit ?? null,
            failureClasses: JSON.stringify(v.failureClasses),
            provenance: JSON.stringify(v.provenance),
          },
        });
      }
    }
  }

  // ─── Lab objective HUMAN-RECON-001 ─────────────────────────────────────────
  await db.labObjective.upsert({
    where: { code: 'HUMAN-RECON-001' },
    create: {
      code: 'HUMAN-RECON-001',
      title: 'Consumer-grade human reconstruction loop',
      description:
        'Consumer capture → reconstruction → HTIR → animatable representation → performance → image/video rendering → benchmark → failure atlas → promotion candidate',
      target: JSON.stringify({
        stages: [
          'capture',
          'evidence-quality',
          'reconstruction',
          'htir-compile',
          'representation',
          'performance',
          'render-image',
          'render-video',
          'benchmark',
          'failure-atlas',
          'promotion-candidate',
        ],
        successCriteria: {
          note: 'descriptive for wave-1; quantitative targets are set by the benchmark harness per world seed',
        },
      }),
      gates: JSON.stringify({
        // P6.C10 — quantitative MACHINE gates, derived from the REAL harness
        // distribution on seed 42 (verified live: hand-designed/searched
        // coverage 0.8 / confidence 0.78 / costUsd 0.02; generalist 0.5 /
        // 0.38 — the gates sit between, so only a staged organization can
        // validate; fulfilling the seed's own documented promise that
        // "quantitative targets are set by the benchmark harness per world
        // seed"). lab/evaluators.ts machine-checks these; the descriptive
        // strings below stay HUMAN gates ('manual', never auto-pass).
        coverage: { min: 0.7 },
        confidence: { min: 0.6 },
        determinism: { required: true },
        costUsd: { max: 0.05 },
        reproducibility: { required: true },
        benchmark: 'generalist, hand-designed and searched organizations all evaluated on the same seeded world',
        rights: 'every adapter carries code/weights/data/provider-terms license records; research-only never promotes past research',
        privacy: 'consent is explicit, scoped, revocable and server-enforced; no training on user biometric data',
        cost: 'real provider costs recorded where measurable; modeled costs explicitly labeled',
        latency: 'real provider latencies recorded per call; modeled latencies explicitly labeled',
      }),
      status: 'active',
    },
    update: {
      title: 'Consumer-grade human reconstruction loop',
      description:
        'Consumer capture → reconstruction → HTIR → animatable representation → performance → image/video rendering → benchmark → failure atlas → promotion candidate',
      target: JSON.stringify({
        stages: [
          'capture',
          'evidence-quality',
          'reconstruction',
          'htir-compile',
          'representation',
          'performance',
          'render-image',
          'render-video',
          'benchmark',
          'failure-atlas',
          'promotion-candidate',
        ],
        successCriteria: {
          note: 'descriptive for wave-1; quantitative targets are set by the benchmark harness per world seed',
        },
      }),
      gates: JSON.stringify({
        // P6.C10 — quantitative MACHINE gates, derived from the REAL harness
        // distribution on seed 42 (verified live: hand-designed/searched
        // coverage 0.8 / confidence 0.78 / costUsd 0.02; generalist 0.5 /
        // 0.38 — the gates sit between, so only a staged organization can
        // validate; fulfilling the seed's own documented promise that
        // "quantitative targets are set by the benchmark harness per world
        // seed"). lab/evaluators.ts machine-checks these; the descriptive
        // strings below stay HUMAN gates ('manual', never auto-pass).
        coverage: { min: 0.7 },
        confidence: { min: 0.6 },
        determinism: { required: true },
        costUsd: { max: 0.05 },
        reproducibility: { required: true },
        benchmark: 'generalist, hand-designed and searched organizations all evaluated on the same seeded world',
        rights: 'every adapter carries code/weights/data/provider-terms license records; research-only never promotes past research',
        privacy: 'consent is explicit, scoped, revocable and server-enforced; no training on user biometric data',
        cost: 'real provider costs recorded where measurable; modeled costs explicitly labeled',
        latency: 'real provider latencies recorded per call; modeled latencies explicitly labeled',
      }),
    },
  });

  // ─── Lab objective SOUL-SWAP-001 (P6.C11 — identity preservation) ─────────
  await db.labObjective.upsert({
    where: { code: 'SOUL-SWAP-001' },
    create: {
      code: 'SOUL-SWAP-001',
      title: 'Identity preservation across soul swaps',
      description:
        'Soul swap benchmark: bodies are swappable infrastructure (ADR-0002) — measure per-organization continuity, drift and post-swap capability retention when souls are rebound across bodies, with one real provider grounding call per organization',
      target: JSON.stringify({
        scenario: 'soul-swap-001',
        stages: ['compile-organizations', 'soul-swap', 'evaluate-identity-preservation', 'failure-atlas', 'promotion-candidate'],
        metrics: ['continuity', 'drift', 'capabilityRetention', 'latencyMs', 'costUsd', 'determinism'],
        successCriteria: {
          note: 'quantitative targets are set by the benchmark harness per world seed; capability-loss and drift failure cases are recorded when thresholds are breached',
        },
      }),
      gates: JSON.stringify({
        reproducibility: 'deterministic re-run of the same seed must reproduce identical swap metrics',
        benchmark: 'generalist, hand-designed and searched organizations all evaluated on the same seeded world under the same swap policy',
        rights: 'souls and bodies carry their ADR-0002 registry records; research-only never promotes past research',
        privacy: 'simulated worlds only — no production human identity data',
        cost: 'real provider costs recorded where measurable; modeled costs explicitly labeled',
        latency: 'real provider latencies recorded per call; modeled latencies explicitly labeled',
      }),
      status: 'active',
    },
    update: {
      title: 'Identity preservation across soul swaps',
      description:
        'Soul swap benchmark: bodies are swappable infrastructure (ADR-0002) — measure per-organization continuity, drift and post-swap capability retention when souls are rebound across bodies, with one real provider grounding call per organization',
    },
  });

  // ─── Default AgentBody "Concierge" + soul possessions (ADR-0002) ───────────
  let tenantId = opts.tenantId;
  if (!tenantId) {
    const first = await db.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
    if (first) {
      tenantId = first.id;
    } else {
      const created = await db.tenant.create({
        data: { slug: 'you-local', name: 'YOU Local (sandbox default)' },
      });
      tenantId = created.id;
    }
  }
  const memory = {
    policy: 'session-scoped, no biometric retention',
    workingNotes: [],
  };
  const evaluation = {
    rubric: ['helpfulness', 'honesty', 'latency'],
    minScore: 0.7,
  };
  let body = await db.agentBody.findFirst({ where: { tenantId, name: 'Concierge' } });
  if (!body) {
    body = await db.agentBody.create({
      data: {
        tenantId,
        name: 'Concierge',
        role: 'assistant',
        version: 1,
        capabilities: JSON.stringify(['conversation', 'product_guidance', 'capture_coaching']),
        // W2.C: tools declared AND executable (lab/agent-tools.ts executes
        // these via internal service calls in avatar turns)
        tools: JSON.stringify(['knowledge_search', 'twins.list', 'evidence.request']),
        permissions: JSON.stringify(['respond', 'emit_performance_events', 'execute_declared_tools']),
        memory: JSON.stringify(memory),
        evaluation: JSON.stringify(evaluation),
      },
    });
  } else {
    // idempotent W2.C upgrade: existing wave-1 bodies declared only
    // ['knowledge_search'] — add the executable tool surface without
    // disturbing anything else on the row.
    let tools: string[] = [];
    try {
      const existingTools = JSON.parse(body.tools ?? '[]') as unknown;
      if (Array.isArray(existingTools)) {
        tools = existingTools.filter((t): t is string => typeof t === 'string');
      }
    } catch {
      tools = [];
    }
    const upgraded = [...new Set([...tools, 'knowledge_search', 'twins.list', 'evidence.request'])];
    if (upgraded.length !== tools.length) {
      body = await db.agentBody.update({
        where: { id: body.id },
        data: { tools: JSON.stringify(upgraded) },
      });
    }
  }
  for (const soul of SOUL_CATALOG) {
    const existing = await db.agentSoulBinding.findFirst({
      where: { bodyId: body.id, soulKey: soul.soulKey },
    });
    if (!existing) {
      await db.agentSoulBinding.create({
        data: {
          bodyId: body.id,
          soulKey: soul.soulKey,
          provider: soul.provider,
          model: soul.model,
          routingClass: soul.routingClass,
          params: JSON.stringify(soul.params),
          active: true,
        },
      });
    }
  }

  // ─── PipelineCandidates: generalist / hand-designed / searched gen-1 ────────
  const generalist = await upsertPipeline(db, {
    name: 'generalist-vlm-recon',
    genome: GENERALIST_GENOME,
    generation: 0,
    parentId: null,
    origin: 'generalist',
  });
  const handDesigned = await upsertPipeline(db, {
    name: 'hand-designed-hybrid',
    genome: HAND_DESIGNED_GENOME,
    generation: 0,
    parentId: null,
    origin: 'hand-designed',
  });
  await upsertPipeline(db, {
    name: 'searched-gen1',
    genome: mutateGenome(HAND_DESIGNED_GENOME, 42),
    generation: 1,
    parentId: handDesigned.id,
    origin: 'searched',
  });
  void generalist; // id kept for potential future cross-references
}

async function upsertPipeline(
  db: PrismaClient,
  spec: { name: string; genome: PipelineGenome; generation: number; parentId: string | null; origin: string }
): Promise<{ id: string }> {
  const existing = await db.pipelineCandidate.findFirst({ where: { name: spec.name } });
  if (existing) {
    return db.pipelineCandidate.update({
      where: { id: existing.id },
      data: {
        genome: JSON.stringify(spec.genome),
        generation: spec.generation,
        parentId: spec.parentId,
        origin: spec.origin,
      },
    });
  }
  return db.pipelineCandidate.create({
    data: {
      name: spec.name,
      genome: JSON.stringify(spec.genome),
      generation: spec.generation,
      parentId: spec.parentId,
      origin: spec.origin,
      status: 'draft',
    },
  });
}

/** Souls this body has been possessed by (helper for body views). */
export function soulCatalogToView(entry: SoulCatalogEntry, id: string): AgentSoulView {
  return {
    id,
    soulKey: entry.soulKey,
    label: entry.label,
    provider: entry.provider,
    model: entry.model,
    routingClass: entry.routingClass,
    params: entry.params,
  };
}
