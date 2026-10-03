// ═══════════════════════════════════════════════════════════════════════════
// ai-video-1 — provider video generation adapter (Worker C lane).
// Wraps the render provider seam (ai/render-provider.ts, P6.C2 — station
// z-ai SDK or hosted DashScope, selected by YOU_RENDER_PROVIDER at the seam)
// around an async video task + bounded polling:
// - accepts a rendered raster image artifact as the visual base when one
//   exists (base64 data URL); otherwise generates from the text prompt only;
// - polls on a bounded cadence with a hard 10-minute bound — timeout is an
//   honest error;
// - downloads and re-hosts the result into YOU object storage when possible;
//   if the download fails, the provider remote URL is recorded as the artifact
//   reference with an explicit honest note (bytes not re-hosted);
// - REAL total latency is measured; provider cost is a modeled estimate.
// ═══════════════════════════════════════════════════════════════════════════
import type { HTIR, RenderStyle } from '../contracts';
import { renderCreateVideoTask, renderPollVideoTask, type RenderProvider } from '../ai/render-provider';
import { getObject, putObject } from '../core/storage';

export const AI_VIDEO_ADAPTER = {
  adapterId: 'ai-video-1',
  version: '1',
  deterministic: false,
  aiInvolved: true,
  timeoutPolicy: 'poll every 5s, hard bound 10 minutes; timeout = honest job failure',
  costNote: 'provider pricing not exposed to this sandbox — costUsd stays null; estimates in meta are modeled (costUsdModeled: true)',
} as const;

const RASTER_MIMES = ['image/png', 'image/jpeg', 'image/webp'];

export interface AiVideoOptions {
  htir: HTIR;
  style: RenderStyle;
  /** raster image artifact to animate, when available */
  baseImage?: { storageKey: string; mime: string } | null;
  maxWaitMs?: number;
  /**
   * Per-job render provider override (P6.C3 broker routing): 'dashscope' when
   * the compute broker routed this job to the hosted provider; undefined = the
   * YOU_RENDER_PROVIDER env seam decides (C2 law, unchanged). Applies to BOTH
   * the task creation and its polls (the poll must hit the provider that
   * created the task).
   */
  provider?: RenderProvider;
}

export interface AiVideoResult {
  taskId: string;
  mime: string;
  storageKey: string | null; // set when bytes were re-hosted
  contentHash: string | null;
  bytes: number | null;
  remoteUrl: string | null; // provider-hosted reference
  latencyMs: number; // REAL total (create + poll + download)
  waitedMs: number; // REAL poll wait
  usedImageBase: boolean;
  meta: Record<string, unknown>;
}

export function buildVideoPrompt(htir: HTIR, style: RenderStyle): string {
  const a = htir.appearance;
  const bits = [
    'Gentle idle-motion avatar video',
    a?.hair?.style && a.hair.style !== 'not observed' ? `of a person with ${a.hair.style} hair` : 'of a person',
    'subtle head sway, natural blinking, soft pleasant expression, slight breathing motion',
    style === 'anime'
      ? 'anime style, cel shaded'
      : style === 'cartoon'
        ? 'cartoon style'
        : style === 'low-poly'
          ? 'low-poly geometric style'
          : 'tasteful stylized render',
    'respectful and tasteful; stylized avatar interpretation, not a real-identity likeness claim',
  ];
  return bits.join(', ');
}

export async function renderPortraitVideo(opts: AiVideoOptions): Promise<AiVideoResult> {
  const t0 = Date.now();
  const { htir, style } = opts;
  const prompt = buildVideoPrompt(htir, style);

  // visual base: only raster images can seed the video task
  let imageDataUrl: string | undefined;
  let usedImageBase = false;
  if (opts.baseImage && RASTER_MIMES.includes(opts.baseImage.mime)) {
    const buf = await getObject(opts.baseImage.storageKey);
    if (!buf) {
      throw new Error(
        `ai-video-1: base image object missing from storage (key ${opts.baseImage.storageKey}) — refusing to continue`
      );
    }
    imageDataUrl = `data:${opts.baseImage.mime};base64,${buf.toString('base64')}`;
    usedImageBase = true;
  }

  const providerOpts = opts.provider !== undefined ? { provider: opts.provider } : {};
  const task = await renderCreateVideoTask(
    {
      prompt,
      ...(imageDataUrl ? { image_url: imageDataUrl } : {}),
      quality: 'speed',
      duration: 5,
      fps: 30,
      with_audio: false,
    },
    providerOpts,
  );

  const maxWait = opts.maxWaitMs ?? 600_000;
  const polled = await renderPollVideoTask(task.taskId, maxWait, providerOpts);
  const waitedMs = polled.waitedMs;

  if (polled.status === 'timeout') {
    throw new Error(
      `ai-video-1: provider video task ${task.taskId} did not finish within ${maxWait}ms (last status: ${polled.lastProviderStatus}) — honest failure, no artifact fabricated`
    );
  }
  if (polled.status === 'failed') {
    throw new Error(
      `ai-video-1: provider video task ${task.taskId} FAILED (last status: ${polled.lastProviderStatus}) — honest failure, no artifact fabricated`
    );
  }
  if (!polled.url) {
    throw new Error(
      `ai-video-1: provider video task ${task.taskId} succeeded but returned no result URL — honest failure, no artifact fabricated`
    );
  }

  // download & re-host when possible
  let storageKey: string | null = null;
  let contentHash: string | null = null;
  let bytes: number | null = null;
  let downloadNote = 'result downloaded and re-hosted in YOU object storage';
  try {
    const res = await fetch(polled.url);
    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    if (buf.length === 0) throw new Error('downloaded 0 bytes');
    const stored = await putObject(buf, { kind: 'render', mime: 'video/mp4' });
    storageKey = stored.storageKey;
    contentHash = stored.contentHash;
    bytes = stored.bytes;
  } catch (e) {
    downloadNote = `result download/re-host FAILED (${e instanceof Error ? e.message : String(e)}) — the provider remote URL is recorded as the artifact reference; bytes were NOT re-hosted`;
  }

  return {
    taskId: task.taskId,
    mime: 'video/mp4',
    storageKey,
    contentHash,
    bytes,
    remoteUrl: storageKey ? null : polled.url,
    latencyMs: Date.now() - t0,
    waitedMs,
    usedImageBase,
    meta: {
      adapterId: AI_VIDEO_ADAPTER.adapterId,
      adapterVersion: AI_VIDEO_ADAPTER.version,
      style,
      provider: task.provider,
      providerModel: task.model,
      providerTaskId: task.taskId,
      providerInitialStatus: task.status,
      ...(task.droppedParams.length
        ? { droppedProviderParams: task.droppedParams, droppedParamsNote: 'station-only knobs the selected provider contract cannot express (recorded honestly, not silently dropped)' }
        : {}),
      pollWaitedMs: waitedMs,
      totalLatencyMs: Date.now() - t0,
      realLatency: true,
      usedImageBase,
      downloadNote,
      costUsd: null,
      costUsdModeled: true,
      costUsdEstimate: 0.1,
      costUsdBasis:
        'placeholder modeled estimate for a 5s/30fps speed-quality clip — provider pricing not exposed to this sandbox; MUST be replaced with measured cost before any promotion gate',
      promptAudit: prompt,
    },
  };
}
