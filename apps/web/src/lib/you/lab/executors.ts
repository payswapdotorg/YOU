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
  OrganizationDescriptor,
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
import { compileOrganizations, compileFromGenome, type PipelineRef } from './organization-compiler';
import { evaluateOrganizations, groundingCall } from './benchmark';
import { cachedCompileOrganizations, cachedGenerateWorld } from './hot-path-cache';
import { generateWorld } from './world';
import { LAB_MUTATE_JOB_KIND, compareOffspring, lineageSummary, naturalChildName } from './mutation';
import { quoteCompute, LOCAL_EXECUTOR_PROVIDER_ID, routedRenderProvider, embeddedComputeRoutingOf, type ComputeQuote, type ComputeSubmission } from './compute';
import { recordClassifiedFailureCase, recordRegionFailures } from './failure-atlas';
import { mutateGenome } from './genome';
// P6.C11 — benchmark artifacts + Failure Atlas production surface: the
// write-once run manifest, the run-comparison/regression contract, the
// soul-swap scenario (SOUL-SWAP-001) and the failure-code taxonomy.
import {
  buildRunManifest,
  resolveWriteOnceTarget,
  type LabScenario,
} from './run-manifest';
import {
  classifyGroundingFailure,
  classifySoulSwapCapabilityLoss,
  classifySoulSwapDrift,
} from './failure-codes';
import {
  SOUL_SWAP_OBJECTIVE_CODE,
  deriveSoulSwapFailureInputs,
  evaluateSoulSwap,
} from './soul-swap';
import { hashString, makeRng } from './determinism';
// P6.C8 — virtual try-on: the provider-neutral adapter contract + pure
// pipeline fold (adapters/try-on.ts). The executor composes it with the real
// seams: content-addressed storage, the C2 render seam (baseline), the
// hosted Vertex call (fail-closed behind YOU_TRYON_PROVIDER) and the recon
// vision seam (identity-preservation comparisons).
import {
  TRYON_ADAPTER,
  TRYON_RENDER_JOB_KIND,
  TryOnRefusal,
  VISUAL_ONLY_DISCLAIMER,
  executeVertexTryOnCall,
  parseVisionComparison,
  resolveTryOnProvider,
  runTryOnPipeline,
  type TryOnFetch,
  type TryOnPipelineProgress,
  type TryOnProviderStatus,
  type TryOnSuccess,
} from '../adapters/try-on';
import { reconVisionCompare } from '../ai/recon-provider';
import { mimeFromKey } from '../core/storage';
// P6.C9 — game/AR export: the deterministic local emitter (adapters/
// game-export.ts, zero-import pure core). The executor composes it with the
// real seams: content-addressed storage for the GLB/VRM binary + the mapping
// table + the manifest, and the honest engine package surface. No provider —
// the fail-closed axes are FORMAT (route validation) and GEOMETRY (the
// usable-geometry gate below, honest refusal, never a default body).
import {
  EXPORT_CLAIMS,
  EXPORT_GLB_JOB_KIND,
  EXPORT_VRM_JOB_KIND,
  ExportRefusal,
  buildPackageManifest,
  checkGeometryUsable,
  parseHtirForExport,
  runExportPipeline,
  type ValidatedExportInput,
} from '../adapters/game-export';

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
// lab.benchmark — the benchmark harness (P6.C11: TWO scenarios —
// HUMAN-RECON-001 reconstruction + SOUL-SWAP-001 identity preservation),
// with the write-once run manifest and the coded failure atlas.
// ═══════════════════════════════════════════════════════════════════════════

