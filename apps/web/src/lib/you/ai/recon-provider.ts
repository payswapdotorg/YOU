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
//
// P6.A6 full (Worker A wiring, TL-sanctioned): every recon vision call now
// routes through the platform resilience seam — the per-provider circuit
// breaker (fail fast when the provider is down, typed ProviderUnavailableError
// instead of a hang) wrapping bounded retries with Retry-After respect
// (core/resilience.ts). The breaker key is the CONCRETE provider (zai /
// openrouter), so its state is shared by every caller of this seam.
// ═══════════════════════════════════════════════════════════════════════════
import { visionAnalyze } from './zai';
import { openRouterVisionAnalyze } from './openrouter';
import { withProviderResilience } from '../core/resilience';
import type { ProviderName } from '../core/breaker';

export type ReconProvider = 'local' | 'openrouter';

export function reconProvider(): ReconProvider {
  const raw = (process.env.YOU_RECON_PROVIDER ?? 'local').trim().toLowerCase();
  if (raw === 'local' || raw === '') return 'local';
  if (raw === 'openrouter') return 'openrouter';
  throw new Error(
    `YOU_RECON_PROVIDER must be "local" or "openrouter" (got "${raw}") — refusing to guess which provider sees biometric evidence`,
  );
}

/** The concrete provider name behind the recon seam (breaker key). */
export function reconProviderName(): ProviderName {
  return reconProvider() === 'openrouter' ? 'openrouter' : 'zai';
}

/** The single vision-analysis entry point for the recon path. */
export async function reconVisionAnalyze(
  imageBase64DataUrl: string,
  prompt: string,
  opts: { thinking?: boolean } = {},
) {
  const provider = reconProviderName();
  const call =
    provider === 'openrouter'
      ? () => openRouterVisionAnalyze(imageBase64DataUrl, prompt, opts)
      : () => visionAnalyze(imageBase64DataUrl, prompt, opts);
  return withProviderResilience(provider, call, { label: 'recon-vision' });
}
