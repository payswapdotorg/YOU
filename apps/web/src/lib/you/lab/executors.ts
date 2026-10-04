// ═══════════════════════════════════════════════════════════════════════════
// Job executor registry — Worker C implementations (task 2-c).
// The exported API (registerExecutor / getExecutor / listExecutors) is the
// frozen seam consumed by Worker A's job runner and stays identical.
//
// Honesty rules enforced throughout:
// - progress advances ONLY on real completion signals (per stage / per asset);
// - provider errors surface verbatim (wrapped errors keep the cause message);
// - consent is server-enforced (reconstruct for twin.compile, render for
//   render.image / render.video) — missing consent fails the job honestly;
// - every persisted Lab number carries its simulated/modeled/real label;
// - events + usage are inserted directly (see lab/events.ts note for TL).
// ═══════════════════════════════════════════════════════════════════════════
import { db } from '@/lib/db';
import type {
  CaptureRegion,
  ConsentScope,
  EvidenceQuality,
  HTIR,
  JobContext,
  JobExecutor,
  JobKind,
  JobStep,
  RenderStyle,
  SolutionArtifactManifest,
} from '../contracts';
import { signStorageUrl, putObject, deleteObject, listObjectKeys, getObject } from '../core/storage';
import {
  analyzeAssetQuality,
  analyzeAssetReconstruction,
  aggregateHtirDraft,
  analyzeEvidenceSet,
  VLM_RECON_ADAPTER,
  type VlmReconAssetInput,
} from '../adapters/vlm-recon';
import { renderPortraitSvg, SVG_PORTRAIT_ADAPTER } from '../adapters/svg-portrait';
import { renderPortraitImage, AI_IMAGE_ADAPTER, buildImagePrompt } from '../adapters/ai-image';
import { renderPortraitVideo, AI_VIDEO_ADAPTER } from '../adapters/ai-video';
import { chatComplete } from '../ai/zai';
import { reconResolution } from '../ai/recon-provider';
import {
  F1_RECONSTRUCT_JOB_KIND,
  F1_RECON_ADAPTER,
  F1TypedRefusal,
  buildF1ProvenanceBlock,
  runF1Reconstruction,
  type F1EvidenceRecord,
  type F1ProgressEvent,
  type F1ReconstructionInput,
  type F1ReconstructionResult,
  type F1VisionDeps,
  type F1Htir,
} from './f1-recon';
import { emitEvent, recordLlmCalls, recordUsage } from './events';
// P6.C6 — Agent Body/Soul production runtime: the durable agent.turn
// executor (lib/you/agent/runtime-core.ts engine + Prisma + the real seams).
// LIVES HERE (not lib/you/agent/runtime.ts) to break the import cycle
// executors → agent/runtime → core/jobs → executors — the executor home is
// also where every other executor in this file lives.
import {
  AGENT_TURN_JOB_KIND,
  deriveTurnSeed,
  normalizeBehaviorParams,
  normalizePersona,
  parseManifest,
  runAgentTurnEngine,
  type AgentCapabilityManifest,
  type AgentSoulBehaviorParams,
  type AgentSoulPersona,
} from '../agent/runtime-core';
// P6.C7 — the agent → live bridge: stream turn states into live sessions
// bound to this agent session (low-latency path, fully separate from offline
// rendering). BEST-EFFORT law lives inside live/runtime.ts — a live push can
// never fail the durable agent turn. No import cycle: live/runtime touches
// core/consent + core/events + db only (not jobs/executors).
import {
  pushAgentStatesToLiveSessions,
  pushAgentTurnEventToLiveSessions,
} from '../live/runtime';
import { executeAgentTool } from './agent-tools';
import { requireConsent } from '../core/consent';
// P6.B6 — Solution Artifact manifest v2 section builders (pure core).
import {
  bindArtifactId,
  buildPerformanceSections,
  buildRenderSections,
  buildTwinCompileSections,
} from '../core/artifact-sections';
import { generateWorld } from './world';
import { compileOrganizations, type PipelineRef } from './organization-compiler';
import { evaluateOrganizations } from './benchmark';
import { quoteCompute, LOCAL_EXECUTOR_PROVIDER_ID, routedRenderProvider, embeddedComputeRoutingOf, type ComputeQuote, type ComputeSubmission } from './compute';
import { recordRegionFailures } from './failure-atlas';
import { hashString, makeRng } from './determinism';

const registry = new Map<JobKind, JobExecutor>();

export function registerExecutor(executor: JobExecutor): void {
  registry.set(executor.kind, executor);
}

export function getExecutor(kind: JobKind): JobExecutor | undefined {
  return registry.get(kind);
}

export function listExecutors(): JobKind[] {
  return [...registry.keys()];
}

// ─── shared helpers ──────────────────────────────────────────────────────────

class Steps {
  private steps: JobStep[];
  constructor(defs: Array<[string, string]>) {
    this.steps = defs.map(([key, label]) => ({ key, label, status: 'pending' as const }));
  }
  private find(key: string): JobStep {
    const s = this.steps.find((x) => x.key === key);
    if (!s) throw new Error(`unknown step key ${key}`);
    return s;
  }
  running(key: string, detail?: string): JobStep[] {
    const s = this.find(key);
    s.status = 'running';
    if (detail) s.detail = detail;
    return this.all();
  }
  done(key: string, detail?: string): JobStep[] {
    const s = this.find(key);
    s.status = 'done';
    if (detail) s.detail = detail;
    return this.all();
  }
  failed(key: string, detail?: string): JobStep[] {
    const s = this.find(key);
    s.status = 'failed';
    if (detail) s.detail = detail;
    return this.all();
  }
  all(): JobStep[] {
    return this.steps.map((s) => ({ ...s }));
  }
}

function reqString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`validation_failed: input.${key} (string) is required`);
  }
  return v;
}

