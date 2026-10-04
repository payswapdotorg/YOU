// GET /api/v1/agent/providers — the Soul provider wiring surface (P6.B7).
//
// Resolves, PER PROVIDER in the C5 AI model registry, the honest status for
// configuring a Soul: env-credential health (fail-closed — the registry
// refuses to guess credentials), wave-1 chat-adapter executability, the
// registry's model rows for reference, and the chat seam's circuit-breaker
// health for executable providers.
//
// Laws:
// - CREDENTIALS NEVER LEAVE THE SERVER: the response carries env KEY NAMES
//   (registry-declared, e.g. requiredEnvKey) and boolean/derived state only —
//   never env values, never provider SDK configuration.
// - PROVIDER-NEUTRAL: every provider/model name comes from the C5 registry
//   table; the chat-adapter allow-list is SOUL_PROVIDER_IDS (runtime-core).
// - Read-only: the breaker snapshot never mutates the breaker box.
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute } from '@/lib/you/core/errors';
import { breakerSnapshot } from '@/lib/you/core/circuit-breaker';
import { MODEL_REGISTRY, PROVIDER_METADATA } from '@/lib/you/ai/registry';
import { SOUL_PROVIDER_IDS } from '@/lib/you/agent/runtime-core';
import {
  registryToSourceRows,
  resolveSoulProviderStatuses,
  type ChatSeamHealthInput,
} from '@/lib/you/agent/soul-providers';

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    await requireApiAuth(request);
    // chat-seam health, honestly projected: the breaker snapshot carries ONLY
    // providers with a live box in this process — an executable provider with
    // no box has never been called, so admission is closed (the same truth
    // assertProviderAvailable enforces: no box, no refusal). Snapshot entries
    // always win; defaults are NEVER fabricated over recorded state.
    const snapshot = breakerSnapshot();
    const chatSeam: Record<string, ChatSeamHealthInput> = { ...snapshot };
    for (const id of SOUL_PROVIDER_IDS) {
      if (!chatSeam[id]) chatSeam[id] = { state: 'closed', retryAfterMs: 0, openedReason: null };
    }
    const statuses = resolveSoulProviderStatuses(
      registryToSourceRows(PROVIDER_METADATA, MODEL_REGISTRY),
      process.env as Record<string, string | undefined>,
      SOUL_PROVIDER_IDS,
      chatSeam,
    );
    return Response.json(statuses);
  });
}
