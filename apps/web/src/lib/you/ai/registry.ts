// ═══════════════════════════════════════════════════════════════════════════
// AI provider/model registry (Worker C lane, P6.C5; render capabilities
// extended by P6.C2).
//
// One declarative table of every model the YOU stack may route to, plus the
// single `resolveModel()` used by provider seams to pick the configured
// default for a capability. Extends the P6.C1 recon seam — it does not
// replace it: `YOU_RECON_PROVIDER` (local|openrouter, fail-closed on unknown
// values) still selects WHO sees biometric evidence; this registry decides
// WHICH model that provider runs. P6.C2 adds the same shape for the render
// path: `YOU_RENDER_PROVIDER` (station|dashscope) selects WHO renders, and
// the 'image-gen' / 'video-gen' capabilities below decide WHICH model the
// dashscope render seam runs.
//
// Laws (mirroring C1):
// - BOOT-TOLERANT, RESOLVE-STRICT: malformed or unknown env entries are
//   logged (once per reason, `[you:ai-registry]` prefix) and skipped — boot
//   never crashes on a bad `YOU_AI_*` value. Resolution, however, is
//   fail-closed: unknown provider, a provider with no enabled
//   capability-matching model, or a missing required credential key at
//   resolution time all THROW. The platform never guesses a model or a
//   credential (AGENTS.md honesty contract).
// - IMMUTABLE AFTER BOOT: MODEL_REGISTRY is deep-frozen and this module
//   exposes no registration/mutation API. Model changes are code changes
//   (reviewed), not runtime state.
// - NO FABRICATED CAPABILITY NUMBERS: `contextTokens` /
//   `maxImageInputBytes` are `null` when not verifiable from a public model
//   card or an E2E observation. null means "unverified — do not route on
//   it", never "unlimited".
//
// Env knobs (all optional; see apps/web/.env.example):
//   YOU_AI_PROVIDERS     — comma-separated "provider:model" pins, e.g.
//                          "openrouter:google/gemini-2.5-flash,zai:glm-5v-turbo".
//                          Invalid entries are logged + skipped with a
//                          documented reason.
//   YOU_AI_VISION_MODEL  — default vision model (a registry model id).
//   YOU_RECON_MODEL      — LEGACY C1 knob (openrouter passthrough, honored
//                          verbatim to keep the PR #4 contract).
//
// Resolution precedence per (provider, capability):
//   1. YOU_AI_PROVIDERS pin for the selected provider
//   2. YOU_AI_VISION_MODEL (must be a registry model of that provider)
//   3. YOU_RECON_MODEL (openrouter only; unvalidated passthrough by design)
//   4. the registry's enabled, capability-matching default for that provider
//   5. nothing left → RegistryResolutionError (fail closed)
//
// This module is intentionally dependency-free (no imports) so it can be
// unit-tested directly and imported anywhere without pulling provider SDKs.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProviderId = 'zai' | 'openrouter' | 'dashscope';

/** Provider name accepted at the seam level; 'local' is the C1 alias for zai. */
export type ProviderAlias = ProviderId | 'local';

/**
 * Routable capabilities. 'vision' is the live recon path (P6.C1/C5);
 * 'image-gen' / 'video-gen' are the render path (P6.C2 — the dashscope
 * hosted render seam resolves its model ids through these).
 */
export type Capability = 'vision' | 'image-gen' | 'video-gen';

/** Coarse routing tier for cost-aware selection — NOT a price quote. */
export type CostTier = 'free' | 'low' | 'medium' | 'high';

export interface ModelCapabilities {
  /** can analyze images (the recon path requires this)? */
  vision: boolean;
  /** can GENERATE images (the render path, P6.C2)? */
  'image-gen': boolean;
  /** can GENERATE video (the render path, P6.C2)? */
  'video-gen': boolean;
  /**
   * declared maximum single-image input size in bytes, or null when
   * unverified — callers must NOT route on null.
   */
  maxImageInputBytes: number | null;
  /**
   * declared context window in tokens (public model card), or null when
   * unverified — callers must NOT route on null.
   */
  contextTokens: number | null;
}

export interface ModelRegistryEntry {
  readonly provider: ProviderId;
  /** provider-native model id passed verbatim to the provider API. */
  readonly modelId: string;
  readonly label: string;
  readonly capabilities: ModelCapabilities;
  readonly costTier: CostTier;
  /** healthy-default flag: disabled entries are never resolved. */
  readonly enabled: boolean;
  /** capabilities this entry is the preferred default for. */
  readonly defaultFor: readonly Capability[];
  /** honest provenance/verification note (surfaced in ops debugging). */
  readonly notes: string;
}

