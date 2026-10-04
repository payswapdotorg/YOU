// ═══════════════════════════════════════════════════════════════════════════
// Soul provider status resolution (Worker B lane, P6.B7) — the provider-
// wiring pure half.
//
// Resolves, PER PROVIDER in the C5 AI model registry (lib/you/ai/registry.ts),
// the honest status for configuring a Soul:
//   - envConfigured: the provider's required credential key is present at
//     resolution time (fail-closed semantics — the registry law);
//   - chatExecutable: the provider has a wave-1 chat adapter (the Soul
//     provider allow-list passed in by the caller — SOUL_PROVIDER_IDS in
//     runtime-core; provider-neutral: this module hardcodes NO provider
//     names);
//   - available: both — what the soul-create flow can select today;
//   - reason: the honest human-readable why (surfaced per-soul and in the
//     create dialog);
//   - chatSeam: the circuit-breaker health of the chat seam for executable
//     providers (read from the snapshot the caller injects — read-only).
//
// Laws:
// - NO CREDENTIALS IN CODE: this module only ever reads env KEYS by name
//   (from the registry rows the caller supplies) against the injected
//   env-like map; values are NEVER captured, logged or returned.
// - PROVIDER-NEUTRAL: every provider/model fact comes from the injected
//   registry projection; nothing is hardcoded here.
// - NO FABRICATED HEALTH: providers the registry does not know are reported
//   as unknown/unavailable with that exact reason — never guessed.
//
// Zero-import module (erasable TS only — every import is `import type`, the
// runtime-core precedent): importable from node:test contract suites
// directly AND from the client bundle. The server route injects the C5
// registry's own rows (PROVIDER_METADATA + MODEL_REGISTRY) via
// registryToSourceRows().
// ═══════════════════════════════════════════════════════════════════════════
import type { ModelRegistryEntry, ProviderMetadata, ProviderId } from '../ai/registry';

/** Minimal breaker-health projection (from core/circuit-breaker breakerSnapshot()). */
export interface ChatSeamHealth {
  state: 'closed' | 'open' | 'half-open';
  retryAfterMs: number;
  openedReason: string | null;
}

/** The structural input the resolver accepts (full BreakerStatus satisfies it). */
export interface ChatSeamHealthInput {
  state: 'closed' | 'open' | 'half-open';
  retryAfterMs?: number;
  openedReason?: string | null;
}

/** The registry projection the resolver consumes (server route supplies it). */
export interface SoulProviderSourceRow {
  id: string;
  label: string;
  aliases: readonly string[];
  /** env var that must be present at resolution time (registry-declared). */
  requiredEnvKey: string | null;
  models: readonly {
    modelId: string;
    label: string;
    enabled: boolean;
    vision: boolean;
    imageGen: boolean;
    videoGen: boolean;
    notes: string;
  }[];
}

export interface SoulProviderModelRow {
  modelId: string;
  label: string;
  enabled: boolean;
  capabilities: { vision: boolean; imageGen: boolean; videoGen: boolean };
  /** honest provenance note from the registry entry (surfaced as a hint). */
  notes: string;
}

export interface SoulProviderStatusRow {
  id: string;
  label: string;
  aliases: readonly string[];
  /** env var that must be present at resolution time (registry-declared). */
  requiredEnvKey: string | null;
  /** the key is set (or none is required) — fail-closed semantics. */
  envConfigured: boolean;
  /** the provider has a wave-1 chat adapter (Soul execution). */
  chatExecutable: boolean;
  /** can be selected for a Soul today (chatExecutable && envConfigured). */
  available: boolean;
  /** the honest why — always set. */
  reason: string;
  /** chat-seam breaker health for executable providers; null otherwise. */
  chatSeam: ChatSeamHealth | null;
  /** the registry's model rows for this provider (reference; no chat models are registered yet). */
  models: SoulProviderModelRow[];
}

/**
 * Project the C5 registry's own tables into the resolver's source rows
 * (server-side: the route passes PROVIDER_METADATA + MODEL_REGISTRY verbatim).
 */