registerExecutor({
  kind: 'lab.benchmark',
  async execute(input, ctx) {
    const objectiveCode = optString(input, 'objectiveCode') ?? 'HUMAN-RECON-001';
    const worldSeed = typeof input.worldSeed === 'number' ? Math.floor(input.worldSeed) : 42;
    const benchmarkRunId = optString(input, 'benchmarkRunId');
    // P6.C12: evaluation mode — 'parallel' is the optimized default; the
    // env (YOU_LAB_EVALUATION_MODE) overrides the default, the per-run input
    // overrides the env (controlled before/after experiments).
    const evaluationMode =
      input.evaluationMode === 'sequential' || input.evaluationMode === 'parallel'
        ? input.evaluationMode
        : (process.env.YOU_LAB_EVALUATION_MODE === 'sequential' ? 'sequential' : 'parallel');
    const steps = new Steps([
      ['objective', 'Load lab objective'],
      ['pipelines', 'Load baseline pipelines'],
      ['world', `Generate deterministic world (seed ${worldSeed})`],
      ['compile', 'Compile organizations (generalist / hand-designed / searched)'],
      ['evaluate', `Evaluate on seeded world (${evaluationMode} org evaluation, deterministic simulation + real grounding calls)`],
      ['manifest', 'Build the write-once run manifest'],
      ['persist', 'Persist BenchmarkRun (immutably) + EvaluationReports'],
      ['failures', 'Record failure-atlas entries (taxonomy v1 codes)'],
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
    // P6.C12: deterministic sub-results behind the content-hash memo cache —
    // the same seed returns the exact same world object; hits/misses are
    // counted and persisted as evidence (never exaggerated — the absolute win
    // is small and is reported as measured).
    const worldGenStartedAt = Date.now();
    const cachedWorld = cachedGenerateWorld(worldSeed, generateWorld);
    const world = cachedWorld.world;
    const worldGenMs = Date.now() - worldGenStartedAt;
    steps.done('world', `${world.worldId}${cachedWorld.cache.hit ? ' (cache hit)' : ' (cold)'}`);
    await ctx.report({ steps: steps.all(), progress: 0.3 });

    await ctx.report({ steps: steps.running('compile'), progress: 0.35 });
    const compileStartedAt = Date.now();
    const cachedOrgs = cachedCompileOrganizations(worldSeed, pipelines, compileOrganizations);
    const organizations = cachedOrgs.organizations;
    const compileMs = Date.now() - compileStartedAt;
    steps.done(
      'compile',
      `${organizations.length} organizations${cachedOrgs.cache.hit ? ' (cache hit)' : ' (cold)'}`,
    );
    await ctx.report({ steps: steps.all(), progress: 0.4 });

    await ctx.report({ steps: steps.running('evaluate'), progress: 0.45 });
    // P6.C11: scenario dispatch — HUMAN-RECON-001 (reconstruction) or
    // SOUL-SWAP-001 (identity preservation across soul swaps). Both share the
    // identical honesty model (deterministic sim + ONE real grounding call
    // per organization, every number labeled modeled/observed).
    //
    // MERGE UNION (C11 × C12): the human-recon path keeps C12's evaluation
    // mode wiring — { mode: evaluationMode } flows into evaluateOrganizations
    // and its returned EvaluationStats (mode + observed wall-clock + per-org
    // latencies) persists below in the costLatency evidence. The soul-swap
    // path (added by C11 on the pre-C12 base) has no EvaluationStats of its
    // own, so it measures its own wall-clock and emits the SAME stats shape
    // — honestly labeled 'sequential', which is literally how
    // evaluateSoulSwap runs its per-org loop — so the C12 cost/latency
    // evidence records for BOTH scenarios. Neither side's numbers are lost.
    const isSoulSwap = objective.code === SOUL_SWAP_OBJECTIVE_CODE;
    const scenario: LabScenario = isSoulSwap ? 'soul-swap-001' : 'human-recon-001';
    const { evaluations, aggregate, llmCalls, evaluation } = isSoulSwap
      ? await (async () => {
          const soulSwapStartedAt = Date.now();
          const result = await evaluateSoulSwap(world, organizations, groundingCall);
          return {
            ...result,
            evaluation: {
              mode: 'sequential' as const,
              wallClockMs: Date.now() - soulSwapStartedAt,
              perOrgLatencyMs: result.evaluations.map((e) => e.scores.latencyMs),
            },
          };
        })()
      : await evaluateOrganizations(world, organizations, { mode: evaluationMode });
    steps.done(
      'evaluate',
      `${isSoulSwap ? 'soul-swap' : 'human-recon'} — best: ${aggregate.bestOrganizationId} (grounding calls: ${llmCalls} real; ${evaluation.mode} wall-clock ${evaluation.wallClockMs}ms)`
    );
    await ctx.report({ steps: steps.all(), progress: 0.7 });

    // ── P6.C11: the write-once run manifest ────────────────────────────────
    await ctx.report({ steps: steps.running('manifest'), progress: 0.72 });
    // WRITE-ONCE LAW (resolveWriteOnceTarget): a TERMINAL run (succeeded/
    // failed) is never mutated — a re-run of it targets a NEW row carrying
    // rerunOf = the original id.
    const existingRow = benchmarkRunId
      ? await db.benchmarkRun.findUnique({ where: { id: benchmarkRunId } })
      : null;
    const writeOnce = resolveWriteOnceTarget({
      benchmarkRunId: benchmarkRunId ?? null,
      existingStatus: existingRow ? existingRow.status : null,
      rerunOfFromInput: optString(input, 'rerunOf') ?? null,
    });
    const rerunOfId = writeOnce.rerunOfId;
    const targetRunId = writeOnce.targetRunId;
    const manifest = buildRunManifest({
      objectiveCode,
      scenario,
      worldSeed,
      worldId: world.worldId,
      rerunOf: rerunOfId,
      genomes: [
        {
          pipelineId: pipelines.generalist.id,
          name: pipelines.generalist.name,
          generation: pipelineRows.generalist.generation,
          origin: 'generalist',
          genome: pipelines.generalist.genome,
        },
        {
          pipelineId: pipelines.handDesigned.id,
          name: pipelines.handDesigned.name,
          generation: pipelineRows.handDesigned.generation,
          origin: 'hand-designed',
          genome: pipelines.handDesigned.genome,
        },
        {
          pipelineId: pipelines.searched.id,
          name: pipelines.searched.name,
          generation: pipelineRows.searched.generation,
          origin: 'searched',
          genome: pipelines.searched.genome,
        },
      ],
      organizations: organizations.map((o) => {
        const ev = evaluations.find((e) => e.organizationId === o.descriptor.organizationId);
        const g = (ev?.detail as Record<string, unknown> | undefined)?.groundingCall as
          | { real: boolean; model: string | null }
          | undefined;
        return {
          organizationId: o.descriptor.organizationId,
          origin: o.descriptor.origin,
          pipelineId: o.descriptor.pipelineId ?? '',
          grounding: { real: g?.real ?? false, model: g?.model ?? null },
        };
      }),
      environment: {
        runtime: {
          node: (process.versions.node as string | undefined) ?? null,
          bun: (process.versions.bun as string | undefined) ?? null,
        },
      },
    });
    steps.done('manifest', `${manifest.manifestType} v${manifest.schemaVersion}${rerunOfId ? ` (rerun of ${rerunOfId})` : ''}`);
    await ctx.report({ steps: steps.all(), progress: 0.74 });

    await ctx.report({ steps: steps.running('persist'), progress: 0.75 });
    const now = new Date();
    const runData = {
      objectiveId: objective.id,
      worldSeed,
      status: 'succeeded',
      organizations: JSON.stringify(organizations.map((o) => o.descriptor)),
      manifest: JSON.stringify(manifest),
      ...(rerunOfId ? { rerunOfId } : {}),
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
        // P6.C12 — cost/latency optimization evidence (observed measurements;
        // the wiring in lib/you/lab/optimization-evidence.ts pairs runs into
        // before/after records and surfaces them via GET /api/v1/usage):
        //   evaluation — the run's evaluation mode + observed wall-clock;
        //   compile — content-hash cache stats for the deterministic world /
        //   compiled organizations (cold vs warm pairs are the cache evidence).
        costLatency: {
          evaluation: {
            mode: evaluation.mode,
            wallClockMs: evaluation.wallClockMs,
            perOrgLatencyMs: evaluation.perOrgLatencyMs,
          },
          compile: {
            worldKey: cachedWorld.cache.key,
            worldCacheHit: cachedWorld.cache.hit,
            orgKey: cachedOrgs.cache.key,
            orgCacheHit: cachedOrgs.cache.hit,
            cacheHits: cachedWorld.cache.hits + cachedOrgs.cache.hits,
            cacheMisses: cachedWorld.cache.misses + cachedOrgs.cache.misses,
            worldCompileMs: worldGenMs + compileMs,
          },
          optimizationVersion: 'p6/c12',
        },
      }),
      finishedAt: now,
    };
    // P6.C11 write-once: only a NON-terminal run row (its own queued row) is
    // filled in; anything else — including a re-run of a terminal run — is a
    // NEW BenchmarkRun row referencing its parent via rerunOfId.
    const run = targetRunId
      ? await db.benchmarkRun.update({ where: { id: targetRunId }, data: { ...runData, startedAt: now } })
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
    const failureIds: string[] = [];
    if (isSoulSwap) {
      // SOUL-SWAP-001 failures — derived from the REAL sim output only
      // (bodies below the capability floor, orgs above the drift ceiling).
      // (The dispatch above produced SoulSwapEvaluation[] here — the harness
      // union is structurally narrowed by the scenario check.)
      const soulEvaluations = evaluations as unknown as Array<{
        organizationId: string;
        scores: { drift: number };
        detail: Record<string, unknown>;
      }>;
      for (const ev of soulEvaluations) {
        for (const f of deriveSoulSwapFailureInputs(ev, worldSeed)) {
          const classified =
            f.kind === 'capability-loss'
              ? classifySoulSwapCapabilityLoss(f.input as Parameters<typeof classifySoulSwapCapabilityLoss>[0])
              : classifySoulSwapDrift(f.input as Parameters<typeof classifySoulSwapDrift>[0]);
          const rec = await recordClassifiedFailureCase(db, {
            benchmarkRunId: run.id,
            organizationId: ev.organizationId,
            inputConditions: {
              simulated: true,
              scenario: 'soul-swap-001',
              worldSeed,
              ...f.input,
              note: 'Lab simulation conditions — simulated research truth, not production human truth',
            },
            classified,
            suspectedCause:
              f.kind === 'capability-loss'
                ? `Post-swap capability fit fell below the retention floor for the "${String(f.input.role)}" body (soul ${String(f.input.canonicalSoul)} → ${String(f.input.swappedSoul)}, fit ${String(f.input.fit)}) — the swapped soul does not carry the capabilities the stage demands.`
                : `Post-swap behavioral drift ${String(f.input.drift)} exceeded the ${String(f.input.driftCeiling)} ceiling under the world's noise conditions — soul depth mismatch compounds with sensor noise.`,
            confidence: f.kind === 'capability-loss' ? 0.75 : 0.65,
            remediation:
              f.kind === 'capability-loss'
                ? 'Rebind the deep soul to the deliberative stage (or re-compile the organization) and re-benchmark the swap policy on the same seed.'
                : 'Constrain soul swaps to same-depth souls for this genome, or re-benchmark with a lower-noise world seed.',
          });
          failureIds.push(rec.id);
        }
      }
    } else {
      // HUMAN-RECON-001 failures — uncaptured regions (REGION_UNCAPTURED).
      const regionIds = await recordRegionFailures(db, run.id, worldSeed, evaluations);
      failureIds.push(...regionIds);
    }
    // PROVIDER_GROUNDING_FAILED — real observed failures only: a grounding
    // call that actually failed degrades the score to modeled-only.
    for (const ev of evaluations) {
      const g = (ev.detail as Record<string, unknown>).groundingCall as
        | { real: boolean; model: string | null; error: string | null }
        | undefined;
      if (g && !g.real) {
        const rec = await recordClassifiedFailureCase(db, {
          benchmarkRunId: run.id,
          organizationId: ev.organizationId,
          inputConditions: {
            simulated: true,
            scenario,
            worldSeed,
            organizationId: ev.organizationId,
            note: 'The provider grounding call failed during evaluation — the latency score degraded honestly to modeled-only (no fabricated measurement)',
          },
          classified: classifyGroundingFailure({
            provider: 'zai',
            model: g.model,
            error: g.error ?? 'unknown error',
          }),
          technologyVersions: manifest.technologyVersions,
          suspectedCause: `The real provider grounding call failed for organization ${ev.organizationId} (${g.error ?? 'unknown error'}) — provider unavailable or credentials invalid in this environment.`,
          confidence: 0.9,
          remediation: 'Check provider availability/credentials; re-run the benchmark to re-attempt the grounding measurement.',
        });
        failureIds.push(rec.id);
      }
    }
    steps.done('failures', `${failureIds.length} failure cases (taxonomy v1)`);
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
      scenario,
      worldSeed,
      bestOrganizationId: aggregate.bestOrganizationId,
      organizations: organizations.map((o) => o.descriptor.organizationId),
      llmCalls,
      ...(rerunOfId ? { rerunOf: rerunOfId } : {}),
      simulated: true,
    });
    await recordLlmCalls(ctx.tenantId, llmCalls, { jobKind: 'lab.benchmark', benchmarkRunId: run.id });
    await recordUsage(ctx.tenantId, 'job.lab.benchmark', 1, { benchmarkRunId: run.id, worldSeed });

    return {
      output: {
        benchmarkRunId: run.id,
        ...(rerunOfId ? { rerunOf: rerunOfId } : {}),
        scenario,
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

// ═══════════════════════════════════════════════════════════════════════════
// lab.mutate — the Pipeline Genome loop (P6.C10)
// Deterministic mutation (same parent + same seed → the same offspring —
// natural-key child naming reuses the child row, never duplicates), a REAL
// parent-vs-offspring benchmark on the same seeded world (one grounding
// call per organization attempted; honest modeled-only degrade when the
// provider is unavailable), the honest comparison on the documented
// weighted formula, failure-atlas entries for the offspring, and an
// auto-draft to benchmarked ONLY when the offspring wins. Retired parents
// are refused (the route guards; the executor re-checks — defense in
// depth).
// ═══════════════════════════════════════════════════════════════════════════
registerExecutor({
  kind: LAB_MUTATE_JOB_KIND,
  async execute(input, ctx) {
    const pipelineId = reqString(input, 'pipelineId');
    const mutationSeedRaw = input.mutationSeed;
    if (typeof mutationSeedRaw !== 'number' || !Number.isInteger(mutationSeedRaw) || Math.abs(mutationSeedRaw) > 2 ** 31) {
      throw new Error('validation_failed: input.mutationSeed must be a 31-bit integer');
    }
    const mutationSeed = mutationSeedRaw;
    const worldSeed = typeof input.worldSeed === 'number' && Number.isInteger(input.worldSeed)
      ? input.worldSeed
      : 42;
    const objectiveCode = optString(input, 'objectiveCode') ?? 'HUMAN-RECON-001';
    const steps = new Steps([
      ['load', 'Load the parent pipeline and genome'],
      ['mutate', 'Deterministically mutate the genome'],
      ['offspring', 'Create the child pipeline (natural key)'],
      ['benchmark', 'Benchmark parent vs offspring on the seeded world'],
      ['compare', 'Compare on the documented weighted formula'],
      ['persist', 'Record lineage, failures and the honest verdict'],
    ]);

    await ctx.report({ steps: steps.running('load'), progress: 0.05, status: 'running' });
    const parent = await db.pipelineCandidate.findUnique({ where: { id: pipelineId } });
    if (!parent) throw new Error(`not_found: pipeline candidate ${pipelineId}`);
    if (parent.status === 'retired') {
      throw new Error('conflict: retired pipelines are not mutated — un-retire (revert) first if this lineage should continue');
    }
    const objective = await db.labObjective.findUnique({ where: { code: objectiveCode } });
    if (!objective) throw new Error(`not_found: lab objective ${objectiveCode}`);
    const parentGenome = parseJsonField<PipelineRef['genome']>(parent.genome, {
      stages: [], parameters: {}, skills: [], compute: { class: 'unknown' }, evaluation: { rubric: [], seed: worldSeed },
    });
    steps.done('load', `${parent.name} (generation ${parent.generation}, status ${parent.status})`);
    await ctx.report({ steps: steps.all(), progress: 0.15 });

    await ctx.report({ steps: steps.running('mutate'), progress: 0.2 });
    const childGenome = mutateGenome(parentGenome, mutationSeed);
    const childName = naturalChildName(parent.name, mutationSeed);
    const mutations = Array.isArray(childGenome.parameters.mutations)
      ? childGenome.parameters.mutations.filter((m): m is string => typeof m === 'string')
      : [];
    steps.done('mutate', `${mutations.length} recorded mutations (seed ${mutationSeed}) → ${childName}`);
    await ctx.report({ steps: steps.all(), progress: 0.3 });

    await ctx.report({ steps: steps.running('offspring'), progress: 0.35 });
    // natural key: same parent + same seed → the same child row (reuse, no duplicates)
    let child = await db.pipelineCandidate.findFirst({ where: { name: childName } });
    if (child) {
      child = await db.pipelineCandidate.update({
        where: { id: child.id },
        data: {
          genome: JSON.stringify(childGenome),
          generation: parent.generation + 1,
          parentId: parent.id,
          origin: 'searched',
        },
      });
    } else {
      child = await db.pipelineCandidate.create({
        data: {
          name: childName,
          genome: JSON.stringify(childGenome),
          generation: parent.generation + 1,
          parentId: parent.id,
          origin: 'searched',
          status: 'draft',
        },
      });
    }
    steps.done('offspring', `${childName} (generation ${child.generation})`);
    await ctx.report({ steps: steps.all(), progress: 0.45 });

    await ctx.report({ steps: steps.running('benchmark'), progress: 0.5 });
    const world = generateWorld(worldSeed);
    const parentOrg = compileFromGenome(
      parentGenome,
      parent.origin as OrganizationDescriptor['origin'],
      `org-mutate-${parent.id}`,
      `${parent.name} (parent)`,
      parent.id,
    );
    const childOrg = compileFromGenome(
      childGenome,
      'searched',
      `org-mutate-${child.id}`,
      `${childName} (offspring)`,
      child.id,
    );
    const { evaluations, aggregate, llmCalls } = await evaluateOrganizations(world, [parentOrg, childOrg]);
    const now = new Date();
    const run = await db.benchmarkRun.create({
      data: {
        objectiveId: objective.id,
        worldSeed,
        status: 'succeeded',
        organizations: JSON.stringify([parentOrg.descriptor, childOrg.descriptor]),
        metrics: JSON.stringify({
          simulated: true,
          simulationNote:
            'Lab genome-loop results are SIMULATED research truth (deterministic seeded simulation + explicitly-labeled real provider grounding measurements); never production human truth',
          kind: 'lab.mutate',
          mutationSeed,
          parentPipelineId: parent.id,
          childPipelineId: child.id,
          aggregate,
          perOrganization: evaluations.map((e) => ({
            organizationId: e.organizationId,
            scores: e.scores,
            reproducible: e.reproducible,
          })),
        }),
        startedAt: now,
        finishedAt: now,
      },
    });
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
    steps.done('benchmark', `run ${run.id} — ${evaluations.length} organizations, ${llmCalls} real grounding calls`);
    await ctx.report({ steps: steps.all(), progress: 0.75 });

    await ctx.report({ steps: steps.running('compare'), progress: 0.8 });
    const evalFor = (organizationId: string) =>
      evaluations.find((e) => e.organizationId === organizationId) ?? null;
    const parentEval = evalFor(parentOrg.descriptor.organizationId);
    const childEval = evalFor(childOrg.descriptor.organizationId);
    if (!parentEval || !childEval) {
      throw new Error('internal: parent/offspring evaluation missing from the benchmark result');
    }
    const comparison = compareOffspring(parentEval.scores, childEval.scores);
    steps.done(
      'compare',
      comparison.childBetter
        ? `offspring wins (${comparison.childScore} vs parent ${comparison.parentScore}, Δ ${comparison.delta})`
        : `offspring does not win (${comparison.childScore} vs parent ${comparison.parentScore}, Δ ${comparison.delta})`,
    );
    await ctx.report({ steps: steps.all(), progress: 0.85 });

    await ctx.report({ steps: steps.running('persist'), progress: 0.9 });
    const failureIds = await recordRegionFailures(db, run.id, worldSeed, [childEval]);
    let childStatus = child.status;
    if (comparison.childBetter && child.status === 'draft') {
      await db.promotionRecord.create({
        data: {
          pipelineId: child.id,
          fromStatus: 'draft',
          toStatus: 'benchmarked',
          decision: 'drafted',
          evidence: JSON.stringify({
            benchmarkRunId: run.id,
            mutationSeed,
            worldSeed,
            objectiveCode,
            comparison,
            note: 'auto-draft — the offspring won the parent-vs-offspring benchmark on the documented weighted formula; TL owns promotion',
            simulated: true,
          }),
          decidedBy: 'lab.mutate executor (auto-draft on offspring win; TL owns promotion)',
        },
      });
      const updated = await db.pipelineCandidate.update({
        where: { id: child.id },
        data: { status: 'benchmarked' },
      });
      childStatus = updated.status;
    }
    const lineage = lineageSummary(parent, mutationSeed, childGenome.parameters.mutations);
    steps.done(
      'persist',
      `${failureIds.length} failure cases for the offspring; child status "${childStatus}"`,
    );
    await ctx.report({ steps: steps.all(), progress: 1 });

    await emitEvent(ctx.tenantId, 'lab.mutation.succeeded', 'pipeline_candidate', child.id, {
      jobId: ctx.jobId,
      benchmarkRunId: run.id,
      parentPipelineId: parent.id,
      childPipelineId: child.id,
      childName,
      mutationSeed,
      worldSeed,
      objectiveCode,
      childBetter: comparison.childBetter,
      simulated: true,
    });
    await recordLlmCalls(ctx.tenantId, llmCalls, { jobKind: 'lab.mutate', benchmarkRunId: run.id });
    await recordUsage(ctx.tenantId, 'job.lab.mutate', 1, {
      benchmarkRunId: run.id,
      pipelineId: parent.id,
      childPipelineId: child.id,
      mutationSeed,
      worldSeed,
    });

    return {
      output: {
        benchmarkRunId: run.id,
        parentPipelineId: parent.id,
        parentName: parent.name,
        childPipelineId: child.id,
        childName,
        childStatus,
        mutationSeed,
        worldSeed,
        objectiveCode,
        comparison: {
          childBetter: comparison.childBetter,
          delta: comparison.delta,
          parentScore: comparison.parentScore,
          childScore: comparison.childScore,
          formula: comparison.formula,
          note: comparison.note,
        },
        lineage,
        failureCaseIds: failureIds,
        simulated: true,
      },
      entities: [
        { type: 'benchmarkRun', id: run.id },
        { type: 'pipelineCandidate', id: child.id },
        { type: 'pipelineCandidate', id: parent.id },
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

// ═══════════════════════════════════════════════════════════════════════
// tryon.render — virtual try-on (P6.C8, adapters/try-on.ts contract)
//
// The honest pipeline: fail-closed provider gate → consent re-verify →
// baseline render (the C2 seam — a stylized avatar render derived from the
// consented HTIR, the anti-impersonation prompt policy enforced there) →
// hosted try-on call (person image + garment image) → content-addressed
// store → diff manifest + identity-preservation report → ONE comparison
// OutputArtifact (kind 'tryon-comparison') carrying BOTH renders, the
// manifest, the report and the visual-only disclaimer (contract field).
//
// Without YOU_TRYON_PROVIDER the job FAILS HONESTLY at the provider step
// with the verbatim reason — never a stub image, never a fabricated score.
// 'tryon.completed' carries the merchant-callback shape (productRef +
// artifact refs + the disclaimer) and fans out through the existing signed
// webhook delivery path (F-04 X-You-Signature law).
// ═══════════════════════════════════════════════════════════════════════

async function loadTryOnJob(tryOnJobId: string, tenantId: string) {
  const job = await db.tryOnJob.findUnique({
    where: { id: tryOnJobId },
    include: { twin: true, twinVersion: true, garmentAsset: true },
  });
  if (!job) throw new Error(`not_found: try-on job ${tryOnJobId}`);
  if (job.tenantId !== tenantId) throw new Error(`forbidden: try-on job belongs to another tenant`);
  if (!job.twin || !job.twinVersion) throw new Error(`not_found: twin version ${job.twinVersionId} for try-on job`);
  if (!job.garmentAsset) throw new Error(`not_found: garment asset ${job.garmentAssetId} for try-on job`);
  return job;
}

const TRYON_IDENTITY_PROMPT =
  'You are shown two images: IMAGE 1 then IMAGE 2. Judge whether IMAGE 2 preserves the visual identity of the subject of IMAGE 1 (same person or same garment, as the caller specifies by context). Reply with ONLY a JSON object: {"score": <similarity 0.0-1.0>, "note": "<one short sentence>"}. Do not reply with anything else.';

function toDataUrl(buf: Buffer, mime: string): string {
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function tryOnTimeoutMs(): number {
  const n = Number(process.env.YOU_TRYON_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}

registerExecutor({
  kind: TRYON_RENDER_JOB_KIND,
  async execute(input, ctx) {
    const tryOnJobId = reqString(input, 'tryOnJobId');
    const steps = new Steps([
      ['validate', 'Load try-on job, twin version and garment'],
      ['consent', 'Verify render consent (server-enforced)'],
      ['provider', 'Resolve the try-on provider (fail-closed)'],
      ['baseline', 'Render the twin baseline image (body-aware base)'],
      ['tryon', 'Run the hosted virtual try-on'],
      ['comparison', 'Build diff manifest + identity-preservation report'],
      ['persist', 'Persist comparison artifact with the visual-only disclaimer'],
    ]);

    await ctx.report({ steps: steps.running('validate'), progress: 0.05, status: 'running' });
    const job = await loadTryOnJob(tryOnJobId, ctx.tenantId);
    const htir = parseJsonField<HTIR>(job.twinVersion.htir, null as unknown as HTIR);
    if (!htir) throw new Error(`internal_error: twin version ${job.twinVersionId} has unparseable HTIR`);
    const style = parseStyle(job.style, 'photorealistic');
    await db.tryOnJob.update({ where: { id: job.id }, data: { status: 'running', startedAt: new Date() } });
    steps.done(
      'validate',
      `twin ${job.twin.displayName} v${job.twinVersion.version}, garment "${job.garmentAsset.displayName}"${job.garmentAsset.productRef ? ` (ref ${job.garmentAsset.productRef})` : ''}`,
    );
    await ctx.report({ steps: steps.all(), progress: 0.1 });

    await ctx.report({ steps: steps.running('consent'), progress: 0.12 });
    const grants = await activeGrantsFor(job.twin.subjectId, job.twin.tenantId, 'render');
    assertConsent(grants, job.twin.subjectId, 'render');
    steps.done('consent', `${grants.length} active render-scope grant(s)`);
    await ctx.report({ steps: steps.all(), progress: 0.15 });

    // FAIL-CLOSED provider gate — BEFORE any provider spend (baseline render
    // included). The typed refusal fails the job with the verbatim reason and
    // the TryOnJob row records it (never left queued forever).
    await ctx.report({ steps: steps.running('provider'), progress: 0.18 });
    const providerStatus: TryOnProviderStatus = resolveTryOnProvider({
      provider: process.env.YOU_TRYON_PROVIDER,
      vertexProject: process.env.YOU_TRYON_VERTEX_PROJECT,
      vertexLocation: process.env.YOU_TRYON_VERTEX_LOCATION,
      vertexKey: process.env.YOU_TRYON_VERTEX_KEY,
    });
    if (!providerStatus.available) {
      steps.failed('provider', providerStatus.reason);
      await ctx.report({ steps: steps.all(), status: 'failed' }).catch(() => undefined);
      await db.tryOnJob
        .update({ where: { id: job.id }, data: { status: 'failed', error: providerStatus.reason, finishedAt: new Date() } })
        .catch(() => undefined);
      throw new TryOnRefusal('tryon_unavailable', providerStatus.reason);
    }
    steps.done('provider', `${providerStatus.provider} (project ${providerStatus.project}, location ${providerStatus.location})`);
    await ctx.report({ steps: steps.all(), progress: 0.2 });

    // the vision-comparison state: the reason is captured DURING the pipeline
    // (getter) so the identity report quotes the real unavailability cause
    const visionState: { reason?: string } = {};
    const routed = routedRenderProvider(input);
    const onProgress = async (p: TryOnPipelineProgress) => {
      const map: Record<TryOnPipelineProgress['step'], string> = {
        provider: 'provider',
        baseline: 'baseline',
        tryon: 'tryon',
        comparison: 'comparison',
      };
      const progressByStep: Record<TryOnPipelineProgress['step'], number> = {
        provider: 0.2,
        baseline: 0.35,
        tryon: 0.7,
        comparison: 0.82,
      };
      await ctx.report({ steps: steps.running(map[p.step], p.detail), progress: progressByStep[p.step] }).catch(() => undefined);
    };

    let result: TryOnSuccess;
    try {
      result = await runTryOnPipeline(
        { garmentStorageKey: job.garmentAsset.storageKey, garmentMime: job.garmentAsset.mime },
        {
          resolveProvider: () => providerStatus,
          loadGarmentBytes: async (storageKey) => {
            const buf = await getObject(storageKey);
            return buf ? new Uint8Array(buf) : null;
          },
          renderBaseline: async () => {
            // the C2 seam: a stylized avatar render derived from the consented
            // HTIR (body-aware — morphology/appearance descriptors feed the
            // prompt; the anti-impersonation policy is enforced inside)
            const r = await renderPortraitImage(htir, style, routed !== undefined ? { provider: routed } : {});
            await recordUsage(ctx.tenantId, 'provider.image.calls', 1, {
              jobKind: 'tryon.render',
              tryOnJobId: job.id,
              phase: 'baseline',
              latencyMs: r.latencyMs,
            });
            return {
              storageKey: r.storageKey,
              contentHash: r.contentHash,
              bytes: r.bytes,
              mime: r.mime,
              latencyMs: r.latencyMs,
              provider: typeof r.meta.provider === 'string' ? r.meta.provider : 'unknown',
              providerModel: typeof r.meta.providerModel === 'string' ? r.meta.providerModel : null,
            };
          },
          storeTryOnImage: async (bytes, mime) => putObject(Buffer.from(bytes), { kind: 'tryon', mime }),
          callProvider: async (baseline, garment) => {
            const personBuf = await getObject(baseline.storageKey);
            if (!personBuf) {
              throw new TryOnRefusal('validation_failed', `baseline image "${baseline.storageKey}" not found in object storage`);
            }
            return executeVertexTryOnCall(
              providerStatus,
              { personImage: new Uint8Array(personBuf), garmentImage: garment.bytes },
              {
                personMime: baseline.mime,
                garmentMime: garment.mime,
                apiKey: process.env.YOU_TRYON_VERTEX_KEY ?? '',
                fetchImpl: fetch as unknown as TryOnFetch,
                timeoutMs: tryOnTimeoutMs(),
              },
            );
          },
          compareImages: async (a, b) => {
            try {
              const [aBuf, bBuf] = await Promise.all([getObject(a.storageKey), getObject(b.storageKey)]);
              if (!aBuf || !bBuf) {
                visionState.reason = 'one of the identity-comparison images is missing from object storage';
                return null;
              }
              const vision = await reconVisionCompare(
                toDataUrl(aBuf, mimeFromKey(a.storageKey)),
                toDataUrl(bBuf, mimeFromKey(b.storageKey)),
                TRYON_IDENTITY_PROMPT,
              );
              const parsed = parseVisionComparison(vision.content);
              if (!parsed) {
                visionState.reason =
                  'the vision comparison response did not parse into a score — refusing to guess an identity preservation value';
                return null;
              }
              return parsed;
            } catch (err) {
              visionState.reason = err instanceof Error ? err.message : String(err);
              return null;
            }
          },
          garmentProductRef: job.garmentAsset.productRef,
          // the artifact records the garment's product reference VERBATIM (the
          // preservation invariant assertTryOnSuccess enforces)
          artifactProductRef: job.garmentAsset.productRef,
          get visionUnavailableReason() {
            return visionState.reason;
          },
        },
        onProgress,
      );
    } catch (err) {
      // honest terminal state on the TryOnJob row: verbatim error, finished
      const message = err instanceof Error ? err.message : String(err);
      steps.failed('tryon', message.slice(0, 300));
      await ctx.report({ steps: steps.all(), status: 'failed' }).catch(() => undefined);
      await db.tryOnJob
        .update({ where: { id: job.id }, data: { status: 'failed', error: message, finishedAt: new Date() } })
        .catch(() => undefined);
      throw err;
    }

    steps.done('baseline', `baseline stored (${result.baseline.bytes} bytes)`);
    steps.done('tryon', `${result.latencyMs}ms real provider latency (${result.provider})`);
    steps.done(
      'comparison',
      `garment ${result.identityReport.garmentIdentity.status}, twin ${result.identityReport.twinIdentity.status}, productRef ${
        result.identityReport.productRefPreserved ? 'preserved' : 'NOT preserved'
      }`,
    );
    await ctx.report({ steps: steps.all(), progress: 0.88 });

    await ctx.report({ steps: steps.running('persist'), progress: 0.9 });
    const artifact = await db.outputArtifact.create({
      data: {
        tenantId: job.tenantId,
        kind: 'tryon-comparison',
        storageKey: result.storageKey,
        contentHash: result.contentHash,
        bytes: result.bytes,
        mime: result.mime,
        meta: JSON.stringify({
          adapterId: TRYON_ADAPTER.adapterId,
          adapterVersion: TRYON_ADAPTER.version,
          // THE contract field — rendered prominently by every view, echoed in
          // the merchant callback, verified by assertTryOnSuccess
          visualOnlyDisclaimer: result.visualOnlyDisclaimer,
          identityReport: result.identityReport,
          diffManifest: result.diffManifest,
          provider: {
            id: result.provider,
            model: result.providerModel,
            taskId: result.providerTaskId,
            latencyMs: result.latencyMs,
            realLatency: true,
          },
          comparison: {
            baseline: result.baseline,
            tryOn: { storageKey: result.storageKey, contentHash: result.contentHash, bytes: result.bytes, mime: result.mime },
            garment: {
              assetId: job.garmentAsset.id,
              displayName: job.garmentAsset.displayName,
              productRef: job.garmentAsset.productRef,
              productUrl: job.garmentAsset.productUrl,
              storageKey: job.garmentAsset.storageKey,
              contentHash: job.garmentAsset.contentHash,
            },
          },
          provenance: {
            twinId: job.twinId,
            twinVersionId: job.twinVersionId,
            garmentAssetId: job.garmentAssetId,
            consentGrantIds: grants.map((g) => g.id),
            subjectId: job.twin.subjectId,
            style,
            costUsd: null,
            costBasis: 'provider pricing not exposed to this sandbox — costUsd stays null (never recorded as observed)',
          },
        }),
      },
    });
    await db.tryOnJob.update({
      where: { id: job.id },
      data: { status: 'succeeded', artifactId: artifact.id, finishedAt: new Date() },
    });
    steps.done('persist', `artifact ${artifact.id} (kind tryon-comparison)`);
    await ctx.report({ steps: steps.all(), progress: 1 });

    // the merchant callback shape: everything an e-commerce integration needs
    // (product reference preserved verbatim + artifact refs + the disclaimer)
    // — delivered through the existing signed webhook fan-out (F-04 law)
    await emitEvent(ctx.tenantId, 'tryon.completed', 'tryOnJob', job.id, {
      tryOnJobId: job.id,
      jobId: ctx.jobId,
      artifactId: artifact.id,
      garmentAssetId: job.garmentAsset.id,
      productRef: job.garmentAsset.productRef,
      twinId: job.twinId,
      twinVersionId: job.twinVersionId,
      identityChecksPassed: result.identityReport.checksPassed,
      visualOnlyDisclaimer: VISUAL_ONLY_DISCLAIMER,
    });
    await recordUsage(ctx.tenantId, 'job.tryon.render', 1, {
      tryOnJobId: job.id,
      artifactId: artifact.id,
      providerLatencyMs: result.latencyMs,
    });

    return {
      output: {
        tryOnJobId: job.id,
        artifactId: artifact.id,
        identityReport: result.identityReport,
        diffManifest: result.diffManifest,
        visualOnlyDisclaimer: result.visualOnlyDisclaimer,
        provider: result.provider,
        providerLatencyMs: result.latencyMs,
      },
      entities: [
        { type: 'tryOnJob', id: job.id },
        { type: 'outputArtifact', id: artifact.id },
        { type: 'garmentAsset', id: job.garmentAsset.id },
      ],
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// export.glb / export.vrm — game/AR export (P6.C9, adapters/game-export.ts)
//
// The honest pipeline: consent re-verify (reconstruct scope — an export
// reconstructs the twin's HTIR geometry into a new engine representation) →
// usable-geometry gate (fail-closed: unknown skeleton convention or no
// finite measurements → honest refusal, NEVER a default body pretending to
// be this twin) → the deterministic local emitter (byte-identical for
// identical TwinVersion + options; three REAL LOD meshes, VRM 0.x extension
// on the vrm path, zero-delta facial placeholders only for the HTIR
// articulation set) → THREE OutputArtifacts (the GLB/VRM binary, the
// machine-readable retargeting mapping table, the structural-vs-derived
// manifest) + the honest engine package manifest whose README states
// exactly what is and is NOT included. No provider, no network, no secrets.
// ═══════════════════════════════════════════════════════════════════════════

async function loadExportJob(exportJobId: string, tenantId: string) {
  const job = await db.exportJob.findUnique({
    where: { id: exportJobId },
    include: { twin: true, twinVersion: true },
  });
  if (!job) throw new Error(`not_found: export job ${exportJobId}`);
  if (job.tenantId !== tenantId) throw new Error(`forbidden: export job belongs to another tenant`);
  if (!job.twin || !job.twinVersion) throw new Error(`not_found: twin version ${job.twinVersionId} for export job`);
  return job;
}

async function executeExportJob(
  input: Record<string, unknown>,
  ctx: JobContext,
  format: 'glb' | 'vrm',
): Promise<{ output: Record<string, unknown>; entities?: Array<{ type: string; id: string }> }> {
  const exportJobId = reqString(input, 'exportJobId');
  const steps = new Steps([
    ['validate', 'Load export job, twin version and HTIR'],
    ['consent', 'Verify reconstruct consent (server-enforced)'],
    ['geometry', 'Check HTIR geometry usability (fail-closed)'],
    ['emit', `Emit the deterministic ${format.toUpperCase()} bundle (LODs + mapping)`],
    ['persist', 'Persist export artifacts with the honest manifest'],
  ]);

  await ctx.report({ steps: steps.running('validate'), progress: 0.05, status: 'running' });
  const job = await loadExportJob(exportJobId, ctx.tenantId);
  const lodLevel = typeof job.lodLevel === 'number' && job.lodLevel >= 0 && job.lodLevel <= 2 ? job.lodLevel : 0;
  const includeFacialControls = job.includeFacialControls === true;
  await db.exportJob.update({ where: { id: job.id }, data: { status: 'running', startedAt: new Date() } });
  steps.done(
    'validate',
    `twin ${job.twin.displayName} v${job.twinVersion.version}, format ${format}, lodLevel ${lodLevel}${includeFacialControls ? '' : ', facial controls omitted by option'}`,
  );
  await ctx.report({ steps: steps.all(), progress: 0.15 });

  await ctx.report({ steps: steps.running('consent'), progress: 0.2 });
  const grants = await activeGrantsFor(job.twin.subjectId, job.twin.tenantId, 'reconstruct');
  assertConsent(grants, job.twin.subjectId, 'reconstruct');
  steps.done('consent', `${grants.length} active reconstruct-scope grant(s)`);
  await ctx.report({ steps: steps.all(), progress: 0.25 });

  // FAIL-CLOSED usable-geometry gate — BEFORE any emission. The typed
  // refusal fails the job with the verbatim reason and the ExportJob row
  // records it (never left queued forever, never a default body).
  await ctx.report({ steps: steps.running('geometry'), progress: 0.3 });
  const rawHtir = parseJsonField<unknown>(job.twinVersion.htir, null);
  const gate = checkGeometryUsable(parseHtirForExport(rawHtir));
  if (!gate.ok) {
    steps.failed('geometry', gate.reason);
    await ctx.report({ steps: steps.all(), status: 'failed' }).catch(() => undefined);
    await db.exportJob
      .update({ where: { id: job.id }, data: { status: 'failed', error: gate.reason, finishedAt: new Date() } })
      .catch(() => undefined);
    throw new ExportRefusal('geometry_unavailable', gate.reason);
  }
  steps.done('geometry', `skeleton ${gate.htir.skeleton}, ${Object.keys(gate.htir.measurements).length} structural measurement(s)`);
  await ctx.report({ steps: steps.all(), progress: 0.35 });

  // the deterministic local emission (pure; assertExportSuccess enforces
  // the honest-claims contract on the composed result)
  await ctx.report({ steps: steps.running('emit'), progress: 0.4 });
  const exportInput: ValidatedExportInput = {
    twinId: job.twinId,
    twinVersionId: job.twinVersionId,
    format,
    lodLevel: lodLevel as 0 | 1 | 2,
    includeFacialControls,
  };
  let result;
  try {
    result = runExportPipeline(rawHtir, exportInput);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    steps.failed('emit', message.slice(0, 300));
    await ctx.report({ steps: steps.all(), status: 'failed' }).catch(() => undefined);
    await db.exportJob
      .update({ where: { id: job.id }, data: { status: 'failed', error: message, finishedAt: new Date() } })
      .catch(() => undefined);
    throw err;
  }
  steps.done(
    'emit',
    `${result.bytes.length} bytes, LODs ${result.manifest.lods.map((l) => `${l.triangles}t`).join('/')} (real emitted counts), ${result.mappingTable.blendshapes.length} facial placeholder(s)`,
  );
  await ctx.report({ steps: steps.all(), progress: 0.7 });

  // persist: the model binary + the mapping table + the manifest, all
  // content-addressed; then the honest engine package manifest referencing
  // the three stored files
  await ctx.report({ steps: steps.running('persist'), progress: 0.75 });
  const modelStored = await putObject(Buffer.from(result.bytes), { kind: 'export', mime: 'model/gltf-binary' });
  const mappingStored = await putObject(Buffer.from(JSON.stringify(result.mappingTable)), {
    kind: 'export',
    mime: 'application/json',
  });
  const manifestStored = await putObject(Buffer.from(JSON.stringify(result.manifest)), {
    kind: 'export',
    mime: 'application/json',
  });

  const mappingArtifact = await db.outputArtifact.create({
    data: {
      tenantId: job.tenantId,
      kind: 'game-export-mapping',
      storageKey: mappingStored.storageKey,
      contentHash: mappingStored.contentHash,
      bytes: mappingStored.bytes,
      mime: 'application/json',
      meta: JSON.stringify({
        adapterId: 'game-export-1',
        adapterVersion: '1',
        role: 'retargeting-mapping',
        format,
        note: 'machine-readable bone/blendshape mapping table (VRM + Unity Mecanim + UE5 mannequin conventions + ARKit blendshape names where they map)',
      }),
    },
  });
  const manifestArtifact = await db.outputArtifact.create({
    data: {
      tenantId: job.tenantId,
      kind: 'game-export-manifest',
      storageKey: manifestStored.storageKey,
      contentHash: manifestStored.contentHash,
      bytes: manifestStored.bytes,
      mime: 'application/json',
      meta: JSON.stringify({
        adapterId: 'game-export-1',
        adapterVersion: '1',
        role: 'export-manifest',
        format,
        note: 'the structural-vs-derived honesty manifest (part of the export contract)',
      }),
    },
  });
  const packageManifest = buildPackageManifest({
    format,
    files: [
      {
        role: 'model',
        // placeholder — buildPrimaryMeta closes this self-reference with the
        // REAL primary artifact id after the row is created
        artifactId: 'pending',
        storageKey: modelStored.storageKey,
        contentHash: modelStored.contentHash,
        bytes: modelStored.bytes,
        mime: 'model/gltf-binary',
      },
      {
        role: 'retargeting-mapping',
        artifactId: mappingArtifact.id,
        storageKey: mappingStored.storageKey,
        contentHash: mappingStored.contentHash,
        bytes: mappingStored.bytes,
        mime: 'application/json',
      },
      {
        role: 'export-manifest',
        artifactId: manifestArtifact.id,
        storageKey: manifestStored.storageKey,
        contentHash: manifestStored.contentHash,
        bytes: manifestStored.bytes,
        mime: 'application/json',
      },
    ],
  });

  // the primary artifact's meta references its own id in the package
  // manifest (the model file entry) — created once, closed with one update
  const buildPrimaryMeta = (modelArtifactId: string) => ({
    adapterId: 'game-export-1',
    adapterVersion: '1',
    // THE contract field — checked by every view, verified by
    // assertExportSuccess, stated in the package README
    visualClaims: EXPORT_CLAIMS,
    manifest: result.manifest,
    mappingTable: result.mappingTable,
    packageManifest: {
      ...packageManifest,
      files: packageManifest.files.map((f) => (f.role === 'model' ? { ...f, artifactId: modelArtifactId } : f)),
    },
    companionArtifacts: [
      { role: 'retargeting-mapping', artifactId: mappingArtifact.id },
      { role: 'export-manifest', artifactId: manifestArtifact.id },
    ],
    provenance: {
      twinId: job.twinId,
      twinVersionId: job.twinVersionId,
      consentGrantIds: grants.map((g) => g.id),
      subjectId: job.twin.subjectId,
      format,
      lodLevel,
      includeFacialControls,
      deterministic: true,
      costUsd: 0,
      costBasis: 'local deterministic emitter — no provider call, no cost',
    },
  });
  const primaryArtifact = await db.outputArtifact.create({
    data: {
      tenantId: job.tenantId,
      kind: 'game-export',
      storageKey: modelStored.storageKey,
      contentHash: modelStored.contentHash,
      bytes: modelStored.bytes,
      mime: 'model/gltf-binary',
      meta: JSON.stringify(buildPrimaryMeta('pending')),
    },
  });
  // close the self-reference: the package manifest now points at the REAL
  // primary artifact id
  await db.outputArtifact.update({
    where: { id: primaryArtifact.id },
    data: { meta: JSON.stringify(buildPrimaryMeta(primaryArtifact.id)) },
  });
  await db.exportJob.update({
    where: { id: job.id },
    data: { status: 'succeeded', artifactId: primaryArtifact.id, finishedAt: new Date() },
  });
  steps.done(
    'persist',
    `artifacts ${primaryArtifact.id} (model) + ${mappingArtifact.id} (mapping) + ${manifestArtifact.id} (manifest)`,
  );
  await ctx.report({ steps: steps.all(), progress: 1 });

  // the engine-integration callback shape: everything a Unity/Unreal/AR
  // consumer needs (artifact refs + the honest claims text) — delivered
  // through the event stream the webhook fan-out already serves
  await emitEvent(ctx.tenantId, 'export.completed', 'exportJob', job.id, {
    exportJobId: job.id,
    jobId: ctx.jobId,
    artifactId: primaryArtifact.id,
    mappingArtifactId: mappingArtifact.id,
    manifestArtifactId: manifestArtifact.id,
    twinId: job.twinId,
    twinVersionId: job.twinVersionId,
    format,
    lodLevel,
    lods: result.manifest.lods,
    claims: EXPORT_CLAIMS,
  });
  await recordUsage(ctx.tenantId, `job.export.${format}`, 1, {
    exportJobId: job.id,
    artifactId: primaryArtifact.id,
    bytes: modelStored.bytes,
  });

  return {
    output: {
      exportJobId: job.id,
      artifactId: primaryArtifact.id,
      mappingArtifactId: mappingArtifact.id,
      manifestArtifactId: manifestArtifact.id,
      format,
      lodLevel,
      lods: result.manifest.lods,
      claims: EXPORT_CLAIMS,
    },
    entities: [
      { type: 'exportJob', id: job.id },
      { type: 'outputArtifact', id: primaryArtifact.id },
      { type: 'outputArtifact', id: mappingArtifact.id },
      { type: 'outputArtifact', id: manifestArtifact.id },
    ],
  };
}

registerExecutor({
  kind: EXPORT_GLB_JOB_KIND,
  async execute(input, ctx) {
    return executeExportJob(input, ctx, 'glb');
  },
});

registerExecutor({
  kind: EXPORT_VRM_JOB_KIND,
  async execute(input, ctx) {
    return executeExportJob(input, ctx, 'vrm');
  },
});