export interface ProviderMetadata {
  readonly id: ProviderId;
  /** seam-level aliases accepted by normalizeProvider (C1: 'local'). */
  readonly aliases: readonly string[];
  readonly label: string;
  /** env var that must be present AT RESOLUTION TIME, or null if none. */
  readonly requiredEnvKey: string | null;
}

export type ResolutionSource =
  | 'provider-override' // YOU_AI_PROVIDERS pin
  | 'capability-override' // YOU_AI_VISION_MODEL
  | 'legacy-env' // YOU_RECON_MODEL (C1 passthrough; entry is null)
  | 'registry-default'; // healthy default

export interface ResolvedModel {
  readonly provider: ProviderId;
  readonly modelId: string;
  /** registry entry, or null for the legacy-env passthrough source. */
  readonly entry: ModelRegistryEntry | null;
  readonly source: ResolutionSource;
}

/** Fail-closed resolution error (never a silent fallback). */
export class RegistryResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryResolutionError';
  }
}

// ─── Provider metadata ───────────────────────────────────────────────────────

export const PROVIDER_METADATA: Readonly<Record<ProviderId, ProviderMetadata>> = deepFreeze({
  zai: {
    id: 'zai',
    aliases: ['local'], // C1 seam name: YOU_RECON_PROVIDER=local
    label: 'in-sandbox z-ai SDK (local)',
    requiredEnvKey: null, // the SDK resolves its own sandbox binding
  },
  openrouter: {
    id: 'openrouter',
    aliases: [],
    label: 'OpenRouter (hosted)',
    requiredEnvKey: 'OPENROUTER_API_KEY', // fail closed at resolution time
  },
  dashscope: {
    id: 'dashscope',
    aliases: [],
    label: 'DashScope — Alibaba Bailian (hosted)',
    requiredEnvKey: 'DASHSCOPE_API_KEY', // fail closed at resolution time (P6.C2 render seam)
  },
} as const);

// ─── The registry (frozen at module evaluation — immutable after boot) ───────

export const MODEL_REGISTRY: readonly ModelRegistryEntry[] = deepFreeze([
  {
    provider: 'zai',
    modelId: 'glm-5v-turbo',
    label: 'GLM vision (sandbox SDK binding)',
    capabilities: { vision: true, 'image-gen': false, 'video-gen': false, maxImageInputBytes: null, contextTokens: null },
    costTier: 'free', // sandbox-local accelerator, no marginal cost (AGENTS.md: free tiers are never hard dependencies)
    enabled: true,
    defaultFor: ['vision'],
    notes:
      'observed server-side binding of the in-sandbox z-ai SDK vision endpoint (chat.completions.createVision); context/input ceilings are not published to this wrapper, so they are null (unverified) — do not route on them',
  },
  {
    provider: 'openrouter',
    modelId: 'google/gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    capabilities: { vision: true, 'image-gen': false, 'video-gen': false, maxImageInputBytes: null, contextTokens: 1_048_576 },
    costTier: 'low',
    enabled: true,
    defaultFor: ['vision'],
    notes:
      'C1 default recon model (vlm-recon-or-1), E2E-proven against a contract mock in tests/contract/recon-openrouter.test.mjs; 1M-token input context per the public model card',
  },
  {
    provider: 'openrouter',
    modelId: 'google/gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    capabilities: { vision: true, 'image-gen': false, 'video-gen': false, maxImageInputBytes: null, contextTokens: 1_048_576 },
    costTier: 'high',
    enabled: true,
    defaultFor: [],
    notes: 'higher-quality vision option; 1M-token input context per the public model card',
  },
  {
    provider: 'openrouter',
    modelId: 'openai/gpt-4o-mini',
    label: 'GPT-4o mini',
    capabilities: { vision: true, 'image-gen': false, 'video-gen': false, maxImageInputBytes: null, contextTokens: 128_000 },
    costTier: 'low',
    enabled: true,
    defaultFor: [],
    notes: 'small multimodal option; 128k context per the public model card',
  },
  {
    provider: 'openrouter',
    modelId: 'meta-llama/llama-3.3-70b-instruct',
    label: 'Llama 3.3 70B',
    capabilities: { vision: false, 'image-gen': false, 'video-gen': false, maxImageInputBytes: null, contextTokens: 128_000 },
    costTier: 'low',
    enabled: true,
    defaultFor: [],
    notes: 'text-only — registered for future chat-capability routing; never selectable for vision',
  },
  {
    provider: 'openrouter',
    modelId: 'anthropic/claude-3.7-sonnet',
    label: 'Claude 3.7 Sonnet',
    capabilities: { vision: true, 'image-gen': false, 'video-gen': false, maxImageInputBytes: null, contextTokens: 200_000 },
    costTier: 'high',
    enabled: false,
    defaultFor: [],
    notes:
      'disabled: not yet E2E-verified against the OpenRouter request contract — flip enabled only after a contract-mock run (same evidence bar as the C1 default)',
  },
  {
    provider: 'dashscope',
    modelId: 'wanx2.1-t2i-turbo',
    label: 'Wanx 2.1 T2I Turbo (text-to-image)',
    capabilities: { vision: false, 'image-gen': true, 'video-gen': false, maxImageInputBytes: null, contextTokens: null },
    costTier: 'low',
    enabled: true,
    defaultFor: ['image-gen'],
    notes:
      'P6.C2 render-path default for hosted image generation (ai/dashscope.ts seam). Request contract from the public DashScope text2image docs and verified against the LOCAL contract mock in tests/contract/dashscope.test.mjs; NOT yet verified against the live provider (this sandbox has no egress/key) — flip only on live evidence if it misbehaves. Capability numbers unverified (null) — do not route on them.',
  },
  {
    provider: 'dashscope',
    modelId: 'wan2.2-t2v-plus',
    label: 'Wan 2.2 T2V Plus (text/image-to-video)',
    capabilities: { vision: false, 'image-gen': false, 'video-gen': true, maxImageInputBytes: null, contextTokens: null },
    costTier: 'medium',
    enabled: true,
    defaultFor: ['video-gen'],
    notes:
      'P6.C2 render-path default for hosted video generation (ai/dashscope.ts seam, task-based submit→poll→fetch). Same evidence bar as the image entry: public-docs request contract verified against the LOCAL contract mock only; no live-provider verification from this sandbox. Capability numbers unverified (null) — do not route on them.',
  },
] as const);

