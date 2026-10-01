// ═══════════════════════════════════════════════════════════════════════════
// ZAI provider wrapper — the single server-side entry point for every model
// call in the YOU stack (Worker C lane, task 2-c).
//
// Honesty contract (AGENTS.md):
// - every wrapper measures REAL wall-clock latency around the provider call;
// - provider errors are surfaced verbatim inside ZaiProviderError (message is
//   never rewritten to look like success);
// - no wrapper fabricates content, progress or costs.
//
// The SDK (z-ai-web-dev-sdk) is BACKEND-ONLY. This module must never be
// imported from client components — it lives under src/lib/you/ai and is
// imported exclusively by job executors and server routes.
// ═══════════════════════════════════════════════════════════════════════════
import ZAI, { type CreateChatCompletionBody } from 'z-ai-web-dev-sdk';

type ZaiClient = Awaited<ReturnType<typeof ZAI.create>>;

let cachedClient: ZaiClient | null = null;

/** Singleton ZAI client (ZAI.create is cached; one provider binding per process). */
export async function getZAI(): Promise<ZaiClient> {
  if (!cachedClient) {
    cachedClient = await ZAI.create();
  }
  return cachedClient;
}

/** Normalized provider error: verbatim cause message, tagged with the operation. */
export class ZaiProviderError extends Error {
  readonly operation: string;
  readonly causeMessage: string;
  constructor(operation: string, cause: unknown) {
    const causeMessage =
      cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : JSON.stringify(cause);
    super(`zai provider error during ${operation}: ${causeMessage}`);
    this.name = 'ZaiProviderError';
    this.operation = operation;
    this.causeMessage = causeMessage;
  }
}

// ─── Chat (LLM) ─────────────────────────────────────────────────────────────

export interface ZaiChatMessage {
  /** per skill docs the system prompt is delivered as a leading 'assistant' message */
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  thinking?: boolean;
  temperature?: number;
}

export interface ChatResult {
  content: string;
  latencyMs: number; // real, measured around the provider call
  model: string; // as reported by the provider response
}

export async function chatComplete(messages: ZaiChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
  const t0 = Date.now();
  try {
    const zai = await getZAI();
    const body: CreateChatCompletionBody = {
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      thinking: { type: opts.thinking ? 'enabled' : 'disabled' },
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature; // index-signature extension
    const completion = await zai.chat.completions.create(body);
    const content = completion?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error(`empty or non-string completion content: ${JSON.stringify(completion)?.slice(0, 300)}`);
    }
    return { content, latencyMs: Date.now() - t0, model: completion?.model ?? 'unknown' };
  } catch (e) {
    throw new ZaiProviderError('chat', e);
  }
}

// ─── Vision (VLM) — inference only, never training ──────────────────────────

export interface VisionResult {
  content: string;
  latencyMs: number; // real, measured around the provider call
  model: string;
}

/**
 * Analyze one image with the vision model. `imageBase64DataUrl` must be a
 * full data URL (`data:image/png;base64,…`). Inference-only: no biometric
 * data is ever used for training by YOU (see adapters/vlm-recon.ts metadata).
 */
export async function visionAnalyze(
  imageBase64DataUrl: string,
  prompt: string,
  opts: { thinking?: boolean } = {}
): Promise<VisionResult> {
  const t0 = Date.now();
  try {
    const zai = await getZAI();
    const res = await zai.chat.completions.createVision({
      model: 'glm-5v-turbo', // observed server-side binding for this sandbox's vision endpoint
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: imageBase64DataUrl } },
          ],
        },
      ],
      thinking: { type: opts.thinking ? 'enabled' : 'disabled' },
    });
    const content = res?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error(`empty or non-string vision content: ${JSON.stringify(res)?.slice(0, 300)}`);
    }
    return { content, latencyMs: Date.now() - t0, model: res?.model ?? 'unknown' };
  } catch (e) {
    throw new ZaiProviderError('vision', e);
  }
}

// ─── Image generation ────────────────────────────────────────────────────────

export type ZaiImageSize =
  | '1024x1024' | '768x1344' | '864x1152' | '1344x768' | '1152x864' | '1440x720' | '720x1440';

export interface GeneratedImage {
  base64: string; // PNG bytes, base64
  latencyMs: number; // real
}

