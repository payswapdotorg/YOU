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
import { signStorageUrl, putObject } from '../core/storage';
import {
  analyzeAssetQuality,
  analyzeEvidenceSet,
  VLM_RECON_ADAPTER,
  type VlmReconAssetInput,
} from '../adapters/vlm-recon';
import { renderPortraitSvg, SVG_PORTRAIT_ADAPTER } from '../adapters/svg-portrait';
import { renderPortraitImage, AI_IMAGE_ADAPTER, buildImagePrompt } from '../adapters/ai-image';
import { renderPortraitVideo, AI_VIDEO_ADAPTER } from '../adapters/ai-video';
import { chatComplete } from '../ai/zai';
import { emitEvent, recordLlmCalls, recordUsage } from './events';
import { generateWorld } from './world';
import { compileOrganizations, type PipelineRef } from './organization-compiler';
import { evaluateOrganizations } from './benchmark';
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

    await ctx.report({ steps: steps.running('analyze', `${assets.length} assets`), progress: 0.25 });
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
    const manifest: SolutionArtifactManifest = {
      solutionId: 'pending',
      version: 1,
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
      provenance: {
        ...htir.provenance,
        inferenceOnly: VLM_RECON_ADAPTER.inferenceOnly,
        trainingOnBiometrics: VLM_RECON_ADAPTER.trainingOnBiometrics,
        usage: analysis.usage,
        deficiencyCount: analysis.htirDraft.confidence.deficiencies.length,
      },
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
    const manifestFinal = { ...manifest, solutionId: solution.id };
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
  twinVersionId: string;
  twinVersionVersion: number;
  twinDisplayName: string;
  pipelineId: string | null;
  adapterComponents: { adapterId: string; version: string }[];
  artifacts: { artifactId: string; label: string; kind: string; storageKey: string }[];
  subjectId: string;
  grantIds: string[];
}): Promise<string> {
  const manifest: SolutionArtifactManifest = {
    solutionId: 'pending',
    version: 1,
    type: 'render-review',
    title: `Render review — ${opts.twinDisplayName} v${opts.twinVersionVersion}`,
    inputs: [{ label: `Render job ${opts.renderJobId}`, kind: 'renderJob', ref: opts.renderJobId }],
    twinVersion: { id: opts.twinVersionId, version: opts.twinVersionVersion },
    performance: null,
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
    provenance: {
      components: opts.adapterComponents,
      note: 'render provenance: adapter versions recorded per artifact; deterministic renderer costs 0 USD',
    },
    feedback_schema: { verdicts: [...FEEDBACK_VERDICTS], regions: [...REVIEW_REGIONS] },
    evidence_request_schema: { capabilities: [] },
    export_targets: ['svg', 'png'],
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
  const final = { ...manifest, solutionId: solution.id };
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
    let artifactId: string;
    let representationKind: string;
    let latencyMs: number;
    let costUsd: number | null;
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
    } else {
      const result = await renderPortraitImage(htir, style);
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
      twinVersionId: job.twinVersionId,
      twinVersionVersion: job.twinVersion.version,
      twinDisplayName: job.twin.displayName,
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
      output: { artifactId, solutionArtifactId: solutionId, adapterId: adapter, latencyMs, costUsd },
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
    let result;
    try {
      result = await renderPortraitVideo({ htir, style, baseImage });
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
      twinVersionId: job.twinVersionId,
      twinVersionVersion: job.twinVersion.version,
      twinDisplayName: job.twin.displayName,
      pipelineId: job.twinVersion.pipelineId,
      adapterComponents: [
        { adapterId: VLM_RECON_ADAPTER.adapterId, version: VLM_RECON_ADAPTER.version },
        ...(svgBaseArtifactId ? [{ adapterId: SVG_PORTRAIT_ADAPTER.adapterId, version: '1' }] : []),
        { adapterId: AI_VIDEO_ADAPTER.adapterId, version: AI_VIDEO_ADAPTER.version },
      ],
      artifacts: manifestArtifactRefs,
      subjectId: job.twin.subjectId,
      grantIds,
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
    await ctx.report({ steps: steps.all(), progress: 1 });

    await emitEvent(ctx.tenantId, 'performance.created', 'performance', performanceRow.id, {
      name,
      origin: 'text',
      durationMs,
      trackCount: tracks.length,
      llmEnhanced,
    });
    if (llmEnhanced) {
      await recordLlmCalls(ctx.tenantId, 1, { jobKind: 'performance.fromText', performanceId: performanceRow.id });
    }
    await recordUsage(ctx.tenantId, 'job.performance.fromText', 1, { performanceId: performanceRow.id });

    return {
      output: {
        performanceId: performanceRow.id,
        durationMs,
        tracks: tracks.length,
        sentences: sentences.length,
        llmEnhanced,
        ...(llmEnhanced ? {} : { llmEnhanceError: llmError }),
      },
      entities: [{ type: 'performance', id: performanceRow.id }],
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