export function registryToSourceRows(
  metadata: Readonly<Record<string, ProviderMetadata>>,
  models: readonly ModelRegistryEntry[],
): SoulProviderSourceRow[] {
  return Object.values(metadata).map((meta) => ({
    id: meta.id,
    label: meta.label,
    aliases: meta.aliases,
    requiredEnvKey: meta.requiredEnvKey,
    models: models
      .filter((m) => m.provider === meta.id)
      .map((m) => ({
        modelId: m.modelId,
        label: m.label,
        enabled: m.enabled,
        vision: m.capabilities.vision,
        imageGen: m.capabilities['image-gen'],
        videoGen: m.capabilities['video-gen'],
        notes: m.notes,
      })),
  }));
}

function breakerHealth(status: ChatSeamHealthInput | undefined): ChatSeamHealth | null {
  if (!status) return null;
  return {
    state: status.state,
    retryAfterMs: status.retryAfterMs ?? 0,
    openedReason: status.openedReason ?? null,
  };
}

/**
 * Resolve the per-provider Soul-config status. Pure: the registry projection,
 * env, the chat-provider allow-list and the breaker snapshot are ALL injected
 * (tests never mutate process.env).
 */
export function resolveSoulProviderStatuses(
  registry: readonly SoulProviderSourceRow[],
  env: Record<string, string | undefined>,
  chatProviderIds: readonly string[],
  chatSeam?: Readonly<Record<string, ChatSeamHealthInput>>,
): SoulProviderStatusRow[] {
  const out: SoulProviderStatusRow[] = [];
  for (const meta of registry) {
    const envConfigured = !meta.requiredEnvKey || !!env[meta.requiredEnvKey]?.trim();
    const chatExecutable = chatProviderIds.includes(meta.id);
    const models: SoulProviderModelRow[] = meta.models.map((m) => ({
      modelId: m.modelId,
      label: m.label,
      enabled: m.enabled,
      capabilities: { vision: m.vision, imageGen: m.imageGen, videoGen: m.videoGen },
      notes: m.notes,
    }));
    let reason: string;
    if (!envConfigured) {
      reason = `fail-closed — ${meta.requiredEnvKey} is not configured (the registry refuses to guess credentials)`;
    } else if (!chatExecutable) {
      reason =
        'credential configured, but the provider has no chat adapter yet — the C5 model registry registers no chat-capable model for it, so Souls cannot route chat through it in this wave';
    } else {
      reason = meta.requiredEnvKey
        ? 'credential configured and a wave-1 chat adapter is available'
        : 'in-sandbox SDK binding — no credential required, a wave-1 chat adapter is available';
    }
    out.push({
      id: meta.id,
      label: meta.label,
      aliases: meta.aliases,
      requiredEnvKey: meta.requiredEnvKey,
      envConfigured,
      chatExecutable,
      available: envConfigured && chatExecutable,
      reason,
      chatSeam: chatExecutable ? breakerHealth(chatSeam?.[meta.id]) : null,
      models,
    });
  }
  return out;
}

export interface SoulProviderBindingStatus {
  /** null when the Soul's provider is not in the C5 registry at all. */
  row: SoulProviderStatusRow | null;
  available: boolean;
  reason: string;
}

/**
 * Per-soul provider status: resolve ONE soul's provider binding against the
 * resolved provider rows (the per-soul surface in the Avatars view).
 */
export function resolveSoulProviderBinding(
  provider: string,
  statuses: readonly SoulProviderStatusRow[],
): SoulProviderBindingStatus {
  const row = statuses.find((s) => s.id === provider) ?? null;
  if (!row) {
    return {
      row: null,
      available: false,
      reason: `provider "${provider}" is not in the C5 model registry — recorded provenance only; chat execution routes through the wave-1 seam`,
    };
  }
  if (!row.envConfigured) {
    return { row, available: false, reason: row.reason };
  }
  if (!row.chatExecutable) {
    return { row, available: false, reason: row.reason };
  }
  if (row.chatSeam && row.chatSeam.state === 'open') {
    const secs = Math.ceil(row.chatSeam.retryAfterMs / 1000);
    return {
      row,
      available: false,
      reason: `chat seam circuit breaker open${row.chatSeam.openedReason ? ` — ${row.chatSeam.openedReason}` : ''} (cooling, ~${secs}s); turns are refused honestly until it closes`,
    };
  }
  return { row, available: true, reason: row.reason };
}

/** Registry provider ids (helper for callers that need the full universe). */
export function soulProviderUniverse(metadata: Readonly<Record<string, ProviderMetadata>>): readonly ProviderId[] {
  return Object.keys(metadata) as ProviderId[];
}