/** The frozen registry itself (alias for direct imports). */
export function listModels(): readonly ModelRegistryEntry[] {
  return MODEL_REGISTRY;
}

// ─── Fail-closed provider normalization ──────────────────────────────────────

export function normalizeProvider(input: string): ProviderId {
  const raw = input.trim().toLowerCase();
  for (const meta of Object.values(PROVIDER_METADATA)) {
    if (raw === meta.id || meta.aliases.includes(raw)) return meta.id;
  }
  throw new RegistryResolutionError(
    `unknown AI provider "${input.trim()}" — known providers: zai (alias "local"), openrouter, dashscope; refusing to guess which provider sees biometric evidence`,
  );
}

// ─── Env override parsing (pure, testable, boot-tolerant) ────────────────────

export interface ProviderOverrideParseResult {
  /** provider → model id, built from the VALID entries only. */
  overrides: ReadonlyMap<ProviderId, string>;
  /** documented skip reasons, one per invalid entry (empty when all valid). */
  warnings: string[];
}

/**
 * Parse `YOU_AI_PROVIDERS` — a comma-separated list of "provider:model" pins.
 * PURE: no logging, no env access, never throws. Every invalid entry yields
 * one warning string documenting the entry and the reason it was skipped;
 * valid entries for the same provider keep the LAST occurrence.
 */
export function parseProviderOverrides(raw: string | undefined): ProviderOverrideParseResult {
  const overrides = new Map<ProviderId, string>();
  const warnings: string[] = [];
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { overrides, warnings };
  }
  for (const segment of raw.split(',')) {
    const entry = segment.trim();
    if (entry === '') continue; // tolerate stray commas / empty segments
    const sep = entry.indexOf(':');
    if (sep <= 0 || sep === entry.length - 1) {
      warnings.push(
        `YOU_AI_PROVIDERS: skipping entry "${entry}" — expected the form "provider:model" (non-empty provider and model around a single ":")`,
      );
      continue;
    }
    const providerPart = entry.slice(0, sep).trim();
    const modelPart = entry.slice(sep + 1).trim();
    let provider: ProviderId;
    try {
      provider = normalizeProvider(providerPart);
    } catch {
      warnings.push(
        `YOU_AI_PROVIDERS: skipping entry "${entry}" — unknown provider "${providerPart}" (known: zai, local, openrouter, dashscope)`,
      );
      continue;
    }
    const known = MODEL_REGISTRY.some((e) => e.provider === provider && e.modelId === modelPart);
    if (!known) {
      warnings.push(
        `YOU_AI_PROVIDERS: skipping entry "${entry}" — model "${modelPart}" is not in the registry for provider "${provider}" (add it to apps/web/src/lib/you/ai/registry.ts first)`,
      );
      continue;
    }
    overrides.set(provider, modelPart);
  }
  return { overrides, warnings };
}

