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
import { visionAnalyze } from './zai';
import { openRouterVisionAnalyze } from './openrouter';
import { resolveModel } from './registry';

export type ReconProvider = 'local' | 'openrouter';

export function reconProvider(): ReconProvider {
  const raw = (process.env.YOU_RECON_PROVIDER ?? 'local').trim().toLowerCase();
  if (raw === 'local' || raw === '') return 'local';
  if (raw === 'openrouter') return 'openrouter';
  throw new Error(
    `YOU_RECON_PROVIDER must be "local" or "openrouter" (got "${raw}") — refusing to guess which provider sees biometric evidence`,
  );
}

/** The single vision-analysis entry point for the recon path. */
export async function reconVisionAnalyze(
  imageBase64DataUrl: string,
  prompt: string,
  opts: { thinking?: boolean } = {},
) {
  const provider = reconProvider();
  // P6.C5: the ONE model-resolution point for the recon vision concern.
  // Also fail-closes on a missing OPENROUTER_API_KEY at resolution time.
  const resolved = resolveModel('vision', { provider });
  if (provider === 'openrouter') {
    return openRouterVisionAnalyze(imageBase64DataUrl, prompt, { ...opts, model: resolved.modelId });
  }
  return visionAnalyze(imageBase64DataUrl, prompt, { ...opts, model: resolved.modelId });
}
