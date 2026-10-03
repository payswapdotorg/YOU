// ═══════════════════════════════════════════════════════════════════════════
// ai-image-1 — provider image generation adapter (Worker C lane).
// Wraps the render provider seam (ai/render-provider.ts, P6.C2) behind a
// versioned, honest adapter — the provider (station z-ai SDK or hosted
// DashScope) is selected by YOU_RENDER_PROVIDER at the seam, never here:
// - prompts are derived ONLY from consented HTIR descriptors;
// - prompts always request a STYLIZED AVATAR PORTRAIT and never claim to be a
//   real identity likeness (anti-impersonation policy, docs/SECURITY_PRIVACY.md);
// - real provider latency is measured and returned;
// - provider cost is NOT observable in this sandbox → cost fields are null and
//   any cost number in meta is an explicitly-labeled modeled estimate.
// ═══════════════════════════════════════════════════════════════════════════
import type { HTIR, RenderStyle } from '../contracts';
import { renderGenerateImage, type RenderProvider } from '../ai/render-provider';
import { putObject } from '../core/storage';

export const AI_IMAGE_ADAPTER = {
  adapterId: 'ai-image-1',
  version: '1',
  deterministic: false,
  aiInvolved: true,
  promptPolicy:
    'prompts request a stylized avatar portrait derived from consented HTIR descriptors; never a real-identity likeness claim',
  costNote: 'provider pricing not exposed to this sandbox — costUsd stays null; estimates in meta are modeled (costUsdModeled: true)',
} as const;

const PORTRAIT_SIZE = '768x1344' as const;

const STYLE_PHRASING: Record<RenderStyle, string> = {
  photorealistic: 'photorealistic digital painting style, soft studio lighting',
  anime: 'anime illustration style, clean line art, cel shading',
  cartoon: 'bold cartoon style, thick outlines, vibrant flat colors',
  'low-poly': 'low-poly geometric style, faceted shading',
  game: 'stylized video-game character portrait, crisp rendering',
  illustration: 'hand-drawn illustration style, sketchy textured strokes',
  'stylized-portrait': 'tasteful stylized portrait illustration',
};

/** Build the provider prompt from the HTIR. Exported for audit/inspection. */
export function buildImagePrompt(htir: HTIR, style: RenderStyle): string {
  const a: NonNullable<HTIR['appearance']> = htir.appearance ?? {
    palette: {},
    hair: { coverage: 'medium' },
    clothing: { items: [] },
    distinguishing: [],
  };
  const m = htir.morphology;
  const parts: string[] = [];

  parts.push('Stylized avatar portrait of a person');
  if (m?.build && m.build !== 'not observed') parts.push(`with a ${m.build} build`);
  if (m?.ageEstimate && m.ageEstimate !== 'not observed') parts.push(`apparent age ${m.ageEstimate}`);
  if (a.hair?.style && a.hair.style !== 'not observed') {
    parts.push(`${a.hair.style} hair${a.hair.length ? ` (${a.hair.length} length)` : ''}`);
  }
  if (a.hair?.style && a.palette?.hair) parts.push(`hair tone ${a.palette.hair}`);
  if (a.palette?.skin) parts.push(`skin tone ${a.palette.skin}`);
  if (a.palette?.eyes) parts.push(`eyes ${a.palette.eyes}`);
  if (a.clothing?.style && a.clothing.style !== 'not observed') parts.push(`wearing ${a.clothing.style} clothing`);
  if (a.clothing?.items?.length) parts.push(`clothing items: ${a.clothing.items.slice(0, 4).join(', ')}`);
  if (a.distinguishing?.length) parts.push(`features: ${a.distinguishing.slice(0, 4).join(', ')}`);

  parts.push(STYLE_PHRASING[style] ?? STYLE_PHRASING['stylized-portrait']);
  parts.push('shoulders-up composition, neutral background, respectful and tasteful');
  parts.push(
    'IMPORTANT: this is a stylized avatar interpretation for an authorized digital-twin workflow — NOT a claim of any real person’s likeness or identity'
  );

  return parts.join(', ');
}

export interface AiImageResult {
  storageKey: string;
  contentHash: string;
  bytes: number;
  mime: string;
  latencyMs: number; // REAL provider latency (image generation call only)
  prompt: string;
  meta: Record<string, unknown>;
}

export interface AiImageOptions {
  /**
   * Per-job render provider override (P6.C3 broker routing): 'dashscope' when
   * the compute broker routed this job to the hosted provider; undefined = the
   * YOU_RENDER_PROVIDER env seam decides (C2 law, unchanged).
   */
  provider?: RenderProvider;
}

export async function renderPortraitImage(htir: HTIR, style: RenderStyle, opts: AiImageOptions = {}): Promise<AiImageResult> {
  const prompt = buildImagePrompt(htir, style);
  // P6.C2: the ONE image-generation call site — the render provider seam
  // resolves YOU_RENDER_PROVIDER (station | dashscope), or the per-job broker
  // routing override (P6.C3), and returns the provider-audited result
  // (provider/model/taskId recorded in meta below).
  const { base64, latencyMs, provider, model, taskId } = await renderGenerateImage(
    prompt,
    PORTRAIT_SIZE,
    opts.provider !== undefined ? { provider: opts.provider } : {},
  );
  const buf = Buffer.from(base64, 'base64');
  const stored = await putObject(buf, { kind: 'render', mime: 'image/png' });
  return {
    storageKey: stored.storageKey,
    contentHash: stored.contentHash,
    bytes: stored.bytes,
    mime: 'image/png',
    latencyMs,
    prompt,
    meta: {
      adapterId: AI_IMAGE_ADAPTER.adapterId,
      adapterVersion: AI_IMAGE_ADAPTER.version,
      style,
      size: PORTRAIT_SIZE,
      provider,
      providerModel: model,
      providerTaskId: taskId,
      providerLatencyMs: latencyMs,
      realLatency: true,
      costUsd: null,
      costUsdModeled: true,
      costUsdEstimate: 0.04,
      costUsdBasis:
        'placeholder modeled estimate — provider pricing not exposed to this sandbox; MUST be replaced with measured cost before any promotion gate',
      promptAudit: prompt,
    },
  };
}