// ─── Resolution ──────────────────────────────────────────────────────────────

const loggedWarnings = new Set<string>();

/** Log each distinct parse warning once per process (boot never crashes). */
function warnOnce(message: string): void {
  if (loggedWarnings.has(message)) return;
  loggedWarnings.add(message);
  console.warn(`[you:ai-registry] ${message}`);
}

function findEntry(provider: ProviderId, modelId: string): ModelRegistryEntry | undefined {
  return MODEL_REGISTRY.find((e) => e.provider === provider && e.modelId === modelId);
}

function describeEntry(entry: ModelRegistryEntry): string {
  if (!entry.enabled) {
    return `model "${entry.modelId}" is disabled in the registry (${entry.notes})`;
  }
  return `model "${entry.modelId}" does not declare this capability`;
}

/**
 * Resolve the model to use for one capability on one provider.
 *
 * Fail-closed (throws RegistryResolutionError):
 * - unknown provider (including via YOU_AI_PROVIDERS-style typos at the seam);
 * - the provider's required credential key missing AT RESOLUTION TIME
 *   (openrouter → OPENROUTER_API_KEY — mirroring the C1 law);
 * - no enabled, capability-matching model left after overrides fall through.
 *
 * Boot-tolerant: every invalid env entry above is logged once and skipped
 * with a documented reason; resolution falls through to the next precedence
 * level instead of crashing.
 */
export function resolveModel(capability: Capability, opts: { provider: ProviderAlias }): ResolvedModel {
  const provider = normalizeProvider(opts.provider);

  const requiredKey = PROVIDER_METADATA[provider].requiredEnvKey;
  if (requiredKey && !process.env[requiredKey]?.trim()) {
    throw new RegistryResolutionError(
      `provider "${provider}" requires ${requiredKey} — refusing to guess credentials (set it before resolving models for this provider)`,
    );
  }

  // 1. per-provider pin (YOU_AI_PROVIDERS)
  const pins = parseProviderOverrides(process.env.YOU_AI_PROVIDERS);
  for (const warning of pins.warnings) warnOnce(warning);
  const pinned = pins.overrides.get(provider);
  if (pinned) {
    const entry = findEntry(provider, pinned);
    if (entry && entry.enabled && entry.capabilities[capability]) {
      return { provider, modelId: pinned, entry, source: 'provider-override' };
    }
    warnOnce(
      `YOU_AI_PROVIDERS: pin "${provider}:${pinned}" is not usable for capability "${capability}" — ${entry ? describeEntry(entry) : `model "${pinned}" is not in the registry`}; falling through to the next precedence level`,
    );
  }

  // 2. capability default (YOU_AI_VISION_MODEL)
  const visionModel = process.env.YOU_AI_VISION_MODEL?.trim();
  if (visionModel) {
    const entry = MODEL_REGISTRY.find((e) => e.modelId === visionModel);
    if (entry && entry.provider === provider && entry.enabled && entry.capabilities[capability]) {
      return { provider, modelId: visionModel, entry, source: 'capability-override' };
    }
    warnOnce(
      `YOU_AI_VISION_MODEL: "${visionModel}" is not usable for provider "${provider}" capability "${capability}" — ${
        entry
          ? entry.provider !== provider
            ? `it belongs to provider "${entry.provider}"`
            : describeEntry(entry)
          : 'it is not in the registry'
      }; falling through to the next precedence level`,
    );
  }

  // 3. legacy C1 knob (openrouter passthrough, honored verbatim — PR #4 contract)
  if (provider === 'openrouter') {
    const legacy = process.env.YOU_RECON_MODEL?.trim();
    if (legacy) {
      return { provider, modelId: legacy, entry: null, source: 'legacy-env' };
    }
  }

  // 4. registry healthy default
  const def = MODEL_REGISTRY.find(
    (e) => e.provider === provider && e.enabled && e.capabilities[capability] && e.defaultFor.includes(capability),
  );
  if (def) {
    return { provider, modelId: def.modelId, entry: def, source: 'registry-default' };
  }

  // 5. fail closed — never guess
  throw new RegistryResolutionError(
    `no enabled "${capability}"-capable model is registered for provider "${provider}" — refusing to guess a model`,
  );
}

// ─── Immutability helper ─────────────────────────────────────────────────────

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}