function optString(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function parseJsonField<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function activeGrantsFor(subjectId: string, tenantId: string, scope: ConsentScope) {
  const now = new Date();
  const grants = await db.consentGrant.findMany({
    where: { tenantId, subjectId, revokedAt: null, expiresAt: { gt: now } },
  });
  return grants.filter((g) => parseJsonField<string[]>(g.scopes, []).includes(scope));
}

function assertConsent(grants: unknown[], subjectId: string, scope: ConsentScope): void {
  if (grants.length === 0) {
    throw new Error(
      `consent_required: no active ${scope}-scope consent grant for subject ${subjectId} — reconstruction/rendering refused (server-enforced)`
    );
  }
}

const FEEDBACK_VERDICTS = [
  'correct', 'incorrect', 'uncertain', 'missing-detail', 'wrong-motion', 'wrong-identity', 'wrong-style',
] as const;

const REVIEW_REGIONS = ['face.hairline', 'face.profile', 'hands', 'hair', 'silhouette', 'teeth'] as const;

const RENDER_STYLES: RenderStyle[] = [
  'photorealistic', 'anime', 'cartoon', 'low-poly', 'game', 'illustration', 'stylized-portrait',
];

function parseStyle(v: unknown, fallback: RenderStyle = 'stylized-portrait'): RenderStyle {
  return typeof v === 'string' && (RENDER_STYLES as string[]).includes(v) ? (v as RenderStyle) : fallback;
}

async function loadPipelineByName(name: string) {
  const p = await db.pipelineCandidate.findFirst({ where: { name } });
  if (!p) {
    throw new Error(
      `not_found: PipelineCandidate "${name}" is missing — run seedLabBaseline before compiling twins (refusing to reference a non-existent pipeline)`
    );
  }
  return p;
}

// ═══════════════════════════════════════════════════════════════════════
// W2.C compute-broker bookkeeping (work item C3)
// The three broker-routed workloads (render.image, render.video, twin.compile)
// record quote/latency/cost fields in the durable job records:
// - the QUOTE comes from submit-time (broker-submitted jobs carry it embedded
//   in Job.input.__compute) or is quoted at execution start through the
//   broker (route-submitted jobs — the API routes call core createJob
//   directly; phase labeled honestly either way);
// - OBSERVED latency/cost come from the real execution (measured, or
//   explicitly labeled not-observable when the provider hides pricing);
// - every cost carries its basis; nothing modeled masquerades as observed.
// The quote summary also lands in the step detail (durable even on failure).
// ═══════════════════════════════════════════════════════════════════════

export interface ExecutorComputeRecord {
  broker: 'compute-broker/w2c';
  providerId: string;
  routedVia: string;
  quotePhase: string;
  quote: ComputeQuote | null;
  quoteError?: string;
  observed: {
    latencyMs: number | null;
    costUsd: number | null;
    costBasis: string;
    note: string;
  };
}

async function executionComputeQuote(
  kind: 'render.image' | 'render.video' | 'twin.compile',
  ctx: JobContext,
  input: Record<string, unknown>,
  adapter?: string
): Promise<{ quote: ComputeQuote | null; phase: string; error?: string }> {
  const embedded = input.__compute as { quote?: ComputeQuote; quotePhase?: string } | undefined;
  if (embedded && embedded.quote) {
    return { quote: embedded.quote, phase: embedded.quotePhase ?? 'submit-time' };
  }
  try {
    // tenantId/adapter are the extended ComputeSubmission fields (the frozen
    // ComputeRequest shape stays untouched — they drive observed-history lookups)
    const request = {
      workload: kind,
      tenantId: ctx.tenantId,
      ...(adapter ? { adapter } : {}),
    } as ComputeSubmission;
    const quote = await quoteCompute(request);
    return {
      quote,
      phase:
        'execution-start (job was submitted via core createJob by the API route; broker-integrated submission is available via submitCompute)',
    };
  } catch (e) {
    return {
      quote: null,
      phase: 'execution-start',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function computeRecord(
  quoteResult: { quote: ComputeQuote | null; phase: string; error?: string },
  observed: ExecutorComputeRecord['observed'],
  routing: { providerId: string; routedVia: string }
): ExecutorComputeRecord {
  return {
    broker: 'compute-broker/w2c',
    providerId: routing.providerId,
    routedVia: routing.routedVia,
    quotePhase: quoteResult.phase,
    quote: quoteResult.quote,
    ...(quoteResult.error ? { quoteError: quoteResult.error } : {}),
    observed,
  };
}

/**
 * P6.C3: the honest routing labels for the compute record — the provider the
 * broker actually routed to (embedded in Job.input.__compute), falling back
 * to the local-executor truth for route-submitted jobs.
 */
function routingLabels(input: Record<string, unknown>): { providerId: string; routedVia: string } {
  const embedded = embeddedComputeRoutingOf(input);
  if (embedded !== null) {
    return {
      providerId: embedded.providerId,
      routedVia: embedded.routedVia ?? `compute-broker routing (embedded record, provider ${embedded.providerId})`,
    };
  }
  return {
    providerId: LOCAL_EXECUTOR_PROVIDER_ID,
    routedVia: 'in-process executor via the durable job runner (local-executor provider)',
  };
}

function quoteSummary(quote: ComputeQuote | null, phase: string): string {
  if (!quote) return `broker quote unavailable (phase ${phase})`;
  return `local-executor · cost $${quote.cost.usd} (${quote.cost.basis}) · latency p50 ${quote.latency.p50EstimateMs}ms (${quote.latency.basis}${quote.latency.observedRuns ? `, n=${quote.latency.observedRuns}` : ''}) · quoted ${phase}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// capture.quality — analyze evidence set → quality + deficiencies
// ═══════════════════════════════════════════════════════════════════════════

const REGION_EXPECTED_SIGNAL: Record<string, string> = {
  'face.front': 'front-facing facial geometry clearly visible, even lighting',
  'face.profile': 'profile contour (nose, chin, jaw) visible at 45–90° head turn',
  'face.hairline': 'forehead and hairline visible (hair pulled back if possible)',
  teeth: 'brief natural smile showing teeth',
  hands: 'palms and finger geometry visible, fingers spread',
  'hair.back': 'rear hair volume and back hairline visible',
  'silhouette.front': 'full-body front outline against a plain background',
  'silhouette.side': 'full-body side outline against a plain background',
};

const REGION_INSTRUCTIONS: Record<string, string> = {
  'face.front': 'Capture a front-facing photo of the face, neutral expression, even lighting.',
  'face.profile': 'Capture a ¾ or full side-profile photo of the face (head turned 45–90°).',
  'face.hairline': 'Capture a front photo with the forehead/hairline visible.',
  teeth: 'Capture a short clip with a natural smile briefly showing teeth.',
  hands: 'Capture a photo or short clip with palms visible and fingers spread at chest height.',
  'hair.back': 'Capture a rear-view photo of the head showing hair volume and the back hairline.',
  'silhouette.front': 'Capture a full-body front-facing photo against a plain background.',
  'silhouette.side': 'Capture a full-body side-view photo against a plain background.',
};

registerExecutor({
  kind: 'capture.quality',
  async execute(input, ctx) {
    const sessionId = reqString(input, 'captureSessionId');
    const steps = new Steps([
      ['load', 'Load capture session and assets'],
      ['analyze', 'VLM quality analysis per asset'],
      ['deficiencies', 'Aggregate coverage deficiencies'],
      ['requests', 'Create targeted evidence requests'],
      ['complete', 'Complete session'],
    ]);

    await ctx.report({ steps: steps.running('load'), progress: 0.05, status: 'running' });
    const session = await db.captureSession.findUnique({
      where: { id: sessionId },
      include: { assets: true, twin: true },
    });
    if (!session) throw new Error(`not_found: capture session ${sessionId}`);
    if (session.tenantId !== ctx.tenantId) throw new Error(`forbidden: session belongs to another tenant`);
    steps.done('load', `${session.assets.length} assets`);
    await ctx.report({ steps: steps.all(), progress: 0.1 });

    const imageAssets = session.assets.filter((a) => a.kind === 'image' && a.mime.startsWith('image/'));
    const otherAssets = session.assets.filter((a) => !imageAssets.includes(a));
    let llmCalls = 0;
    const analyzed: string[] = [];
    let i = 0;
    for (const asset of imageAssets) {
      i += 1;
      await ctx.report({
        steps: steps.running('analyze', `asset ${asset.id} (${i}/${imageAssets.length})`),
        progress: 0.1 + 0.7 * ((i - 1) / Math.max(1, imageAssets.length)),
      });
      const result = await analyzeAssetQuality({
        id: asset.id,
        storageKey: asset.storageKey,
        mime: asset.mime,
        regions: parseJsonField<CaptureRegion[]>(asset.regions, []),
      });
      llmCalls += 1;
      await db.evidenceAsset.update({
        where: { id: asset.id },
        data: { quality: JSON.stringify(result.quality) },
      });
      analyzed.push(asset.id);
      steps.done('analyze', `${i}/${imageAssets.length} analyzed (last latency ${result.latencyMs}ms)`);
      await ctx.report({ steps: steps.all(), progress: 0.1 + 0.7 * (i / Math.max(1, imageAssets.length)) });
    }
    if (imageAssets.length === 0) {
      steps.done('analyze', 'no image assets to analyze');
      await ctx.report({ steps: steps.all(), progress: 0.8 });
    }

    // coverage = VLM-observed ∪ declared regions; unanalyzed (non-image) assets
    // contribute their DECLARED regions only — no fabricated observations.
    await ctx.report({ steps: steps.running('deficiencies'), progress: 0.82 });
    const covered = new Set<CaptureRegion>();
    for (const asset of session.assets) {
      const q = asset.quality ? parseJsonField<EvidenceQuality | null>(asset.quality, null) : null;
      if (q) for (const r of q.coverage) covered.add(r);
      for (const r of parseJsonField<CaptureRegion[]>(asset.regions, [])) covered.add(r);
    }
    const important: CaptureRegion[] = [
      'face.front', 'face.profile', 'face.hairline', 'teeth',
      'hands', 'hair.back', 'silhouette.front', 'silhouette.side',
    ];
    const deficiencies = important.filter((r) => !covered.has(r));
    steps.done('deficiencies', `${deficiencies.length} uncovered important regions`);
    await ctx.report({ steps: steps.all(), progress: 0.87 });

    await ctx.report({ steps: steps.running('requests'), progress: 0.9 });
    const evidenceRequestIds: string[] = [];
    for (const region of deficiencies) {
      const reason = `Capture session ${session.id} (twin ${session.twinId}) did not cover region "${region}" — detected by capture.quality analysis.`;
      const existing = await db.evidenceRequest.findFirst({ where: { capability: region, reason, status: 'open' } });
      if (existing) {
        evidenceRequestIds.push(existing.id);
        continue;
      }
      const req = await db.evidenceRequest.create({
        data: {
          tenantId: session.tenantId,
          reason,
          capability: region,
          instructions: REGION_INSTRUCTIONS[region] ?? `Capture additional evidence covering "${region}".`,
          expectedSignal: REGION_EXPECTED_SIGNAL[region] ?? `clear visibility of ${region}`,
          scope: 'single-capture, derived-outputs-only',
          status: 'open',
        },
      });
      evidenceRequestIds.push(req.id);
    }
    steps.done('requests', `${evidenceRequestIds.length} requests`);
    await ctx.report({ steps: steps.all(), progress: 0.95 });

    const now = new Date();
    await db.captureSession.update({
      where: { id: session.id },
      data: { status: 'complete', completedAt: now },
    });
    if (session.twin && session.twin.status === 'draft') {
      await db.twin.update({ where: { id: session.twinId }, data: { status: 'capturing' } });
    }
    steps.done('complete');
    await ctx.report({ steps: steps.all(), progress: 1 });

    await emitEvent(ctx.tenantId, 'capture.completed', 'captureSession', session.id, {
      assetsAnalyzed: analyzed.length,
      assetsSkippedMachineAnalysis: otherAssets.length,
      deficiencies,
      evidenceRequestIds,
      llmCalls,
      note: 'non-image assets (if any) were not machine-analyzed in wave-1; their declared regions count toward coverage only',
    });
    await recordLlmCalls(ctx.tenantId, llmCalls, { jobKind: 'capture.quality', captureSessionId: session.id });
    await recordUsage(ctx.tenantId, 'job.capture.quality', 1, { captureSessionId: session.id });

    return {
      output: {
        captureSessionId: session.id,
        assetsAnalyzed: analyzed.length,
        assetsSkippedMachineAnalysis: otherAssets.length,
        deficiencies,
        evidenceRequestIds,
      },
      entities: [
        { type: 'captureSession', id: session.id },
        ...evidenceRequestIds.map((id) => ({ type: 'evidenceRequest', id })),
      ],
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// twin.compile — evidence → HTIR → published TwinVersion + twin-review artifact
// ═══════════════════════════════════════════════════════════════════════════

registerExecutor({
  kind: 'twin.compile',
  async execute(input, ctx) {
    const twinId = reqString(input, 'twinId');
    const captureSessionId = optString(input, 'captureSessionId');
    const style = parseStyle(input.style);
    const steps = new Steps([
      ['load', 'Load twin'],
      ['consent', 'Verify reconstruct consent (server-enforced)'],
      ['evidence', 'Load evidence assets'],
      ['analyze', 'VLM evidence-set analysis (vlm-recon-1)'],
      ['compile', 'Compile HTIR v1'],
      ['persist', 'Publish immutable TwinVersion'],
      ['artifact', 'Create twin-review Solution Artifact'],
    ]);

    await ctx.report({ steps: steps.running('load'), progress: 0.05, status: 'running' });
    const twin = await db.twin.findUnique({ where: { id: twinId } });
    if (!twin) throw new Error(`not_found: twin ${twinId}`);
    if (twin.tenantId !== ctx.tenantId) throw new Error(`forbidden: twin belongs to another tenant`);
    steps.done('load');
    await ctx.report({ steps: steps.all(), progress: 0.1 });

    await ctx.report({ steps: steps.running('consent'), progress: 0.12 });
    const grants = await activeGrantsFor(twin.subjectId, twin.tenantId, 'reconstruct');
    assertConsent(grants, twin.subjectId, 'reconstruct');
    const grantIds = grants.map((g) => g.id);
    steps.done('consent', `${grantIds.length} active grant(s)`);
    await ctx.report({ steps: steps.all(), progress: 0.15 });

    await ctx.report({ steps: steps.running('evidence'), progress: 0.18 });
    let assets;
    if (captureSessionId) {
      const session = await db.captureSession.findUnique({
        where: { id: captureSessionId },
        include: { assets: true },
      });
      if (!session) throw new Error(`not_found: capture session ${captureSessionId}`);
      if (session.twinId !== twinId) throw new Error(`validation_failed: session ${captureSessionId} belongs to twin ${session.twinId}`);
      if (session.status !== 'complete') {
        throw new Error(
          `validation_failed: capture session ${captureSessionId} status is "${session.status}" — run capture.quality first (refusing to compile from incomplete evidence)`
        );
      }
      assets = session.assets;
    } else {
      const sessions = await db.captureSession.findMany({
        where: { twinId, status: 'complete' },
        include: { assets: true },
      });
      assets = sessions.flatMap((s) => s.assets);
    }
    if (!assets || assets.length === 0) {
      throw new Error(
        `validation_failed: no evidence assets found for twin ${twinId}${captureSessionId ? ` in session ${captureSessionId}` : ' across complete sessions'} — nothing to reconstruct`
      );
    }
    steps.done('evidence', `${assets.length} assets`);
    await ctx.report({ steps: steps.all(), progress: 0.22 });

    // W2.C compute-broker bookkeeping: quote for the routed workload (durable
    // in the job record; step detail carries the summary even on failure).
    const computeQuote = await executionComputeQuote('twin.compile', ctx, input);
    steps.running('analyze', `${assets.length} assets — ${quoteSummary(computeQuote.quote, computeQuote.phase)}`);
    await ctx.report({ steps: steps.all(), progress: 0.25 });
    const vlmAssets: VlmReconAssetInput[] = assets.map((a) => ({
      id: a.id,
      storageKey: a.storageKey,
      mime: a.mime,
      regions: parseJsonField<CaptureRegion[]>(a.regions, []),
    }));
    const analysis = await analyzeEvidenceSet(vlmAssets, style);
    steps.done('analyze', `${analysis.usage.llmCalls} VLM calls, ${analysis.usage.totalLatencyMs}ms total`);
    await ctx.report({ steps: steps.all(), progress: 0.6 });

    await ctx.report({ steps: steps.running('compile'), progress: 0.65 });
    const pipeline = await loadPipelineByName('hand-designed-hybrid');
    const version = twin.currentVersion + 1;
    const htir: HTIR = {
      twinId: twin.id,
      version,
      morphology: analysis.htirDraft.morphology,
      geometry: analysis.htirDraft.geometry,
      appearance: analysis.htirDraft.appearance,
      articulation: analysis.htirDraft.articulation,
      neuralAppearance: analysis.htirDraft.neuralAppearance,
      motionProfile: analysis.htirDraft.motionProfile,
      voice: null,
      styleProfiles: [{ style, params: { seed: 42 } }],
      confidence: analysis.htirDraft.confidence,
      provenance: {
        subjectId: twin.subjectId,
        consentGrantIds: grantIds,
        evidenceAssetIds: assets.map((a) => a.id),
        evidenceHashes: assets.map((a) => a.contentHash),
        pipeline: {
          pipelineId: pipeline.id,
          components: [{ adapterId: VLM_RECON_ADAPTER.adapterId, version: VLM_RECON_ADAPTER.version }],
        },
        compiledAt: new Date().toISOString(),
        compiledBy: 'twin.compile',
      },
    };
    steps.done('compile');
    await ctx.report({ steps: steps.all(), progress: 0.7 });

    await ctx.report({ steps: steps.running('persist'), progress: 0.73 });
    const twinVersion = await db.twinVersion.create({
      data: {
        twinId: twin.id,
        version,
        status: 'published', // published versions are immutable
        htir: JSON.stringify(htir),
        inputVersionIds: JSON.stringify([]),
        pipelineId: pipeline.id,
        evidenceAssetIds: JSON.stringify(assets.map((a) => a.id)),
        confidenceSummary: JSON.stringify(htir.confidence),
      },
    });
    await db.twin.update({
      where: { id: twin.id },
      data: { currentVersion: version, status: 'reconstructed' },
    });
    await db.representation.create({
      data: {
        twinVersionId: twinVersion.id,
        kind: 'htir-summary',
        adapterId: VLM_RECON_ADAPTER.adapterId,
        params: JSON.stringify({ style, usage: analysis.usage, inferenceOnly: true }),
      },
    });
    steps.done('persist', `v${version} published (immutable)`);
    await ctx.report({ steps: steps.all(), progress: 0.82 });

    await ctx.report({ steps: steps.running('artifact'), progress: 0.85 });
    const evidenceCapabilities = [
      ...new Set(analysis.htirDraft.confidence.deficiencies.map((d) => d.capability)),
    ];
    // P6.B6: the baseline this version compares against — the twin's current
    // published version before this compile (none on the first compile).
    const baselineVersionRow = twin.currentVersion > 0
      ? await db.twinVersion.findFirst({ where: { twinId: twin.id, version: twin.currentVersion } })
      : null;
    const provenanceRecord = {
      ...htir.provenance,
      inferenceOnly: VLM_RECON_ADAPTER.inferenceOnly,
      trainingOnBiometrics: VLM_RECON_ADAPTER.trainingOnBiometrics,
      usage: analysis.usage,
      deficiencyCount: analysis.htirDraft.confidence.deficiencies.length,
    };
    const sections = buildTwinCompileSections({
      twinId: twin.id,
      twinVersion: { id: twinVersion.id, version },
      baselineTwinVersion: baselineVersionRow
        ? { id: baselineVersionRow.id, version: baselineVersionRow.version }
        : null,
      captureSessionId: captureSessionId ?? null,
      pipeline: { id: pipeline.id, name: pipeline.name },
      confidence: {
        overall: htir.confidence.overall,
        deficiencies: analysis.htirDraft.confidence.deficiencies.length,
      },
      evidenceAssetIds: assets.map((a) => a.id),
      adapterComponents: [{ adapterId: VLM_RECON_ADAPTER.adapterId, version: VLM_RECON_ADAPTER.version }],
      provenanceKeys: Object.keys(provenanceRecord),
      consent: { grantIds, scopes: ['reconstruct'], subjectId: twin.subjectId },
      llmCalls: analysis.usage.llmCalls,
    });
    const manifest: SolutionArtifactManifest = {
      solutionId: 'pending',
      version: 2,
      type: 'twin-review',
      title: `Twin review — ${twin.displayName} v${version}`,
      inputs: [
        ...(captureSessionId
          ? [{ label: `Capture session ${captureSessionId}`, kind: 'captureSession', ref: captureSessionId }]
          : []),
        { label: `Pipeline ${pipeline.name}`, kind: 'pipeline', ref: pipeline.id },
      ],
      twinVersion: { id: twinVersion.id, version },
      performance: null,
      pipeline: { id: pipeline.id, name: pipeline.name },
      organization: null,
      artifacts: [],
      evidence: assets.map((a) => ({
        assetId: a.id,
        label: `${a.kind} (${a.mime})`,
        contentHash: a.contentHash,
        url: signStorageUrl(a.storageKey, 3600),
      })),
      consent: {
        grantIds,
        scopes: ['reconstruct'],
        subjectId: twin.subjectId,
      },
      provenance: provenanceRecord,
      feedback_schema: {
        verdicts: [...FEEDBACK_VERDICTS],
        regions: [...REVIEW_REGIONS],
      },
      evidence_request_schema: {
        capabilities:
          evidenceCapabilities.length > 0
            ? evidenceCapabilities
            : ['face.profile', 'hands', 'hair.back', 'silhouette.side', 'teeth', 'speech'],
      },
      export_targets: ['svg', 'json'],
      sections,
    };
    const solution = await db.solutionArtifact.create({
      data: {
        tenantId: twin.tenantId,
        title: manifest.title,
        type: 'twin-review',
        manifest: JSON.stringify({ ...manifest, solutionId: 'pending' }),
        twinVersionId: twinVersion.id,
      },
    });
    // P6.B6: bind the real artifact id into the apiCode endpoints.
    const manifestFinal = {
      ...manifest,
      solutionId: solution.id,
      sections: bindArtifactId(sections, solution.id),
    };
    await db.solutionArtifact.update({
      where: { id: solution.id },
      data: { manifest: JSON.stringify(manifestFinal) },
    });
    steps.done('artifact');
    await ctx.report({ steps: steps.all(), progress: 1 });

    await emitEvent(ctx.tenantId, 'twin.version.published', 'twinVersion', twinVersion.id, {
      twinId: twin.id,
      version,
      confidence: htir.confidence.overall,
      deficiencies: analysis.htirDraft.confidence.deficiencies.length,
      llmCalls: analysis.usage.llmCalls,
    });
    await recordLlmCalls(ctx.tenantId, analysis.usage.llmCalls, { jobKind: 'twin.compile', twinId: twin.id });
    await recordUsage(ctx.tenantId, 'job.twin.compile', 1, { twinId: twin.id, twinVersionId: twinVersion.id });

    return {
      output: {
        twinVersionId: twinVersion.id,
        version,
        confidence: htir.confidence.overall,
        solutionArtifactId: solution.id,
        deficienciesCount: analysis.htirDraft.confidence.deficiencies.length,
        usage: analysis.usage,
        compute: computeRecord(computeQuote, {
          latencyMs: analysis.usage.totalLatencyMs, // real measured VLM total (sum of per-call latencies)
          costUsd: null,
          costBasis: 'not-observable (provider pricing not exposed)',
          note: `modeled estimate: $0.01 × ${analysis.usage.llmCalls} real llmCalls = $${(0.01 * analysis.usage.llmCalls).toFixed(2)} (labeled modeled; see benchmark MODELED_STAGE_COST)`,
        }, routingLabels(input)),
      },
      entities: [
        { type: 'twin', id: twin.id },
        { type: 'twinVersion', id: twinVersion.id },
        { type: 'solutionArtifact', id: solution.id },
      ],
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// f1.reconstruct — P6.C4: real-human F1 reconstruction (the reconstruction
// side of docs/F1_OPERATOR_CAPTURE.md). Consent-gated entry, fail-closed
// liveness/quality checkpoints, per-asset registry-resolved VLM analysis,
// honest F1ReconstructionReport aggregation, and a published TwinVersion
// carrying the F1 provenance (evidence manifest hashes, consent grant id,
// model + provider used, per-region confidences). The heavy lifting lives in
// lab/f1-recon.ts (pure, deps-injected); this executor wires the real seams:
// object storage (core/storage), the recon vision seam
// (adapters/vlm-recon → ai/recon-provider → ai/registry), and Prisma.
// Submitted by POST /api/v1/captures/:id/reconstruct (consent-gated there
// too — server-enforced at BOTH layers).
// ═══════════════════════════════════════════════════════════════════════════

registerExecutor({
  kind: F1_RECONSTRUCT_JOB_KIND,
  async execute(input, ctx) {
    const captureSessionId = reqString(input, 'captureSessionId');
    const style = parseStyle(input.style);
    const steps = new Steps([
      ['load', 'Load capture session and twin'],
      ['consent', 'Verify reconstruct consent (server-enforced)'],
      ['checkpoints', 'Liveness and quality checkpoints (fail-closed)'],
      ['analyze', 'Per-asset VLM analysis (registry-resolved)'],
      ['report', 'Aggregate F1 reconstruction report'],
      ['persist', 'Publish TwinVersion with F1 provenance'],
    ]);

    await ctx.report({ steps: steps.running('load'), progress: 0.05, status: 'running' });
    const session = await db.captureSession.findUnique({
      where: { id: captureSessionId },
      include: { assets: true, twin: true },
    });
    if (!session) throw new Error(`not_found: capture session ${captureSessionId}`);
    if (session.tenantId !== ctx.tenantId) throw new Error(`forbidden: session belongs to another tenant`);
    steps.done('load', `${session.assets.length} assets, session status "${session.status}"`);
    await ctx.report({ steps: steps.all(), progress: 0.1 });

    // consent (defense-in-depth: the route already enforced requireConsent;
    // runF1Reconstruction's own gate refuses BEFORE any evidence byte loads)
    await ctx.report({ steps: steps.running('consent'), progress: 0.12 });
    const grants = await db.consentGrant.findMany({
      where: {
        tenantId: ctx.tenantId,
        subjectId: session.twin.subjectId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    const grantInputs = grants.map((g) => ({
      id: g.id,
      scopes: parseJsonField<string[]>(g.scopes, []),
      revokedAt: g.revokedAt,
      expiresAt: g.expiresAt,
    }));

    const assets: F1EvidenceRecord[] = session.assets.map((a) => ({
      assetId: a.id,
      storageKey: a.storageKey,
      kind: a.kind,
      mime: a.mime,
      contentHash: a.contentHash,
      declaredBytes: a.bytes,
      regions: parseJsonField<CaptureRegion[]>(a.regions, []),
    }));
    const reconInput: F1ReconstructionInput = {
      captureSessionId: session.id,
      twinId: session.twinId,
      subjectId: session.twin.subjectId,
      sessionStatus: session.status,
      grants: grantInputs,
      assets,
    };
    const deps: F1VisionDeps = {
      loadBytes: async (storageKey) => {
        const buf = await getObject(storageKey);
        return buf ? new Uint8Array(buf) : null;
      },
      analyzeAsset: (asset, contextNote) =>
        analyzeAssetReconstruction(
          { id: asset.assetId, storageKey: asset.storageKey, mime: asset.mime, regions: asset.regions },
          style,
          contextNote,
        ),
      resolveVision: () => {
        const r = reconResolution();
        return { provider: r.provider, modelId: r.modelId, source: r.source };
      },
    };
    let sawAnalysis = false;
    const hooks = {
      onProgress: async (e: F1ProgressEvent) => {
        if (e.stage === 'checkpoint') {
          steps.running('checkpoints', `asset ${e.index}/${e.total} (${e.assetId})`);
          await ctx.report({ steps: steps.all(), progress: 0.18 + 0.12 * (e.index / e.total) });
        } else {
          if (!sawAnalysis) {
            steps.done('checkpoints');
            sawAnalysis = true;
          }
          steps.running('analyze', `asset ${e.index}/${e.total} (${e.assetId})`);
          await ctx.report({ steps: steps.all(), progress: 0.3 + 0.4 * (e.index / e.total) });
        }
      },
    };

    let reconResult: F1ReconstructionResult;
    try {
      reconResult = await runF1Reconstruction(reconInput, deps, hooks);
    } catch (err) {
      if (err instanceof F1TypedRefusal) {
        // durable step-trail for the typed gate that refused (verbatim code)
        const stepKey =
          err.code === 'consent_required' ? 'consent' : err.code === 'session_incomplete' ? 'load' : 'analyze';
        steps.failed(stepKey, `${err.code}: ${err.message}`);
        await ctx.report({ steps: steps.all(), status: 'failed' }).catch(() => undefined);
      }
      throw err;
    }
    const { report, analyzedAssets, grantId, vision } = reconResult;
    steps.done('consent', `grant ${grantId} (scope reconstruct, verified in-pipeline before evidence load)`);
    steps.done(
      'checkpoints',
      `${report.overall.assetsRefused} refused, ${report.overall.assetsSkippedNonImage} skipped non-image`,
    );
    steps.done(
      'analyze',
      `${report.overall.assetsAnalyzed} analyzed — ${report.usage.llmCalls} VLM calls, ${report.usage.totalLatencyMs}ms total (provider ${vision.provider}/${vision.modelId})`,
    );
    steps.done(
      'report',
      `coverage ${(report.overall.protocolCoverageRatio * 100).toFixed(0)}% of the 8-step protocol; confidence ${report.overall.confidenceOverall}`,
    );
    await ctx.report({ steps: steps.all(), progress: 0.85 });

    // HTIR draft: the SHARED C1 aggregation over the same per-asset analyses
    // (twin.compile and f1.reconstruct produce the same honest draft shape)
    await ctx.report({ steps: steps.running('persist'), progress: 0.88 });
    const pipeline = await loadPipelineByName('hand-designed-hybrid');
    const draft = aggregateHtirDraft(analyzedAssets);
    const version = session.twin.currentVersion + 1;
    const htir: F1Htir = {
      twinId: session.twinId,
      version,
      morphology: draft.morphology,
      geometry: draft.geometry,
      appearance: draft.appearance,
      articulation: draft.articulation,
      neuralAppearance: draft.neuralAppearance,
      motionProfile: draft.motionProfile,
      voice: null,
      styleProfiles: [{ style, params: { seed: 42 } }],
      confidence: draft.confidence,
      provenance: {
        subjectId: session.twin.subjectId,
        consentGrantIds: [grantId],
        evidenceAssetIds: assets.map((a) => a.assetId),
        evidenceHashes: assets.map((a) => a.contentHash),
        pipeline: {
          pipelineId: pipeline.id,
          components: [
            { adapterId: VLM_RECON_ADAPTER.adapterId, version: VLM_RECON_ADAPTER.version },
            { adapterId: F1_RECON_ADAPTER.adapterId, version: F1_RECON_ADAPTER.version },
          ],
        },
        compiledAt: new Date().toISOString(),
        compiledBy: 'f1.reconstruct',
        f1: buildF1ProvenanceBlock(reconInput, report),
      },
    };
    const twinVersion = await db.twinVersion.create({
      data: {
        twinId: session.twinId,
        version,
        status: 'published', // published versions are immutable
        htir: JSON.stringify(htir),
        inputVersionIds: JSON.stringify([]),
        pipelineId: pipeline.id,
        evidenceAssetIds: JSON.stringify(assets.map((a) => a.assetId)),
        confidenceSummary: JSON.stringify(htir.confidence),
      },
    });
    await db.twin.update({
      where: { id: session.twinId },
      data: { currentVersion: version, status: 'reconstructed' },
    });
    // the full F1ReconstructionReport is durable ON the TwinVersion — a
    // Representation row the review/deletion chain can walk (f1-recon-report)
    await db.representation.create({
      data: {
        twinVersionId: twinVersion.id,
        kind: 'f1-recon-report',
        adapterId: F1_RECON_ADAPTER.adapterId,
        params: JSON.stringify({ report, inferenceOnly: true }),
      },
    });
    steps.done('persist', `v${version} published (immutable); F1 report attached via representation "${F1_RECON_ADAPTER.adapterId}"`);
    await ctx.report({ steps: steps.all(), progress: 1 });

    await emitEvent(ctx.tenantId, 'twin.version.published', 'twinVersion', twinVersion.id, {
      twinId: session.twinId,
      version,
      confidence: htir.confidence.overall,
      deficiencies: draft.confidence.deficiencies.length,
      llmCalls: report.usage.llmCalls,
      f1: {
        jobKind: 'f1.reconstruct',
        captureSessionId: session.id,
        protocolCoverageRatio: report.overall.protocolCoverageRatio,
        protocolStepsCovered: report.overall.protocolStepsCovered,
        protocolStepsPartial: report.overall.protocolStepsPartial,
        protocolStepsMissing: report.overall.protocolStepsMissing,
        assetsRefused: report.overall.assetsRefused,
        assetsFailed: report.overall.assetsFailed,
        assetsSkippedNonImage: report.overall.assetsSkippedNonImage,
        visionProvider: vision.provider,
        visionModel: vision.modelId,
      },
    });
    await recordLlmCalls(ctx.tenantId, report.usage.llmCalls, {
      jobKind: 'f1.reconstruct',
      captureSessionId: session.id,
      twinId: session.twinId,
    });
    await recordUsage(ctx.tenantId, 'job.f1.reconstruct', 1, {
      captureSessionId: session.id,
      twinId: session.twinId,
      twinVersionId: twinVersion.id,
    });

    return {
      output: {
        twinVersionId: twinVersion.id,
        version,
        confidence: htir.confidence.overall,
        f1: {
          reportSchema: report.schema,
          overall: report.overall,
          vision: report.vision,
          perRegionConfidence: report.perRegionConfidence,
          regionCoverage: report.regionCoverage,
          protocolCoverage: report.protocolCoverage,
          qualityFindings: report.qualityFindings,
          failures: report.failures,
          evidenceManifest: report.evidenceManifest,
          usage: report.usage,
        },
      },
      entities: [
        { type: 'twin', id: session.twinId },
        { type: 'twinVersion', id: twinVersion.id },
        { type: 'captureSession', id: session.id },
      ],
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// render.image — HTIR → image artifact (svg-portrait-1 | ai-image-1)
// ═══════════════════════════════════════════════════════════════════════════

async function loadRenderJob(renderJobId: string, tenantId: string) {
  const job = await db.renderJob.findUnique({
    where: { id: renderJobId },
    include: { twinVersion: true, twin: true },
  });
  if (!job) throw new Error(`not_found: render job ${renderJobId}`);
  if (job.tenantId !== tenantId) throw new Error(`forbidden: render job belongs to another tenant`);
  if (!job.twinVersion) throw new Error(`not_found: twin version ${job.twinVersionId} for render job`);
  return job;
}

async function buildRenderReviewSolution(opts: {
  tenantId: string;
  renderJobId: string;
  twinId: string;
  twinVersionId: string;
  twinVersionVersion: number;
  twinDisplayName: string;
  /** the render job's performanceId — null for a static render (P6.B6) */
  performanceId: string | null;
  pipelineId: string | null;
  adapterComponents: { adapterId: string; version: string }[];
  artifacts: { artifactId: string; label: string; kind: string; storageKey: string }[];
  subjectId: string;
  grantIds: string[];
  /** verbatim job measurements (quoted into the result section, never derived) */
  latencyMs: number | null;
  costUsd: number | null;
}): Promise<string> {
  // P6.B6: honest lookups for the section slots — the performance actually
  // driving the render, and the baseline version this render's TwinVersion
  // compares against (none when it is the twin's first compile).
  const performanceRow = opts.performanceId
    ? await db.performance.findFirst({ where: { id: opts.performanceId, tenantId: opts.tenantId } })
    : null;
  const baselineVersionRow = opts.twinVersionVersion > 1
    ? await db.twinVersion.findFirst({ where: { twinId: opts.twinId, version: opts.twinVersionVersion - 1 } })
    : null;
  const provenanceRecord = {
    components: opts.adapterComponents,
    note: 'render provenance: adapter versions recorded per artifact; deterministic renderer costs 0 USD',
  };
  const sections = buildRenderSections({
    renderJobId: opts.renderJobId,
    twinVersion: { id: opts.twinVersionId, version: opts.twinVersionVersion },
    baselineTwinVersion: baselineVersionRow
      ? { id: baselineVersionRow.id, version: baselineVersionRow.version }
      : null,
    performance: performanceRow ? { id: performanceRow.id, name: performanceRow.name } : null,
    adapterComponents: opts.adapterComponents.map((c) => ({ ...c })),
    outputArtifact: opts.artifacts[0]
      ? { artifactId: opts.artifacts[0].artifactId, label: opts.artifacts[0].label, kind: opts.artifacts[0].kind }
      : null,
    latencyMs: opts.latencyMs,
    costUsd: opts.costUsd,
    provenanceKeys: Object.keys(provenanceRecord),
    consent: { grantIds: opts.grantIds, scopes: ['render'], subjectId: opts.subjectId },
  });
  const manifest: SolutionArtifactManifest = {
    solutionId: 'pending',
    version: 2,
    type: 'render-review',
    title: `Render review — ${opts.twinDisplayName} v${opts.twinVersionVersion}`,
    inputs: [
      { label: `Render job ${opts.renderJobId}`, kind: 'renderJob', ref: opts.renderJobId },
      ...(performanceRow ? [{ label: `Performance ${performanceRow.name}`, kind: 'performance', ref: performanceRow.id }] : []),
    ],
    twinVersion: { id: opts.twinVersionId, version: opts.twinVersionVersion },
    performance: performanceRow ? { id: performanceRow.id, name: performanceRow.name } : null,
    pipeline: opts.pipelineId ? { id: opts.pipelineId, name: 'see provenance' } : null,
    organization: null,
    artifacts: opts.artifacts.map((a) => ({
      artifactId: a.artifactId,
      label: a.label,
      kind: a.kind,
      url: signStorageUrl(a.storageKey, 3600),
    })),
    evidence: [],
    consent: { grantIds: opts.grantIds, scopes: ['render'], subjectId: opts.subjectId },
    provenance: provenanceRecord,
    feedback_schema: { verdicts: [...FEEDBACK_VERDICTS], regions: [...REVIEW_REGIONS] },
    evidence_request_schema: { capabilities: [] },
    export_targets: ['svg', 'png'],
    sections,
  };
  const solution = await db.solutionArtifact.create({
    data: {
      tenantId: opts.tenantId,
      title: manifest.title,
      type: 'render-review',
      manifest: JSON.stringify(manifest),
      twinVersionId: opts.twinVersionId,
      renderJobId: opts.renderJobId,
    },
  });
  // P6.B6: bind the real artifact id into the apiCode endpoints.
  const final = {
    ...manifest,
    solutionId: solution.id,
    sections: bindArtifactId(sections, solution.id),
  };
  await db.solutionArtifact.update({ where: { id: solution.id }, data: { manifest: JSON.stringify(final) } });
  return solution.id;
}

registerExecutor({
  kind: 'render.image',
  async execute(input, ctx) {
    const renderJobId = reqString(input, 'renderJobId');
    const adapter = optString(input, 'adapter') ?? SVG_PORTRAIT_ADAPTER.adapterId;
    if (adapter !== 'svg-portrait-1' && adapter !== AI_IMAGE_ADAPTER.adapterId) {
      throw new Error(`validation_failed: unknown render.image adapter "${adapter}" (wave-1: svg-portrait-1 | ai-image-1)`);
    }
    const steps = new Steps([
      ['load', 'Load render job and twin version'],
      ['consent', 'Verify render consent (server-enforced)'],
      ['render', `Render via ${adapter}`],
      ['persist', 'Persist artifact + representation'],
      ['artifact', 'Create render-review Solution Artifact'],
    ]);

    await ctx.report({ steps: steps.running('load'), progress: 0.05, status: 'running' });
    const job = await loadRenderJob(renderJobId, ctx.tenantId);
    const htir = parseJsonField<HTIR>(job.twinVersion.htir, null as unknown as HTIR);
    if (!htir) throw new Error(`internal_error: twin version ${job.twinVersionId} has unparseable HTIR`);
    const style = parseStyle(job.style);
    await db.renderJob.update({ where: { id: job.id }, data: { status: 'running', startedAt: new Date() } });
    steps.done('load');
    await ctx.report({ steps: steps.all(), progress: 0.12 });

    await ctx.report({ steps: steps.running('consent'), progress: 0.15 });
    const grants = await activeGrantsFor(job.twin.subjectId, job.twin.tenantId, 'render');
    assertConsent(grants, job.twin.subjectId, 'render');
    const grantIds = grants.map((g) => g.id);
    steps.done('consent', `${grantIds.length} active grant(s)`);
    await ctx.report({ steps: steps.all(), progress: 0.2 });

    await ctx.report({ steps: steps.running('render', adapter), progress: 0.25 });
    // W2.C compute-broker bookkeeping: adapter-aware quote (svg-portrait-1 is
    // zero-deterministic + local-only; ai-image-1 is modeled-cost provider egress).
    // P6.C3: the per-job provider override from the broker's embedded routing
    // record (dashscope-render → the hosted render seam; local/absent → the
    // YOU_RENDER_PROVIDER env seam keeps deciding, C2 law unchanged).
    const routed = routedRenderProvider(input);
    const routing = routingLabels(input);
    const computeQuote = await executionComputeQuote('render.image', ctx, input, adapter);
    await ctx.report({
      steps: steps.running('render', `${adapter} — ${quoteSummary(computeQuote.quote, computeQuote.phase)}`),
      progress: 0.28,
    });
    let artifactId: string;
    let representationKind: string;
    let latencyMs: number;
    let costUsd: number | null;
    let computeObserved: ExecutorComputeRecord['observed'];
    if (adapter === 'svg-portrait-1') {
      const t0 = Date.now();
      const svg = renderPortraitSvg(htir, { style, seed: 42 });
      const stored = await putObject(Buffer.from(svg, 'utf8'), { kind: 'render', mime: 'image/svg+xml' });
      latencyMs = Date.now() - t0;
      const artifact = await db.outputArtifact.create({
        data: {
          tenantId: job.tenantId,
          kind: 'svg',
          storageKey: stored.storageKey,
          contentHash: stored.contentHash,
          bytes: stored.bytes,
          mime: 'image/svg+xml',
          meta: JSON.stringify({
            adapterId: SVG_PORTRAIT_ADAPTER.adapterId,
            adapterVersion: SVG_PORTRAIT_ADAPTER.version,
            style,
            seed: 42,
            deterministic: true,
            aiInvolved: false,
            realLatencyMs: latencyMs,
            costUsd: 0,
          }),
        },
      });
      artifactId = artifact.id;
      representationKind = 'portrait-svg';
      costUsd = 0; // deterministic renderer — genuinely zero marginal cost
      computeObserved = {
        latencyMs,
        costUsd: 0,
        costBasis: 'zero-deterministic',
        note: 'deterministic local renderer — no provider involved; measured in-process latency, zero marginal cost is an observable fact',
      };
    } else {
      const result = await renderPortraitImage(htir, style, routed !== undefined ? { provider: routed } : {});
      latencyMs = result.latencyMs;
      const artifact = await db.outputArtifact.create({
        data: {
          tenantId: job.tenantId,
          kind: 'image',
          storageKey: result.storageKey,
          contentHash: result.contentHash,
          bytes: result.bytes,
          mime: result.mime,
          meta: JSON.stringify(result.meta),
        },
      });
      artifactId = artifact.id;
      representationKind = 'portrait-image';
      costUsd = null; // provider cost not observable — modeled estimate lives in artifact meta
      computeObserved = {
        latencyMs,
        costUsd: null,
        costBasis: 'not-observable (provider pricing not exposed)',
        note: 'modeled estimate $0.04 lives in the artifact meta (costUsdModeled: true) — never recorded as observed cost',
      };
      await recordUsage(ctx.tenantId, 'provider.image.calls', 1, {
        jobKind: 'render.image',
        renderJobId: job.id,
        latencyMs: result.latencyMs,
      });
    }
    steps.done('render', `${latencyMs}ms real`);
    await ctx.report({ steps: steps.all(), progress: 0.6 });

    await ctx.report({ steps: steps.running('persist'), progress: 0.65 });
    const artifactRow = await db.outputArtifact.findUnique({ where: { id: artifactId } });
    if (!artifactRow) throw new Error('internal_error: artifact vanished after creation');
    await db.representation.create({
      data: {
        twinVersionId: job.twinVersionId,
        kind: representationKind,
        adapterId: adapter,
        artifactId: artifactId,
        params: JSON.stringify({ style, seed: 42 }),
      },
    });
    await db.renderJob.update({
      where: { id: job.id },
      data: {
        status: 'succeeded',
        adapterId: adapter,
        artifactId,
        latencyMs,
        costUsd,
        finishedAt: new Date(),
      },
    });
    steps.done('persist');
    await ctx.report({ steps: steps.all(), progress: 0.8 });

    await ctx.report({ steps: steps.running('artifact'), progress: 0.85 });
    const solutionId = await buildRenderReviewSolution({
      tenantId: job.tenantId,
      renderJobId: job.id,
      twinId: job.twinId,
      twinVersionId: job.twinVersionId,
      twinVersionVersion: job.twinVersion.version,
      twinDisplayName: job.twin.displayName,
      performanceId: job.performanceId,
      pipelineId: job.twinVersion.pipelineId,
      adapterComponents: [
        { adapterId: VLM_RECON_ADAPTER.adapterId, version: VLM_RECON_ADAPTER.version },
        {
          adapterId: adapter === 'svg-portrait-1' ? SVG_PORTRAIT_ADAPTER.adapterId : AI_IMAGE_ADAPTER.adapterId,
          version: '1',
        },
      ],
      artifacts: [{ artifactId, label: `${representationKind} (${style})`, kind: artifactRow.kind, storageKey: artifactRow.storageKey }],
      subjectId: job.twin.subjectId,
      grantIds,
      latencyMs,
      costUsd,
    });
    steps.done('artifact');
    await ctx.report({ steps: steps.all(), progress: 1 });

    // persist the artifact↔solution linkage where the Studio UI reads it
    await db.outputArtifact.update({
      where: { id: artifactId },
      data: {
        meta: JSON.stringify({
          ...JSON.parse(artifactRow.meta ?? '{}'),
          solutionArtifactId: solutionId,
        }),
      },
    }).catch(() => undefined);

    await emitEvent(ctx.tenantId, 'render.succeeded', 'renderJob', job.id, {
      adapterId: adapter,
      artifactId,
      latencyMs,
      costUsd,
      twinVersionId: job.twinVersionId,
      prompt: adapter === 'ai-image-1' ? buildImagePrompt(htir, style) : undefined,
    });
    await recordUsage(ctx.tenantId, 'job.render.image', 1, { renderJobId: job.id, adapterId: adapter });

    return {
      output: { artifactId, solutionArtifactId: solutionId, adapterId: adapter, latencyMs, costUsd, compute: computeRecord(computeQuote, computeObserved, routing) },
      entities: [
        { type: 'renderJob', id: job.id },
        { type: 'outputArtifact', id: artifactId },
        { type: 'solutionArtifact', id: solutionId },
      ],
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// render.video — visual base + provider video task (bounded poll)
// ═══════════════════════════════════════════════════════════════════════════

registerExecutor({
  kind: 'render.video',
  async execute(input, ctx) {
    const renderJobId = reqString(input, 'renderJobId');
    const steps = new Steps([
      ['load', 'Load render job and twin version'],
      ['consent', 'Verify render consent (server-enforced)'],
      ['base', 'Ensure visual base image'],
      ['video', 'Provider video task (ai-video-1)'],
      ['persist', 'Persist video artifact'],
      ['artifact', 'Create render-review Solution Artifact'],
    ]);

    await ctx.report({ steps: steps.running('load'), progress: 0.03, status: 'running' });
    const job = await loadRenderJob(renderJobId, ctx.tenantId);
    const htir = parseJsonField<HTIR>(job.twinVersion.htir, null as unknown as HTIR);
    if (!htir) throw new Error(`internal_error: twin version ${job.twinVersionId} has unparseable HTIR`);
    const style = parseStyle(job.style);
    await db.renderJob.update({ where: { id: job.id }, data: { status: 'running', startedAt: new Date() } });
    steps.done('load');
    await ctx.report({ steps: steps.all(), progress: 0.06 });

    await ctx.report({ steps: steps.running('consent'), progress: 0.08 });
    const grants = await activeGrantsFor(job.twin.subjectId, job.twin.tenantId, 'render');
    assertConsent(grants, job.twin.subjectId, 'render');
    const grantIds = grants.map((g) => g.id);
    steps.done('consent', `${grantIds.length} active grant(s)`);
    await ctx.report({ steps: steps.all(), progress: 0.12 });

    await ctx.report({ steps: steps.running('base'), progress: 0.15 });
    // Prefer the latest raster portrait (PNG from ai-image-1) as the video base;
    // otherwise render the deterministic SVG base for the review manifest and
    // drive the video task from the text prompt (SVG cannot seed the provider
    // video API) — recorded honestly in the artifact meta.
    const representations = await db.representation.findMany({
      where: { twinVersionId: job.twinVersionId, kind: 'portrait-image' },
      orderBy: { createdAt: 'desc' },
    });
    // Representation has no Prisma relation to OutputArtifact (only artifactId) — join in memory
    const repArtifactIds = representations.map((r) => r.artifactId).filter((id): id is string => !!id);
    const repArtifacts = repArtifactIds.length
      ? await db.outputArtifact.findMany({ where: { id: { in: repArtifactIds } } })
      : [];
    const artifactsById = new Map(repArtifacts.map((a) => [a.id, a]));
    let baseImage: { storageKey: string; mime: string } | null = null;
    let baseArtifactId: string | null = null;
    let svgBaseArtifactId: string | null = null;
    const rasterArtifact = representations
      .map((r) => (r.artifactId ? artifactsById.get(r.artifactId) : undefined))
      .find((a) => a && a.mime === 'image/png');
    if (rasterArtifact) {
      baseImage = { storageKey: rasterArtifact.storageKey, mime: rasterArtifact.mime };
      baseArtifactId = rasterArtifact.id;
    } else {
      const t0 = Date.now();
      const svg = renderPortraitSvg(htir, { style, seed: 42 });
      const stored = await putObject(Buffer.from(svg, 'utf8'), { kind: 'render', mime: 'image/svg+xml' });
      const svgLatency = Date.now() - t0;
      const artifact = await db.outputArtifact.create({
        data: {
          tenantId: job.tenantId,
          kind: 'svg',
          storageKey: stored.storageKey,
          contentHash: stored.contentHash,
          bytes: stored.bytes,
          mime: 'image/svg+xml',
          meta: JSON.stringify({
            adapterId: SVG_PORTRAIT_ADAPTER.adapterId,
            adapterVersion: SVG_PORTRAIT_ADAPTER.version,
            role: 'video-visual-base',
            style,
            seed: 42,
            deterministic: true,
            realLatencyMs: svgLatency,
            costUsd: 0,
          }),
        },
      });
      svgBaseArtifactId = artifact.id;
      await db.representation.create({
        data: {
          twinVersionId: job.twinVersionId,
          kind: 'portrait-svg',
          adapterId: SVG_PORTRAIT_ADAPTER.adapterId,
          artifactId: artifact.id,
          params: JSON.stringify({ style, seed: 42, role: 'video-visual-base' }),
        },
      });
    }
    steps.done(
      'base',
      baseImage ? 'reused existing raster portrait as video base' : 'rendered deterministic SVG visual base (video will be text-driven)'
    );
    await ctx.report({ steps: steps.all(), progress: 0.2 });

    await ctx.report({ steps: steps.running('video', 'provider task + bounded poll (≤10 min)'), progress: 0.25 });
    // W2.C compute-broker bookkeeping: quote for the routed workload
    // (ai-video-1 provider egress; latency from observed history when present).
    // P6.C3: per-job provider override from the broker's embedded routing
    // record (dashscope-render → the hosted render seam for BOTH the task
    // creation and its polls; local/absent → the env seam, C2 law unchanged).
    const routed = routedRenderProvider(input);
    const routing = routingLabels(input);
    const computeQuote = await executionComputeQuote('render.video', ctx, input, AI_VIDEO_ADAPTER.adapterId);
    await ctx.report({
      steps: steps.running('video', `provider task + bounded poll (≤10 min) — ${quoteSummary(computeQuote.quote, computeQuote.phase)}`),
      progress: 0.28,
    });
    let result;
    try {
      result = await renderPortraitVideo({ htir, style, baseImage, ...(routed !== undefined ? { provider: routed } : {}) });
    } catch (e) {
      await db.renderJob.update({
        where: { id: job.id },
        data: { status: 'failed', adapterId: AI_VIDEO_ADAPTER.adapterId, error: e instanceof Error ? e.message : String(e), finishedAt: new Date() },
      });
      steps.failed('video', e instanceof Error ? e.message : String(e));
      await ctx.report({ steps: steps.all(), status: 'failed' });
      throw e;
    }
    steps.done('video', `task ${result.taskId}, waited ${result.waitedMs}ms`);
    await ctx.report({ steps: steps.all(), progress: 0.85 });

    await ctx.report({ steps: steps.running('persist'), progress: 0.88 });
    let artifactId: string;
    let artifactKind: string;
    if (result.storageKey && result.contentHash && result.bytes !== null) {
      const artifact = await db.outputArtifact.create({
        data: {
          tenantId: job.tenantId,
          kind: 'video',
          storageKey: result.storageKey,
          contentHash: result.contentHash,
          bytes: result.bytes,
          mime: result.mime,
          meta: JSON.stringify(result.meta),
        },
      });
      artifactId = artifact.id;
      artifactKind = 'video';
    } else {
      // download/re-host failed: store the provider remote URL reference as a
      // manifest artifact with an honest note (bytes were NOT re-hosted)
      const manifestBuf = Buffer.from(
        JSON.stringify(
          {
            providerTaskId: result.taskId,
            remoteUrl: result.remoteUrl,
            note: 'provider-hosted video reference — YOU could not download/re-host the bytes; consume via the signed provider URL',
            meta: result.meta,
          },
          null,
          2
        ),
        'utf8'
      );
      const stored = await putObject(manifestBuf, { kind: 'manifest', mime: 'application/json' });
      const artifact = await db.outputArtifact.create({
        data: {
          tenantId: job.tenantId,
          kind: 'manifest',
          storageKey: stored.storageKey,
          remoteUrl: result.remoteUrl,
          contentHash: stored.contentHash,
          bytes: stored.bytes,
          mime: 'application/json',
          meta: JSON.stringify({
            ...result.meta,
            remoteOnly: true,
            videoBytesRehosted: false,
            honestNote: 'video bytes NOT re-hosted; provider remote URL recorded as the artifact reference',
          }),
        },
      });
      artifactId = artifact.id;
      artifactKind = 'manifest';
    }
    await db.representation.create({
      data: {
        twinVersionId: job.twinVersionId,
        kind: 'video',
        adapterId: AI_VIDEO_ADAPTER.adapterId,
        artifactId,
        params: JSON.stringify({
          style,
          providerTaskId: result.taskId,
          videoBytesRehosted: artifactKind === 'video',
          usedImageBase: result.usedImageBase,
        }),
      },
    });
    await db.renderJob.update({
      where: { id: job.id },
      data: {
        status: 'succeeded',
        adapterId: AI_VIDEO_ADAPTER.adapterId,
        artifactId,
        latencyMs: result.latencyMs,
        costUsd: null, // provider cost not observable — modeled estimate lives in artifact meta
        finishedAt: new Date(),
      },
    });
    steps.done('persist', artifactKind === 'video' ? 'video bytes re-hosted' : 'remote reference recorded');
    await ctx.report({ steps: steps.all(), progress: 0.92 });

    await ctx.report({ steps: steps.running('artifact'), progress: 0.95 });
    const videoArtifact = await db.outputArtifact.findUnique({ where: { id: artifactId } });
    if (!videoArtifact) throw new Error('internal_error: video artifact vanished after creation');
    const manifestArtifactRefs: Array<{ artifactId: string; label: string; kind: string; storageKey: string }> = [];
    if (svgBaseArtifactId) {
      const svgArt = await db.outputArtifact.findUnique({ where: { id: svgBaseArtifactId } });
      if (svgArt) {
        manifestArtifactRefs.push({
          artifactId: svgArt.id,
          label: 'visual base (svg-portrait-1)',
          kind: 'svg',
          storageKey: svgArt.storageKey,
        });
      }
    }
    if (baseArtifactId) {
      const baseArt = await db.outputArtifact.findUnique({ where: { id: baseArtifactId } });
      if (baseArt) {
        manifestArtifactRefs.push({
          artifactId: baseArt.id,
          label: 'visual base (ai-image-1)',
          kind: 'image',
          storageKey: baseArt.storageKey,
        });
      }
    }
    manifestArtifactRefs.push({
      artifactId,
      label: `video (${artifactKind})`,
      kind: artifactKind,
      storageKey: videoArtifact.storageKey,
    });
    const solutionId = await buildRenderReviewSolution({
      tenantId: job.tenantId,
      renderJobId: job.id,
      twinId: job.twinId,
      twinVersionId: job.twinVersionId,
      twinVersionVersion: job.twinVersion.version,
      twinDisplayName: job.twin.displayName,
      performanceId: job.performanceId,
      pipelineId: job.twinVersion.pipelineId,
      adapterComponents: [
        { adapterId: VLM_RECON_ADAPTER.adapterId, version: VLM_RECON_ADAPTER.version },
        ...(svgBaseArtifactId ? [{ adapterId: SVG_PORTRAIT_ADAPTER.adapterId, version: '1' }] : []),
        { adapterId: AI_VIDEO_ADAPTER.adapterId, version: AI_VIDEO_ADAPTER.version },
      ],
      artifacts: manifestArtifactRefs,
      subjectId: job.twin.subjectId,
      grantIds,
      latencyMs: result.latencyMs,
      costUsd: null, // provider cost not observable — modeled estimate lives in artifact meta
    });
    steps.done('artifact');
    await ctx.report({ steps: steps.all(), progress: 1 });

    // persist the artifact↔solution linkage where the Studio UI reads it
    const videoArtifactRow = await db.outputArtifact.findUnique({ where: { id: artifactId } });
    if (videoArtifactRow) {
      await db.outputArtifact.update({
        where: { id: artifactId },
        data: {
          meta: JSON.stringify({
            ...JSON.parse(videoArtifactRow.meta ?? '{}'),
            solutionArtifactId: solutionId,
          }),
        },
      }).catch(() => undefined);
    }

    await emitEvent(ctx.tenantId, 'render.succeeded', 'renderJob', job.id, {
      adapterId: AI_VIDEO_ADAPTER.adapterId,
      artifactId,
      kind: 'video',
      latencyMs: result.latencyMs,
      videoBytesRehosted: artifactKind === 'video',
      twinVersionId: job.twinVersionId,
    });
    await recordUsage(ctx.tenantId, 'job.render.video', 1, {
      renderJobId: job.id,
      providerTaskId: result.taskId,
      latencyMs: result.latencyMs,
    });
    await recordUsage(ctx.tenantId, 'provider.video.calls', 1, {
      renderJobId: job.id,
      waitedMs: result.waitedMs,
    });

    return {
      output: {
        artifactId,
        solutionArtifactId: solutionId,
        adapterId: AI_VIDEO_ADAPTER.adapterId,
        providerTaskId: result.taskId,
        waitedMs: result.waitedMs,
        latencyMs: result.latencyMs,
        videoStored: artifactKind === 'video',
        remoteUrl: result.remoteUrl,
        compute: computeRecord(computeQuote, {
          latencyMs: result.latencyMs, // real measured total (create + poll + download)
          costUsd: null,
          costBasis: 'not-observable (provider pricing not exposed)',
          note: `modeled estimate $0.1 lives in the artifact meta (costUsdModeled: true); provider waited ${result.waitedMs}ms is measured — never recorded as observed cost`,
        }, routing),
      },
      entities: [
        { type: 'renderJob', id: job.id },
        { type: 'outputArtifact', id: artifactId },
        { type: 'solutionArtifact', id: solutionId },
      ],
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// performance.fromText — dialog text → deterministic performance tracks
// ═══════════════════════════════════════════════════════════════════════════

const EXPRESSION_TAGS = ['neutral', 'smile', 'nod', 'raise-brows', 'thoughtful'] as const;

registerExecutor({
  kind: 'performance.fromText',
  async execute(input, ctx) {
    const name = reqString(input, 'name');
    const script = reqString(input, 'script');
    const twinId = optString(input, 'twinId');
    const performanceId = optString(input, 'performanceId');
    const steps = new Steps([
      ['parse', 'Split script into sentences'],
      ['tracks', 'Build deterministic state + speech tracks'],
      ['enhance', 'Optional LLM expression tagging'],
      ['persist', 'Persist performance'],
      ['artifact', 'Create performance-review Solution Artifact'],
    ]);

    await ctx.report({ steps: steps.running('parse'), progress: 0.1, status: 'running' });
    const sentences = script
      .replace(/\s+/g, ' ')
      .trim()
      .split(/(?<=[.!?])\s+/)
      .filter((s) => s.length > 0);
    if (sentences.length === 0) {
      throw new Error('validation_failed: script contains no sentences — refusing to build an empty performance');
    }
    steps.done('parse', `${sentences.length} sentences`);
    await ctx.report({ steps: steps.all(), progress: 0.2 });

    await ctx.report({ steps: steps.running('tracks'), progress: 0.3 });
    // deterministic: the script content itself is the seed
    const rng = makeRng(hashString(script) ^ 42);
    type Frame = { t: number; state?: string; intensity?: number; note?: string };
    const stateFrames: Frame[] = [];
    const speechFrames: Frame[] = [];
    let t = 0;
    const perSentence: Array<{ text: string; start: number; end: number }> = [];
    for (const sentence of sentences) {
      // listening
      stateFrames.push({ t, state: 'listening', intensity: 0.4 });
      t += 600;
      // thinking (400ms + seeded jitter)
      const thinkMs = 400 + rng.int(0, 300);
      stateFrames.push({ t, state: 'thinking', intensity: 0.6 });
      t += thinkMs;
      // speaking (duration ∝ sentence length; intensity from punctuation)
      const punct = sentence.trim().slice(-1);
      const intensity = punct === '!' ? 0.9 : punct === '?' ? 0.75 : punct === '.' ? 0.6 : 0.55;
      const speakMs = Math.round(Math.min(9000, Math.max(1200, 800 + sentence.length * 55)));
      const start = t;
      stateFrames.push({ t, state: 'speaking', intensity });
      speechFrames.push({ t, intensity, note: sentence });
      t += speakMs;
      speechFrames.push({ t, intensity: 0, note: '(end)' });
      perSentence.push({ text: sentence, start, end: t });
    }
    const durationMs = t;
    steps.done('tracks', `${stateFrames.length} state frames, ${speechFrames.length} speech markers`);
    await ctx.report({ steps: steps.all(), progress: 0.5 });

    await ctx.report({ steps: steps.running('enhance'), progress: 0.55 });
    let llmEnhanced = false;
    const expressionFrames: Frame[] = [];
    let llmError: string | null = null;
    try {
      const res = await chatComplete(
        [
          {
            role: 'assistant',
            content:
              'You tag dialog sentences with avatar expressions. Respond with ONLY a JSON array, one entry per input sentence, in order, each entry like {"expression":"neutral"|"smile"|"nod"|"raise-brows"|"thoughtful"}. No markdown fences, no prose.',
          },
          { role: 'user', content: JSON.stringify(sentences) },
        ],
        { thinking: false, temperature: 0.2 }
      );
      const parsed = JSON.parse(res.content.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()) as unknown;
      if (Array.isArray(parsed) && parsed.length === sentences.length) {
        perSentence.forEach((s, i) => {
          const tag = (parsed[i] as { expression?: unknown })?.expression;
          expressionFrames.push({
            t: s.start,
            intensity: 0.8,
            note: typeof tag === 'string' && (EXPRESSION_TAGS as readonly string[]).includes(tag) ? tag : 'neutral',
          });
        });
        llmEnhanced = true;
      } else {
        llmError = 'expression array length mismatch — using deterministic fallback';
      }
    } catch (e) {
      llmError = e instanceof Error ? e.message : String(e);
    }
    if (!llmEnhanced) {
      perSentence.forEach((s, i) => {
        expressionFrames.push({ t: s.start, intensity: 0.6, note: i % 2 === 0 ? 'neutral' : 'nod' });
      });
    }
    steps.done(
      'enhance',
      llmEnhanced ? 'LLM expression tagging applied' : `deterministic fallback${llmError ? ` (${llmError})` : ''}`
    );
    await ctx.report({ steps: steps.all(), progress: 0.8 });

    await ctx.report({ steps: steps.running('persist'), progress: 0.85 });
    const tracks = [
      { trackId: 'state-1', kind: 'state' as const, frames: stateFrames },
      { trackId: 'speech-1', kind: 'speech' as const, frames: speechFrames },
      { trackId: 'expression-1', kind: 'expression' as const, frames: expressionFrames },
    ];
    const data = {
      tenantId: ctx.tenantId,
      twinId: twinId ?? null,
      name,
      origin: 'text',
      durationMs,
      tracks: JSON.stringify(tracks),
      script,
    };
    let performanceRow;
    if (performanceId) {
      performanceRow = await db.performance.update({ where: { id: performanceId }, data });
    } else {
      performanceRow = await db.performance.create({ data });
    }
    steps.done('persist');
    await ctx.report({ steps: steps.all(), progress: 0.9 });

    // P6.B6 — the performance creation path produces a Solution Artifact with
    // the sections it can HONESTLY fill: result + performance + provenance +
    // apiCode. compare/evidence/consent/feedback/evidenceRequests stay
    // null-with-reason (documented in the section slots, never invented).
    await ctx.report({ steps: steps.running('artifact'), progress: 0.93 });
    const performanceProvenance = {
      origin: 'text',
      deterministic: true,
      seed: 'hash(script) ^ 42',
      sentenceCount: sentences.length,
      llmEnhanced,
      ...(llmEnhanced ? {} : { llmEnhanceError: llmError ?? 'deterministic fallback applied' }),
    };
    const performanceSections = buildPerformanceSections({
      performance: { id: performanceRow.id, name },
      origin: 'text',
      durationMs,
      trackCount: tracks.length,
      sentenceCount: sentences.length,
      llmEnhanced,
      twinId: twinId ?? null,
      provenanceKeys: Object.keys(performanceProvenance),
    });
    const performanceManifest: SolutionArtifactManifest = {
      solutionId: 'pending',
      version: 2,
      type: 'performance-review',
      title: `Performance review — ${name}`,
      inputs: [{ label: `Performance ${performanceRow.id}`, kind: 'performance', ref: performanceRow.id }],
      twinVersion: null,
      performance: { id: performanceRow.id, name },
      pipeline: null,
      organization: null,
      artifacts: [],
      evidence: [],
      consent: null,
      provenance: performanceProvenance,
      feedback_schema: { verdicts: [...FEEDBACK_VERDICTS], regions: [...REVIEW_REGIONS] },
      evidence_request_schema: { capabilities: [] },
      export_targets: ['json'],
      sections: performanceSections,
    };
    const performanceSolution = await db.solutionArtifact.create({
      data: {
        tenantId: ctx.tenantId,
        title: performanceManifest.title,
        type: 'performance-review',
        manifest: JSON.stringify(performanceManifest),
        twinVersionId: null,
        renderJobId: null,
      },
    });
    await db.solutionArtifact.update({
      where: { id: performanceSolution.id },
      data: {
        manifest: JSON.stringify({
          ...performanceManifest,
          solutionId: performanceSolution.id,
          sections: bindArtifactId(performanceSections, performanceSolution.id),
        }),
      },
    });
    steps.done('artifact');
    await ctx.report({ steps: steps.all(), progress: 1 });

    await emitEvent(ctx.tenantId, 'performance.created', 'performance', performanceRow.id, {
      name,
      origin: 'text',
      durationMs,
      trackCount: tracks.length,
      llmEnhanced,
      solutionArtifactId: performanceSolution.id,
    });
    await emitEvent(ctx.tenantId, 'solution.artifact.created', 'solution_artifact', performanceSolution.id, {
      type: 'performance-review',
      performanceId: performanceRow.id,
      twinVersionId: null,
    });
    if (llmEnhanced) {
      await recordLlmCalls(ctx.tenantId, 1, { jobKind: 'performance.fromText', performanceId: performanceRow.id });
    }
    await recordUsage(ctx.tenantId, 'job.performance.fromText', 1, { performanceId: performanceRow.id });

    return {
      output: {
        performanceId: performanceRow.id,
        solutionArtifactId: performanceSolution.id,
        durationMs,
        tracks: tracks.length,
        sentences: sentences.length,
        llmEnhanced,
        ...(llmEnhanced ? {} : { llmEnhanceError: llmError }),
      },
      entities: [
        { type: 'performance', id: performanceRow.id },
        { type: 'solutionArtifact', id: performanceSolution.id },
      ],
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// lab.benchmark — the HUMAN-RECON-001 harness
// ═══════════════════════════════════════════════════════════════════════════

registerExecutor({
  kind: 'lab.benchmark',
  async execute(input, ctx) {
    const objectiveCode = optString(input, 'objectiveCode') ?? 'HUMAN-RECON-001';
    const worldSeed = typeof input.worldSeed === 'number' ? Math.floor(input.worldSeed) : 42;
    const benchmarkRunId = optString(input, 'benchmarkRunId');
    const steps = new Steps([
      ['objective', 'Load lab objective'],
      ['pipelines', 'Load baseline pipelines'],
      ['world', `Generate deterministic world (seed ${worldSeed})`],
      ['compile', 'Compile organizations (generalist / hand-designed / searched)'],
      ['evaluate', 'Evaluate on seeded world (deterministic simulation + real grounding calls)'],
      ['persist', 'Persist BenchmarkRun + EvaluationReports'],
      ['failures', 'Record failure-atlas entries'],
      ['promotion', 'Draft promotion record for best organization'],
    ]);

    await ctx.report({ steps: steps.running('objective'), progress: 0.05, status: 'running' });
    const objective = await db.labObjective.findUnique({ where: { code: objectiveCode } });
    if (!objective) {
      throw new Error(`not_found: lab objective ${objectiveCode} — run seedLabBaseline first`);
    }
    steps.done('objective', objective.title);
    await ctx.report({ steps: steps.all(), progress: 0.1 });

    await ctx.report({ steps: steps.running('pipelines'), progress: 0.15 });
    const pipelineRows = {
      generalist: await loadPipelineByName('generalist-vlm-recon'),
      handDesigned: await loadPipelineByName('hand-designed-hybrid'),
      searched: await loadPipelineByName('searched-gen1'),
    };
    const pipelines: { generalist: PipelineRef; handDesigned: PipelineRef; searched: PipelineRef } = {
      generalist: {
        id: pipelineRows.generalist.id,
        name: pipelineRows.generalist.name,
        genome: parseJsonField<PipelineRef['genome']>(pipelineRows.generalist.genome, { stages: [], parameters: {}, skills: [], compute: { class: 'unknown' }, evaluation: { rubric: [], seed: worldSeed } }),
      },
      handDesigned: {
        id: pipelineRows.handDesigned.id,
        name: pipelineRows.handDesigned.name,
        genome: parseJsonField<PipelineRef['genome']>(pipelineRows.handDesigned.genome, { stages: [], parameters: {}, skills: [], compute: { class: 'unknown' }, evaluation: { rubric: [], seed: worldSeed } }),
      },
      searched: {
        id: pipelineRows.searched.id,
        name: pipelineRows.searched.name,
        genome: parseJsonField<PipelineRef['genome']>(pipelineRows.searched.genome, { stages: [], parameters: {}, skills: [], compute: { class: 'unknown' }, evaluation: { rubric: [], seed: worldSeed } }),
      },
    };
    steps.done('pipelines', 'generalist-vlm-recon, hand-designed-hybrid, searched-gen1');
    await ctx.report({ steps: steps.all(), progress: 0.2 });

    await ctx.report({ steps: steps.running('world'), progress: 0.25 });
    const world = generateWorld(worldSeed);
    steps.done('world', world.worldId);
    await ctx.report({ steps: steps.all(), progress: 0.3 });

    await ctx.report({ steps: steps.running('compile'), progress: 0.35 });
    const organizations = compileOrganizations(worldSeed, pipelines);
    steps.done('compile', `${organizations.length} organizations`);
    await ctx.report({ steps: steps.all(), progress: 0.4 });

    await ctx.report({ steps: steps.running('evaluate'), progress: 0.45 });
    const { evaluations, aggregate, llmCalls } = await evaluateOrganizations(world, organizations);
    steps.done(
      'evaluate',
      `best: ${aggregate.bestOrganizationId} (grounding calls: ${llmCalls} real)`
    );
    await ctx.report({ steps: steps.all(), progress: 0.7 });

    await ctx.report({ steps: steps.running('persist'), progress: 0.75 });
    const now = new Date();
    const runData = {
      objectiveId: objective.id,
      worldSeed,
      status: 'succeeded',
      organizations: JSON.stringify(organizations.map((o) => o.descriptor)),
      metrics: JSON.stringify({
        simulated: true,
        simulationNote:
          'Lab benchmark results are SIMULATED research truth (deterministic seeded simulation + explicitly-labeled real provider grounding measurements); never production human truth',
        // W2.C latency honesty at the run-report level: the aggregate score
        // basis per organization + the per-component labeling rule. Full
        // per-component labels (modeled | observed | unavailable) live in each
        // EvaluationReport detail (llmLatencyComponents).
        latencyHonesty: {
          rule: 'every LLM-latency component is labeled per-component in each EvaluationReport detail (llmLatencyComponents: modeled | observed | unavailable); aggregate latencyMs bases:',
          perOrganization: evaluations.map((e) => {
            const d = e.detail as Record<string, unknown>;
            return {
              organizationId: e.organizationId,
              latencyMsBasis: d.latencyMsBasis ?? null,
              latencyModeledMs: d.latencyModeledMs ?? null,
              latencyRealMs: d.latencyRealMs ?? null,
              latencyComponentsLabeled: d.latencyComponentsLabeled ?? null,
            };
          }),
        },
        aggregate,
        perOrganization: evaluations.map((e) => ({
          organizationId: e.organizationId,
          scores: e.scores,
          reproducible: e.reproducible,
        })),
      }),
      finishedAt: now,
    };
    const run = benchmarkRunId
      ? await db.benchmarkRun.update({ where: { id: benchmarkRunId }, data: { ...runData, startedAt: now } })
      : await db.benchmarkRun.create({ data: { ...runData, startedAt: now } });
    for (const ev of evaluations) {
      await db.evaluationReport.create({
        data: {
          benchmarkRunId: run.id,
          organizationId: ev.organizationId,
          scores: JSON.stringify(ev.scores),
          reproducible: ev.reproducible,
          seed: worldSeed,
          detail: JSON.stringify(ev.detail),
        },
      });
    }
    steps.done('persist', run.id);
    await ctx.report({ steps: steps.all(), progress: 0.85 });

    await ctx.report({ steps: steps.running('failures'), progress: 0.88 });
    const failureIds = await recordRegionFailures(db, run.id, worldSeed, evaluations);
    steps.done('failures', `${failureIds.length} failure cases`);
    await ctx.report({ steps: steps.all(), progress: 0.92 });

    await ctx.report({ steps: steps.running('promotion'), progress: 0.95 });
    const bestOrg = organizations.find((o) => o.descriptor.organizationId === aggregate.bestOrganizationId);
    const bestPipelineId = bestOrg?.descriptor.pipelineId ?? pipelines.handDesigned.id;
    const bestRank = aggregate.ranking.find((r) => r.organizationId === aggregate.bestOrganizationId);
    await db.promotionRecord.create({
      data: {
        pipelineId: bestPipelineId,
        fromStatus: 'draft',
        toStatus: 'benchmarked',
        decision: 'drafted',
        evidence: JSON.stringify({
          benchmarkRunId: run.id,
          objectiveCode,
          worldSeed,
          weightedScore: bestRank?.weightedScore ?? null,
          formula: aggregate.formula,
          note: 'draft only — promotion requires validation/canary gates (reproducibility, benchmark, rights, privacy, cost, latency)',
          simulated: true,
        }),
        decidedBy: 'lab.benchmark executor (auto-draft; TL owns promotion)',
      },
    });
    const bestPipelineRow = await db.pipelineCandidate.findUnique({ where: { id: bestPipelineId } });
    if (bestPipelineRow && bestPipelineRow.status === 'draft') {
      await db.pipelineCandidate.update({ where: { id: bestPipelineId }, data: { status: 'benchmarked' } });
    }
    steps.done('promotion', `pipeline ${bestPipelineId} drafted → benchmarked`);
    await ctx.report({ steps: steps.all(), progress: 1 });

    await emitEvent(ctx.tenantId, 'lab.benchmark.succeeded', 'benchmarkRun', run.id, {
      objectiveCode,
      worldSeed,
      bestOrganizationId: aggregate.bestOrganizationId,
      organizations: organizations.map((o) => o.descriptor.organizationId),
      llmCalls,
      simulated: true,
    });
    await recordLlmCalls(ctx.tenantId, llmCalls, { jobKind: 'lab.benchmark', benchmarkRunId: run.id });
    await recordUsage(ctx.tenantId, 'job.lab.benchmark', 1, { benchmarkRunId: run.id, worldSeed });

    return {
      output: {
        benchmarkRunId: run.id,
        organizations: organizations.map((o) => o.descriptor),
        bestOrganizationId: aggregate.bestOrganizationId,
        ranking: aggregate.ranking,
        formula: aggregate.formula,
        failureCaseIds: failureIds,
        simulated: true,
      },
      entities: [
        { type: 'benchmarkRun', id: run.id },
        { type: 'pipelineCandidate', id: bestPipelineId },
      ],
    };
  },
});


// ─── maintenance.gc-storage (P6.A4: deletion completeness) ───────────────────
// Twin deletion cascades DB rows but intentionally retains content-addressed
// storage bytes (keys can be shared across assets; deleting per-twin is
// unsafe). This job sweeps objects that NO EvidenceAsset row references.
registerExecutor({
  kind: 'maintenance.gc-storage',
  async execute(_input, ctx) {
    const steps = new Steps([
      ['enumerate', 'Enumerate stored objects'],
      ['reference', 'Build the referenced-key set'],
      ['sweep', 'Delete unreferenced objects'],
    ]);

    await ctx.report({ steps: steps.running('enumerate'), progress: 0.1, status: 'running' });
    const stored = await listObjectKeys();
    steps.done('enumerate', `${stored.length} objects`);
    await ctx.report({ steps: steps.all(), progress: 0.35 });

    const referenced = new Set(
      (await db.evidenceAsset.findMany({ select: { storageKey: true } })).map((a) => a.storageKey),
    );
    steps.done('reference', `${referenced.size} referenced keys`);
    await ctx.report({ steps: steps.all(), progress: 0.5 });

    const orphans = stored.filter((k) => !referenced.has(k));
    let swept = 0;
    const failures: string[] = [];
    for (const key of orphans) {
      try {
        await deleteObject(key);
        swept += 1;
      } catch (err) {
        failures.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    steps.done('sweep', `${swept}/${orphans.length} swept${failures.length ? `, ${failures.length} FAILED` : ''}`);
    await ctx.report({ steps: steps.all(), progress: 1 });

    return {
      output: {
        storedObjects: stored.length,
        referencedKeys: referenced.size,
        sweptUnreferenced: swept,
        ...(failures.length ? { sweepFailures: failures.slice(0, 20) } : {}),
      },
    };
  },
});

// ─── The durable agent.turn executor (P6.C6) ─────────────────────────────────

interface AgentTurnSnapshotBody {
  name: string;
  role: string;
  description: string | null;
  twinVersionId: string | null;
  tools: string[];
  manifest: AgentCapabilityManifest;
}

interface AgentTurnSnapshotSoul {
  name: string;
  description: string | null;
  twinId: string;
  persona: AgentSoulPersona;
  provider: string;
  model: string;
  params: AgentSoulBehaviorParams;
  manifest: AgentCapabilityManifest;
  seed: number;
}

async function loadBodySnapshot(
  bodyId: string,
  version: number,
): Promise<AgentTurnSnapshotBody | null> {
  const row = await db.agentRuntimeBodyVersion.findUnique({
    where: { bodyId_version: { bodyId, version } },
  });
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.snapshot) as Partial<AgentTurnSnapshotBody>;
    return {
      name: typeof parsed.name === 'string' ? parsed.name : '',
      role: typeof parsed.role === 'string' ? parsed.role : '',
      description: typeof parsed.description === 'string' ? parsed.description : null,
      twinVersionId: typeof parsed.twinVersionId === 'string' ? parsed.twinVersionId : null,
      tools: Array.isArray(parsed.tools) ? parsed.tools : [],
      manifest: parseManifest(JSON.stringify(parsed.manifest ?? {})),
    };
  } catch {
    return null;
  }
}

async function loadSoulSnapshot(soulId: string, version: number): Promise<AgentTurnSnapshotSoul | null> {
  const row = await db.agentRuntimeSoulVersion.findUnique({
    where: { soulId_version: { soulId, version } },
  });
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.snapshot) as Partial<AgentTurnSnapshotSoul>;
    return {
      name: typeof parsed.name === 'string' ? parsed.name : '',
      description: typeof parsed.description === 'string' ? parsed.description : null,
      twinId: typeof parsed.twinId === 'string' ? parsed.twinId : '',
      persona: normalizePersona(parsed.persona ?? {}),
      provider: typeof parsed.provider === 'string' ? parsed.provider : 'zai',
      model: typeof parsed.model === 'string' ? parsed.model : 'unknown',
      params: normalizeBehaviorParams(parsed.params ?? {}),
      manifest: parseManifest(JSON.stringify(parsed.manifest ?? {})),
      seed: typeof parsed.seed === 'number' ? parsed.seed : 0,
    };
  } catch {
    return null;
  }
}

/** Honest required-string extraction from job input (executor convention). */
function reqTurnString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`validation_failed: job input.${key} (string) is required`);
  }
  return v;
}

const agentTurnExecutor = {
  kind: AGENT_TURN_JOB_KIND,
  async execute(input: Record<string, unknown>, ctx: JobContext) {
    const sessionId = reqTurnString(input, 'sessionId');
    const userTurnId = reqTurnString(input, 'userTurnId');
    const message = reqTurnString(input, 'message');
    const steps = new Steps([
      ['load', 'Load session, pinned Body/Soul snapshots and history'],
      ['consent', 'Re-verify embodiment consent (server-enforced, fail-closed)'],
      ['enforce', 'Capability manifests (server-side enforcement)'],
      ['reply', 'Run the Soul (LLM turns + bounded tool rounds)'],
      ['persist', 'Persist agent turn with events, seed and latency'],
    ]);
    await ctx.report({ steps: steps.running('load'), progress: 0.05, status: 'running' });

    const session = await db.agentRuntimeSession.findUnique({
      where: { id: sessionId },
      include: { twin: true, turns: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) throw new Error(`not_found: agent session ${sessionId}`);
    if (session.tenantId !== ctx.tenantId) throw new Error('forbidden: session belongs to another tenant');
    if (session.status !== 'live') {
      throw new Error(`conflict: agent session ${session.id} has ended — the turn cannot run`);
    }
    const userTurn = session.turns.find((t) => t.id === userTurnId);
    if (!userTurn) throw new Error(`not_found: user turn ${userTurnId} not found in session`);

    const bodySnap = await loadBodySnapshot(session.bodyId, session.bodyVersion);
    const soulSnap = await loadSoulSnapshot(session.soulId, session.soulVersion);
    if (!bodySnap) {
      throw new Error(`not_found: Body version snapshot (body ${session.bodyId} v${session.bodyVersion}) is missing — refusing to fabricate a definition`);
    }
    if (!soulSnap) {
      throw new Error(`not_found: Soul version snapshot (soul ${session.soulId} v${session.soulVersion}) is missing — refusing to fabricate a definition`);
    }
    steps.done('load', `body v${session.bodyVersion}, soul v${session.soulVersion}, ${session.turns.length} turns`);

    await ctx.report({ steps: steps.running('consent'), progress: 0.15 });
    // consent re-verified PER TURN (fail-closed: revoked mid-session ends the
    // turn honestly, never silently)
    const grant = await requireConsent(ctx.tenantId, session.twin.subjectId, 'embodiment');
    steps.done('consent', `grant ${grant.id}`);

    // P6.C7 — the turn is verified and running: bound live sessions enter
    // `listening` (the twin is listening to the user's message). Refused
    // turns never emit live states (post-consent ordering is the honest one).
    await pushAgentStatesToLiveSessions(ctx.tenantId, session.id, [
      { state: 'listening', note: 'turn accepted — the twin is listening' },
    ]);

    await ctx.report({ steps: steps.running('enforce'), progress: 0.2 });
    if (!soulSnap.manifest.can.includes('conversation')) {
      throw new Error(
        `policy_blocked: Soul v${session.soulVersion} does not declare the conversation capability — its manifest cannot run chat turns`,
      );
    }
    steps.done('enforce', 'conversation ok; tools gated per invocation');

    await ctx.report({ steps: steps.running('reply'), progress: 0.3 });
    const history = session.turns
      .filter((t) => t.id !== userTurnId)
      .map((t) => ({ role: t.role === 'agent' ? ('agent' as const) : ('user' as const), content: t.content }));
    const agentTurnOrdinal = session.turns.filter((t) => t.role === 'agent').length;
    const turnSeed = deriveTurnSeed(session.seed, agentTurnOrdinal, userTurnId);

    // the pure engine (agent/runtime-core) with the REAL seams injected:
    // chatComplete carries breaker-inside-retry per LLM call; executeAgentTool
    // is the W2.C registry (body-contract enforcement) — the Soul capability
    // manifest is enforced INSIDE the engine before any tool executes.
    // P6.C7: onEvent streams each performance event into bound live sessions
    // AS IT IS EMITTED (thinking → tool_use → thinking → speaking) — the
    // low-latency live path, best-effort by law.
    const result = await runAgentTurnEngine(
      {
        chat: (msgs, opts) => chatComplete(msgs, opts),
        executeTool: (toolCtx, call) => executeAgentTool(toolCtx, call),
        now: () => Date.now(),
        uuid: () => crypto.randomUUID(),
        onEvent: async (event) => {
          // awaited by the engine — pushes stay ordered (no RMW races)
          await pushAgentTurnEventToLiveSessions(ctx.tenantId, session.id, event);
        },
        // P6.B7 turn transparency: the engine's phase boundaries re-report
        // the running `reply` step with an honest detail — "waiting on model"
        // vs "tool round N" — which the session/turns join surfaces so the
        // avatar stage can show WHY it is in its current state. Best-effort by
        // design: a failed transparency report never fails the turn.
        onPhase: (phase) => {
          let detail: string;
          let progress: number;
          if (phase.phase === 'model') {
            detail = phase.call === 'draft'
              ? 'waiting on model — drafting the reply'
              : `waiting on model — follow-up after tool round ${phase.round}`;
            progress = phase.call === 'draft' ? 0.35 : 0.6;
          } else {
            detail = `tool round ${phase.round}: ${phase.tool}${phase.executed ? '' : ' (refused — not executed)'}`;
            progress = 0.5;
          }
          ctx.report({ steps: steps.running('reply', detail), progress }).catch(() => undefined);
        },
      },
      {
        tenantId: ctx.tenantId,
        sessionId: session.id,
        twinId: session.twinId,
        body: {
          name: bodySnap.name,
          role: bodySnap.role,
          description: bodySnap.description,
          version: session.bodyVersion,
          tools: bodySnap.tools,
          manifest: bodySnap.manifest,
          twinVersionId: bodySnap.twinVersionId,
        },
        soul: {
          name: soulSnap.name,
          description: soulSnap.description,
          version: session.soulVersion,
          persona: soulSnap.persona,
          manifest: soulSnap.manifest,
          params: soulSnap.params,
          provider: soulSnap.provider,
          model: soulSnap.model,
          twinDisplayName: session.twin.displayName,
        },
        history,
        message,
        turnSeed,
      },
    );
    steps.done('reply', `${result.llmCalls} LLM call(s), ${result.tools.length} tool round(s), ${result.latencyMs}ms`);

    await ctx.report({ steps: steps.running('persist'), progress: 0.85 });
    // persist ONLY on full success (the core/jobs.ts retry law: a failed
    // attempt leaves no partial output behind)
    const agentTurn = await db.agentRuntimeTurn.create({
      data: {
        sessionId: session.id,
        role: 'agent',
        content: result.reply,
        seed: turnSeed,
        model: result.model,
        states: JSON.stringify(result.events),
        latencyMs: result.latencyMs,
      },
    });

    await emitEvent(ctx.tenantId, 'agent.turn.completed', 'agent_runtime_session', session.id, {
      sessionId: session.id,
      turnId: agentTurn.id,
      userTurnId,
      jobId: ctx.jobId,
      soulId: session.soulId,
      soulVersion: session.soulVersion,
      seed: turnSeed,
      model: result.model,
      latencyMs: result.latencyMs,
      llmCalls: result.llmCalls,
      eventCount: result.events.length,
      consentGrantId: grant.id,
      requestParams: result.requestParams,
    });
    // P6.C7 — the turn is complete: bound live sessions return to `idle`
    // (post-persist, same best-effort law).
    await pushAgentStatesToLiveSessions(ctx.tenantId, session.id, [
      { state: 'idle', note: 'turn complete' },
    ]);
    await recordUsage(ctx.tenantId, 'llm.calls', result.llmCalls, {
      sessionId: session.id,
      soulId: session.soulId,
      soulVersion: session.soulVersion,
      turnId: agentTurn.id,
    });

    await ctx.report({ steps: steps.done('persist', `turn ${agentTurn.id}`), progress: 1 });
    return {
      output: {
        turnId: agentTurn.id,
        replyChars: result.reply.length,
        latencyMs: result.latencyMs,
        llmCalls: result.llmCalls,
        seed: turnSeed,
        requestParams: result.requestParams,
      },
      entities: [
        { type: 'agent_runtime_session', id: session.id },
        { type: 'agent_runtime_turn', id: agentTurn.id },
      ],
    };
  },
};

// P6.C6 — one chat turn through the resilience stack: per-call breaker+retry
// inside ai/zai.ts chatComplete; job-level bounded retry + dead-letter in
// core/jobs.ts runJob wrapping this executor.
registerExecutor(agentTurnExecutor);