export async function generateImage(prompt: string, size: ZaiImageSize = '1024x1024'): Promise<GeneratedImage> {
  const t0 = Date.now();
  try {
    const zai = await getZAI();
    const res = await zai.images.generations.create({ prompt, size });
    const base64 = res?.data?.[0]?.base64;
    if (typeof base64 !== 'string' || base64.length === 0) {
      throw new Error(`no image data returned: ${JSON.stringify(res)?.slice(0, 300)}`);
    }
    return { base64, latencyMs: Date.now() - t0 };
  } catch (e) {
    throw new ZaiProviderError('image-generation', e);
  }
}

// ─── Video generation (async task + bounded polling) ─────────────────────────

export interface ZaiVideoTaskParams {
  prompt?: string;
  /** base64 data URL (recommended) or a public URL */
  image_url?: string;
  quality?: 'speed' | 'quality';
  duration?: number; // seconds
  fps?: number;
  with_audio?: boolean;
}

export interface VideoTaskHandle {
  taskId: string;
  status: string; // provider-reported initial status, verbatim
}

export async function createVideoTask(params: ZaiVideoTaskParams): Promise<VideoTaskHandle> {
  // provider rate limits (429) are retried with backoff — video creation is a
  // scarce, slow resource under concurrent jobs; other errors fail fast
  const delays = [0, 8_000, 20_000, 45_000];
  let lastErr: unknown = null;
  for (const delay of delays) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      const zai = await getZAI();
      const task = await zai.video.generations.create({ ...params });
      if (!task?.id) {
        throw new Error(`video task creation returned no id: ${JSON.stringify(task)?.slice(0, 300)}`);
      }
      return { taskId: task.id, status: task.task_status };
    } catch (e) {
      lastErr = e;
      const msg = String((e as Error)?.message ?? e);
      if (!/429|too many requests/i.test(msg)) throw new ZaiProviderError('video-create', e);
    }
  }
  throw new ZaiProviderError('video-create', lastErr);
}

export type VideoPollStatus = 'succeeded' | 'failed' | 'timeout';

export interface VideoPollResult {
  url: string | null; // provider-hosted result URL when succeeded
  status: VideoPollStatus;
  waitedMs: number; // real total wait
  lastProviderStatus: string; // verbatim last task_status observed
}

/**
 * Poll an async video task every 5s, bounded to `maxMs` (default 10 min).
 * Timeout is an honest error surface — callers must treat it as failure.
 */
export async function pollVideoTask(taskId: string, maxMs = 600_000): Promise<VideoPollResult> {
  const started = Date.now();
  const deadline = started + maxMs;
  let lastStatus = 'unknown';
  let consecutiveErrors = 0;
  try {
    const zai = await getZAI();
    while (Date.now() < deadline) {
      try {
        const result = await zai.async.result.query(taskId);
        consecutiveErrors = 0;
        lastStatus = result?.task_status ?? 'unknown';
        if (lastStatus === 'SUCCESS') {
          const url =
            result?.video_result?.[0]?.url ?? result?.video_url ?? result?.url ?? result?.video ?? null;
          return {
            url: typeof url === 'string' && url.length > 0 ? url : null,
            status: 'succeeded',
            waitedMs: Date.now() - started,
            lastProviderStatus: lastStatus,
          };
        }
        if (lastStatus === 'FAIL') {
          return { url: null, status: 'failed', waitedMs: Date.now() - started, lastProviderStatus: lastStatus };
        }
        await new Promise((r) => setTimeout(r, 5_000));
      } catch (pollErr) {
        // provider hiccups (esp. 429 rate limits under concurrent jobs) are
        // retried with backoff until the deadline; other errors get 3 strikes
        consecutiveErrors += 1;
        const msg = String((pollErr as Error)?.message ?? pollErr);
        const isRateLimit = /429|too many requests/i.test(msg);
        if (!isRateLimit && consecutiveErrors >= 3) {
          throw new ZaiProviderError('video-poll', pollErr);
        }
        await new Promise((r) => setTimeout(r, isRateLimit ? 15_000 : 7_000));
      }
    }
    return { url: null, status: 'timeout', waitedMs: Date.now() - started, lastProviderStatus: lastStatus };
  } catch (e) {
    throw new ZaiProviderError('video-poll', e);
  }
}
