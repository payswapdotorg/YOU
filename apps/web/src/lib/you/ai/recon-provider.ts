// ═══════════════════════════════════════════════════════════════════════════
// Recon provider switch — the ONE call site that decides where reconstruction
// vision inference runs (Worker C lane, P6.C1; registry-backed since P6.C5).
//
//   YOU_RECON_PROVIDER=local       (default) — in-sandbox z-ai SDK (vlm-recon-1)
//   YOU_RECON_PROVIDER=openrouter            — hosted vision via OpenRouter
//                                              (vlm-recon-or-1, production)
//
// Fail-closed on unknown values (same law as the storage seam): the platform
// never guesses which provider sees biometric evidence.
//
// P6.C5: the MODEL for the selected provider now resolves through the AI
// registry (ai/registry.ts) — one resolution point, precedence
// YOU_AI_PROVIDERS > YOU_AI_VISION_MODEL > YOU_RECON_MODEL (legacy) >
// registry healthy default, with the same fail-closed laws. The provider
// wrappers receive the resolved model id explicitly; no other call site in
// the repo selects a recon model.
// ═══════════════════════════════════════════════════════════════════════════
import { visionAnalyze, visionCompare } from './zai';
import { openRouterVisionAnalyze } from './openrouter';
import { resolveModel, type ResolutionSource } from './registry';

export type ReconProvider = 'local' | 'openrouter';

/** What the recon seam will route to: provider + registry-resolved model. */
export interface ReconResolution {
  readonly provider: ReconProvider;
  readonly modelId: string;
  readonly source: ResolutionSource;
}

export function reconProvider(): ReconProvider {
  const raw = (process.env.YOU_RECON_PROVIDER ?? 'local').trim().toLowerCase();
  if (raw === 'local' || raw === '') return 'local';
  if (raw === 'openrouter') return 'openrouter';
  throw new Error(
    `YOU_RECON_PROVIDER must be "local" or "openrouter" (got "${raw}") — refusing to guess which provider sees biometric evidence`,
  );
}

/**
 * The single resolution snapshot for the recon vision concern — the exact
 * provider + model reconVisionAnalyze would use on its next call (same code
 * path: reconProvider() → resolveModel('vision')). P6.C4's f1.reconstruct
 * pipeline records this as TwinVersion provenance (which provider + model
 * actually saw the evidence); calling it separately changes nothing about
 * routing — reconVisionAnalyze still resolves per call through this same
 * function.
 */
export function reconResolution(): ReconResolution {
  const provider = reconProvider();
  // P6.C5: the ONE model-resolution point for the recon vision concern.
  // Also fail-closes on a missing OPENROUTER_API_KEY at resolution time.
  const resolved = resolveModel('vision', { provider });
  return { provider, modelId: resolved.modelId, source: resolved.source };
}

/** The single vision-analysis entry point for the recon path. */
export async function reconVisionAnalyze(
  imageBase64DataUrl: string,
  prompt: string,
  opts: { thinking?: boolean } = {},
) {
  const { provider, modelId } = reconResolution();
  if (provider === 'openrouter') {
    return openRouterVisionAnalyze(imageBase64DataUrl, prompt, { ...opts, model: modelId });
  }
  return visionAnalyze(imageBase64DataUrl, prompt, { ...opts, model: modelId });
}

/**
 * P6.C8 — two-image vision COMPARISON through the same resolution law (the
 * recon seam's provider routing, unchanged). Used by the try-on identity
 * checks (garment identity / twin identity preservation): both images are
 * passed as vision content in ONE call so the model can actually compare.
 *
 * Honest capability disclosure: the openrouter branch does not implement a
 * two-image call in v1 — it throws instead of degrading to two independent
 * single-image analyses (which cannot compare). Callers surface the refusal
 * as an honest "identity check unverified" with this verbatim reason.
 */
export async function reconVisionCompare(
  aDataUrl: string,
  bDataUrl: string,
  prompt: string,
  opts: { thinking?: boolean } = {},
) {
  const { provider, modelId } = reconResolution();
  if (provider === 'openrouter') {
    throw new Error(
      'two-image vision comparison is not implemented on the openrouter recon path (P6.C8 v1) — try-on identity checks stay unverified there',
    );
  }
  return visionCompare(aDataUrl, bDataUrl, prompt, { ...opts, model: modelId });
}
