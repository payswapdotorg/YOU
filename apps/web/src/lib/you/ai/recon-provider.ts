// ═══════════════════════════════════════════════════════════════════════════
// Recon provider switch — the ONE call site that decides where reconstruction
// vision inference runs (Worker C lane, P6.C1).
//
//   YOU_RECON_PROVIDER=local       (default) — in-sandbox z-ai SDK (vlm-recon-1)
//   YOU_RECON_PROVIDER=openrouter            — hosted vision via OpenRouter
//                                              (vlm-recon-or-1, production)
//
// Fail-closed on unknown values (same law as the storage seam): the platform
// never guesses which provider sees biometric evidence.
// ═══════════════════════════════════════════════════════════════════════════
import { visionAnalyze } from './zai';
import { openRouterVisionAnalyze } from './openrouter';

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
  if (reconProvider() === 'openrouter') {
    return openRouterVisionAnalyze(imageBase64DataUrl, prompt, opts);
  }
  return visionAnalyze(imageBase64DataUrl, prompt, opts);
}
