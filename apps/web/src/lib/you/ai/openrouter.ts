// ═══════════════════════════════════════════════════════════════════════════
// OpenRouter provider wrapper — hosted vision for the production recon path
// (Worker C lane, P6.C1: adapter vlm-recon-or-1).
//
// Honesty contract (mirrors ai/zai.ts):
// - every wrapper measures REAL wall-clock latency around the provider call;
// - provider errors surface verbatim inside OpenRouterProviderError (message
//   is never rewritten to look like success);
// - no wrapper fabricates content, progress or costs.
//
// Env (validated only when the openrouter provider is SELECTED — the module
// itself stays import-safe with no env present):
//   OPENROUTER_API_KEY     — required (fail closed, never guessed)
//   YOU_RECON_MODEL        — vision model id (default google/gemini-2.5-flash)
//   YOU_RECON_TIMEOUT_MS   — per-call timeout (default 30000)
//   YOU_RECON_BASE_URL     — API base (default https://openrouter.ai/api/v1;
//                            tests point this at a local mock)
// ═══════════════════════════════════════════════════════════════════════════

export const OPENROUTER_ADAPTER = {
  adapterId: 'vlm-recon-or-1',
  version: '1',
  inferenceOnly: true,
  trainingOnBiometrics: false,
  privacyNote:
    'inference-only analysis via OpenRouter-hosted vision models; raw evidence stays in object storage and is passed to the provider solely as transient analysis input; no training is performed on user biometric data',
} as const;

export const DEFAULT_RECON_MODEL = 'google/gemini-2.5-flash';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/** Normalized provider error: verbatim cause message, tagged with the operation. */
export class OpenRouterProviderError extends Error {
  readonly operation: string;
  readonly causeMessage: string;
  readonly status?: number;
  constructor(operation: string, cause: unknown, status?: number) {
    const causeMessage =
      cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : JSON.stringify(cause);
    super(`openrouter provider error during ${operation}: ${causeMessage}`);
    this.name = 'OpenRouterProviderError';
    this.operation = operation;
    this.causeMessage = causeMessage;
    this.status = status;
  }
}

export interface VisionResult {
  content: string;
  latencyMs: number; // real, measured around the provider call
  model: string; // as reported by the provider response
}

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
  baseUrl: string;
}

/** Read + validate the OpenRouter env contract. Throws with what is missing. */
export function openRouterConfig(): OpenRouterConfig {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new OpenRouterProviderError(
      'config',
      'OPENROUTER_API_KEY is not configured (YOU_RECON_PROVIDER=openrouter requires it) — refusing to guess credentials',
    );
  }
  return {
    apiKey,
    model: process.env.YOU_RECON_MODEL?.trim() || DEFAULT_RECON_MODEL,
    timeoutMs: Number(process.env.YOU_RECON_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    baseUrl: (process.env.YOU_RECON_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
  };
}

/**
 * Hosted vision analysis through OpenRouter's chat-completions API with
 * image input as a data-URL content part (the standard OpenAI-compatible
 * vision shape OpenRouter proxies).
 */
export async function openRouterVisionAnalyze(
  imageBase64DataUrl: string,
  prompt: string,
  _opts: { thinking?: boolean } = {},
): Promise<VisionResult> {
  const cfg = openRouterConfig();
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: imageBase64DataUrl } },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new OpenRouterProviderError('vision.http', `HTTP ${res.status} ${body.slice(0, 300)}`, res.status);
    }
    const data = (await res.json()) as {
      model?: string;
      choices?: { message?: { content?: unknown } }[];
    };
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new OpenRouterProviderError('vision.content', `empty or non-string content: ${JSON.stringify(data)?.slice(0, 300)}`);
    }
    return { content, latencyMs: Date.now() - t0, model: data?.model ?? 'unknown' };
  } catch (e) {
    if (e instanceof OpenRouterProviderError) throw e;
    if (e instanceof Error && e.name === 'AbortError') {
      throw new OpenRouterProviderError('vision.timeout', `no response within ${cfg.timeoutMs}ms`);
    }
    throw new OpenRouterProviderError('vision', e);
  } finally {
    clearTimeout(timer);
  }
}
