// ═══════════════════════════════════════════════════════════════════════════
// Render provider switch — the ONE call site that decides where image/video
// rendering runs (Worker C lane, P6.C2; mirrors the P6.C1 recon seam law).
//
//   YOU_RENDER_PROVIDER=station    (default) — in-sandbox z-ai SDK (ai/zai.ts,
//                                     unchanged station behavior). The C1
//                                     seam names "local" and the registry id
//                                     "zai" are accepted aliases (same law as
//                                     YOU_RECON_PROVIDER=local → zai).
//   YOU_RENDER_PROVIDER=dashscope            — hosted rendering via the
//                                     DashScope (Alibaba Bailian) HTTP APIs
//                                     (ai/dashscope.ts, production)
//
// Fail-closed on unknown values (the C1/C5 law): the platform never guesses
// which provider renders. The application layer (render executors + the
// ai-image/ai-video adapters) calls THIS seam only — no provider details
// leak beyond it.
//
// Model resolution (P6.C5 registry): the dashscope branch resolves its model
// ids through ai/registry.ts ('image-gen' / 'video-gen' capabilities), with
// the documented precedence YOU_AI_PROVIDERS pin > the seam-level
// YOU_DASHSCOPE_IMAGE_MODEL / YOU_DASHSCOPE_VIDEO_MODEL knobs > the registry
// healthy default (the pin is passed down explicitly; the other levels apply
// inside ai/dashscope.ts's config, and the defaults are asserted equal by the
// test suite).
//
// The STATION branch is a lazily-imported passthrough: the z-ai SDK module
// (and its dependency) stays OUT of the hosted deployment's module graph
// unless the station path is actually selected — the same availability gap
// C1 closed for reconstruction, closed here for rendering.
//
// IMPORT SHAPE NOTE: static imports below carry explicit `.ts` extensions /
// are type-only (erased) so this module is directly importable by the
// node:test suites under Node's type stripping — the station branch's
// bundler-style extensionless import deliberately does not resolve there
// (the routing tests assert exactly that delegation).
// ═══════════════════════════════════════════════════════════════════════════
import type { ZaiImageSize, ZaiVideoTaskParams, VideoTaskHandle, VideoPollResult } from './zai';
import { resolveModel } from './registry.ts';
import { dashScopeGenerateImage, dashScopeCreateVideoTask, dashScopePollTask, type DashScopeCallOptions } from './dashscope.ts';

export type RenderProvider = 'station' | 'dashscope';

/** Fail-closed provider selection (the C1 YOU_RECON_PROVIDER law, render side).
 * "local" and "zai" are accepted aliases of the station branch (the C1 seam
 * names the same SDK binding "local"; the P6.C5 registry id is "zai"). */
export function renderProvider(): RenderProvider {
  const raw = (process.env.YOU_RENDER_PROVIDER ?? 'station').trim().toLowerCase();
  if (raw === 'station' || raw === 'local' || raw === 'zai' || raw === '') return 'station';
  if (raw === 'dashscope') return 'dashscope';
  throw new Error(
    `YOU_RENDER_PROVIDER must be "station" (aliases "local"/"zai") or "dashscope" (got "${raw}") — refusing to guess which provider renders human-likeness artifacts`,
  );
}

/**
 * Resolve the dashscope model for a render capability through the registry.
 * Fail-closed (throws RegistryResolutionError when DASHSCOPE_API_KEY is
 * missing at resolution time — the C5 requiredEnvKey law). Only an explicit
 * YOU_AI_PROVIDERS pin is passed down verbatim; otherwise the seam-level
 * knobs / registry defaults inside ai/dashscope.ts apply.
 */
function resolveDashScopeModelId(capability: 'image-gen' | 'video-gen'): string | undefined {
  const resolved = resolveModel(capability, { provider: 'dashscope' });
  return resolved.source === 'provider-override' ? resolved.modelId : undefined;
}

// ─── Image generation ────────────────────────────────────────────────────────

export interface RenderedImage {
  base64: string; // image bytes, base64
  latencyMs: number; // REAL provider latency (generation only)
  provider: RenderProvider;
  /** model id actually used, or null when the provider does not report one (station SDK binding). */
  model: string | null;
  /** provider task id when the provider is task-based, else null. */
  taskId: string | null;
}

/** The single image-generation entry point for the render path. */
export async function renderGenerateImage(
  prompt: string,
  size: ZaiImageSize,
  opts: DashScopeCallOptions = {},
): Promise<RenderedImage> {
  if (renderProvider() === 'dashscope') {
    const model = resolveDashScopeModelId('image-gen');
    const img = await dashScopeGenerateImage(prompt, size, { ...opts, ...(model ? { model } : {}) });
    return { base64: img.base64, latencyMs: img.latencyMs, provider: 'dashscope', model: img.model, taskId: img.taskId };
  }
  const zai = await import('./zai'); // lazy: the station SDK stays out of the hosted graph
  const img = await zai.generateImage(prompt, size);
  return { base64: img.base64, latencyMs: img.latencyMs, provider: 'station', model: null, taskId: null };
}

// ─── Video generation (task-based: submit → poll) ───────────────────────────

export interface RenderedVideoTask {
  taskId: string;
  status: string; // provider-reported initial status, verbatim
  provider: RenderProvider;
  model: string | null;
  /** station-only knobs the selected provider could not express (honest record). */
  droppedParams: string[];
}

/**
 * The single video-task submission entry point for the render path. The
 * params follow the station shape (ai/zai.ts ZaiVideoTaskParams); the
 * dashscope branch maps what the DashScope video contract can express and
 * records the dropped station-only knobs in `droppedParams`.
 */
export async function renderCreateVideoTask(
  params: ZaiVideoTaskParams,
  opts: { model?: string } & DashScopeCallOptions = {},
): Promise<RenderedVideoTask> {
  if (renderProvider() === 'dashscope') {
    const model = resolveDashScopeModelId('video-gen');
    const droppedParams = (['quality', 'fps', 'with_audio'] as const).filter((k) => params[k] !== undefined);
    const task = await dashScopeCreateVideoTask(
      {
        ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
        ...(params.image_url !== undefined ? { imageUrl: params.image_url } : {}),
        ...(params.duration !== undefined ? { duration: params.duration } : {}),
      },
      { ...opts, ...(model ? { model } : {}) },
    );
    return { taskId: task.taskId, status: task.status, provider: 'dashscope', model: task.model, droppedParams };
  }
  const zai = await import('./zai'); // lazy: the station SDK stays out of the hosted graph
  const task: VideoTaskHandle = await zai.createVideoTask(params);
  return { taskId: task.taskId, status: task.status, provider: 'station', model: null, droppedParams: [] };
}

/** The single video-task poll entry point for the render path (bounded). */
export async function renderPollVideoTask(
  taskId: string,
  maxMs = 600_000,
  opts: DashScopeCallOptions = {},
): Promise<VideoPollResult & { attempts?: number }> {
  if (renderProvider() === 'dashscope') {
    return dashScopePollTask(taskId, { ...opts, maxWaitMs: maxMs });
  }
  const zai = await import('./zai'); // lazy: the station SDK stays out of the hosted graph
  return zai.pollVideoTask(taskId, maxMs);
}
