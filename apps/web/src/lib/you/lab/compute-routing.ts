// ═══════════════════════════════════════════════════════════════════════════
// Compute-broker routing core (Worker C lane, P6.C3) — the PURE half of the
// broker (apps/web/src/lib/you/lab/compute.ts keeps the db-bound half).
//
// Owns everything that must be unit-testable without the app toolchain:
//   - the provider table (who can serve which workload/adapter, hosted-ness,
//     breaker key, required env key);
//   - the YOU_COMPUTE_PROVIDERS enable-list parser (boot-tolerant: malformed
//     tokens are skipped with a documented reason, boot NEVER crashes, the
//     safe default is local-executor only);
//   - the pure routing decision (first enabled match wins; privacy never
//     widens; hosted providers are skipped fail-closed when their key is
//     missing or their breaker is open; failover only ever NARROWS privacy —
//     hosted → local — never the reverse);
//   - the per-tenant quoted-cost guard decision (fail-closed: non-finite
//     accounting REFUSES the submit rather than guessing);
//   - the embedded `Job.input.__compute` routing record (build + parse) that
//     makes a dead-lettered broker job carry its quote to the dead-letter
//     list (GET /api/v1/maintenance/dead-jobs);
//   - the shared MODELED cost/latency tables — ONE source for the local
//     executor AND the hosted DashScope provider ("the same honest-cost
//     semantics as the local executor", the P6.C3 work-order law).
//
// ZERO-IMPORT MODULE (erasable TS only — no `@/` aliases, no runtime deps):
// imported directly by node:test suites under Node >= 23.6 type stripping.
// App callers import it via '@/lib/you/lab/compute-routing'.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Broker workloads (W2.C scope, unchanged by P6.C3) ──────────────────────

export const BROKER_WORKLOADS = ['render.image', 'render.video', 'twin.compile'] as const;
export type BrokerWorkload = (typeof BROKER_WORKLOADS)[number];

export function isBrokerWorkload(workload: string): workload is BrokerWorkload {
  return (BROKER_WORKLOADS as readonly string[]).includes(workload);
}

// ─── Honest cost/latency tables (shared by BOTH providers) ──────────────────
// Every cost is labeled: `zero-deterministic` (deterministic local renderer —
// no provider involved, marginal cost genuinely 0 USD) or `modeled` (provider
// pricing not exposed to this sandbox — MUST be replaced with a measured cost
// before any promotion gate). Nothing here is ever labeled `observed`.

export type ModeledCostBasis = 'zero-deterministic' | 'modeled';

export interface ModeledCost {
  usd: number;
  basis: ModeledCostBasis;
  note: string;
}

/** Default adapter per workload (mirrors the executor defaults). */
export const DEFAULT_ADAPTER: Readonly<Record<BrokerWorkload, string>> = {
  'render.image': 'svg-portrait-1',
  'render.video': 'ai-video-1',
  'twin.compile': 'vlm-recon-1',
};

/** Modeled cost estimates — the single table both providers quote from. */
export const MODELED_COST_USD: Readonly<Record<string, number>> = {
  'render.image:svg-portrait-1': 0,
  'render.image:ai-image-1': 0.04, // mirrors the adapter meta modeled estimate
  'render.video:ai-video-1': 0.1, // mirrors the adapter meta modeled estimate
  'twin.compile:vlm-recon-1': 0.02, // $0.01/invocation × estimated 2 invocations
};

/** Modeled latency estimates (used only when no observed history exists). */
export const MODELED_LATENCY_MS: Readonly<Record<string, number>> = {
  'render.image:svg-portrait-1': 200,
  'render.image:ai-image-1': 45_000,
  'render.video:ai-video-1': 260_000,
  'twin.compile:vlm-recon-1': 15_000,
};

/** Adapters that imply provider egress (privacy + routing relevant). */
export const PROVIDER_ADAPTERS: ReadonlySet<string> = new Set(['ai-image-1', 'ai-video-1', 'vlm-recon-1']);

export function resolveAdapter(workload: BrokerWorkload, adapter: string | undefined): string {
  return adapter && adapter.length > 0 ? adapter : DEFAULT_ADAPTER[workload];
}

export function costFor(workload: BrokerWorkload, adapter: string | undefined): ModeledCost {
  const resolved = resolveAdapter(workload, adapter);
  if (resolved === 'svg-portrait-1') {
    return {
      usd: 0,
      basis: 'zero-deterministic',
      note: 'deterministic local renderer — no provider involved, marginal cost is genuinely 0 USD (observable fact, not an estimate)',
    };
  }
  const usd = MODELED_COST_USD[`${workload}:${resolved}`] ?? 0;
  return {
    usd,
    basis: 'modeled',
    note: 'modeled estimate — the provider does not expose pricing to this sandbox; MUST be replaced with a measured cost before any promotion gate',
  };
}

// ─── The provider table ──────────────────────────────────────────────────────

export type ComputeProviderId = 'local-executor' | 'dashscope-render';

export interface ComputeProviderDescriptor {
  readonly id: ComputeProviderId;
  readonly label: string;
  /** true when executing on this provider sends tenant-derived data off-box. */
  readonly hosted: boolean;
  /** circuit-breaker key (core/circuit-breaker.ts), null when none applies. */
  readonly breakerKey: string | null;
  /** env var that must be present to route here, null when none applies. */
  readonly requiredEnvKey: string | null;
  readonly workloads: readonly BrokerWorkload[];
  /** adapter compatibility per workload (routing checks these explicitly). */
  readonly adapters: Readonly<Partial<Record<BrokerWorkload, readonly string[]>>>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * The broker's provider table. P6.C3 registers the hosted DashScope render
 * path (proven end-to-end by P6.C2 behind the ai/render-provider seam) as a
 * SECOND provider — routed THROUGH the broker rather than around it.
 *
 * Adapter honesty: the deterministic svg-portrait-1 renderer runs in-process
 * only, so the hosted provider serves the provider-backed render adapters
 * (ai-image-1 / ai-video-1) exclusively. twin.compile stays local-executor
 * only (its recon path is the C1 seam, not a DashScope workload).
 */
export const COMPUTE_PROVIDER_TABLE: readonly ComputeProviderDescriptor[] = deepFreeze([
  {
    id: 'local-executor',
    label: 'in-process durable job runner (station SDK + deterministic renderers)',
    hosted: false,
    breakerKey: null,
    requiredEnvKey: null,
    workloads: ['render.image', 'render.video', 'twin.compile'],
    adapters: {
      'render.image': ['svg-portrait-1', 'ai-image-1'],
      'render.video': ['ai-video-1'],
      'twin.compile': ['vlm-recon-1'],
    },
  },
  {
    id: 'dashscope-render',
    label: 'hosted DashScope (Alibaba Bailian) render path — the P6.C2 seam, broker-routed (P6.C3)',
    hosted: true,
    breakerKey: 'dashscope',
    requiredEnvKey: 'DASHSCOPE_API_KEY',
    workloads: ['render.image', 'render.video'],
    adapters: {
      'render.image': ['ai-image-1'], // svg-portrait-1 is deterministic in-process — never hosted
      'render.video': ['ai-video-1'],
    },
  },
]);

export function computeProviderDescriptor(id: string): ComputeProviderDescriptor | undefined {
  return COMPUTE_PROVIDER_TABLE.find((p) => p.id === id);
}

// ─── YOU_COMPUTE_PROVIDERS enable list (boot-tolerant parse) ─────────────────

export const COMPUTE_PROVIDER_ENV = 'YOU_COMPUTE_PROVIDERS';

/** Safe default: the in-process local executor ONLY (no hosted routing). */
export const DEFAULT_COMPUTE_PROVIDERS: readonly ComputeProviderId[] = ['local-executor'];

/** Token aliases accepted in the enable list (case/whitespace tolerant). */
const PROVIDER_TOKEN_ALIASES: Readonly<Record<string, ComputeProviderId>> = {
  'local-executor': 'local-executor',
  local: 'local-executor',
  'dashscope-render': 'dashscope-render',
  dashscope: 'dashscope-render',
};

export interface ProviderListParseResult {
  /** enabled providers in ROUTING order (first match wins). */
  readonly enabled: readonly ComputeProviderId[];
  /** one documented reason per skipped token (empty when all valid). */
  readonly warnings: readonly string[];
}

/**
 * Parse YOU_COMPUTE_PROVIDERS — an ordered, comma-separated provider list.
 * PURE: never throws, never reads env. Malformed/unknown/duplicate tokens are
 * skipped with a documented reason (boot never crashes); an empty or fully
 * invalid value falls back to the SAFE default (local-executor only — a bad
 * config can never accidentally route tenant data to a hosted provider).
 * Duplicates keep the FIRST occurrence (order is routing order; deterministic).
 */
export function parseComputeProviderList(raw: string | undefined): ProviderListParseResult {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { enabled: [...DEFAULT_COMPUTE_PROVIDERS], warnings: [] };
  }
  const enabled: ComputeProviderId[] = [];
  const warnings: string[] = [];
  const seen = new Set<ComputeProviderId>();
  for (const segment of raw.split(',')) {
    const token = segment.trim().toLowerCase();
    if (token === '') continue; // tolerate stray commas / empty segments
    const id = PROVIDER_TOKEN_ALIASES[token];
    if (id === undefined) {
      warnings.push(
        `YOU_COMPUTE_PROVIDERS: skipping token "${segment.trim()}" — unknown provider (known: local-executor [alias "local"], dashscope-render [alias "dashscope"])`,
      );
      continue;
    }
    if (seen.has(id)) {
      warnings.push(
        `YOU_COMPUTE_PROVIDERS: skipping duplicate token "${segment.trim()}" for provider "${id}" — the first occurrence fixes the routing position`,
      );
      continue;
    }
    seen.add(id);
    enabled.push(id);
  }
  if (enabled.length === 0) {
    warnings.push(
      `YOU_COMPUTE_PROVIDERS: no valid provider token in "${raw}" — falling back to the safe default "${DEFAULT_COMPUTE_PROVIDERS.join(',')}" (fail-closed: never route hosted by accident)`,
    );
    return { enabled: [...DEFAULT_COMPUTE_PROVIDERS], warnings };
  }
  return { enabled, warnings };
}

// ─── Pure routing decision ───────────────────────────────────────────────────

export interface ProviderRuntimeState {
  /** provider id matched against COMPUTE_PROVIDER_TABLE. */
  readonly id: string;
  /** breaker admission result (caller derives it from core/circuit-breaker.ts). */
  readonly available: boolean;
  /** required credential present (caller derives it from process.env). */
  readonly hasKey: boolean;
  /** verbatim unavailability detail (the breaker's message) when available=false. */
  readonly skipReason?: string;
}

export interface RoutingSkip {
  readonly providerId: string;
  readonly reason: string;
}

export interface RoutingDecision {
  /** selected provider, or null when every enabled provider was skipped. */
  readonly providerId: ComputeProviderId | null;
  /** joined, honest refusal reason when providerId is null (every skip disclosed). */
  readonly refusalReason: string | null;
  /** every skipped provider with its documented reason. */
  readonly skipped: readonly RoutingSkip[];
  /**
   * true when a hosted provider that otherwise qualified (workload + adapter +
   * privacy + key) was skipped for AVAILABILITY and the workload routed to a
   * different provider — privacy NARROWED by failover, never widened.
   */
  readonly failover: boolean;
}

export interface RouteComputeOptions {
  readonly workload: string;
  readonly adapter?: string;
  readonly privacy?: string;
  readonly enabled: readonly ComputeProviderId[];
  readonly states: readonly ProviderRuntimeState[];
}

/**
 * Route a broker workload to the first ENABLED provider that can serve it.
 * Skip reasons are pure and documented:
 *   - workload not served by the provider;
 *   - adapter not served (svg-portrait-1 is in-process only);
 *   - privacy "local-only"/"no-provider-egress" forbids hosted egress;
 *   - required credential missing (fail-closed — never route without a key);
 *   - provider unavailable (breaker open — the caller's runtime state).
 * When nothing qualifies the decision FAILS CLOSED with every skip reason.
 */
export function routeCompute(opts: RouteComputeOptions): RoutingDecision {
  const { workload } = opts;
  if (!isBrokerWorkload(workload)) {
    return {
      providerId: null,
      refusalReason: `workload "${workload}" is not broker-routed (routed: ${BROKER_WORKLOADS.join(', ')})`,
      skipped: [],
      failover: false,
    };
  }
  const adapter = resolveAdapter(workload, opts.adapter);
  const strictLocal = opts.privacy === 'local-only' || opts.privacy === 'no-provider-egress';
  const skipped: RoutingSkip[] = [];
  let hostedQualifiedButUnavailable: ComputeProviderId | null = null;
  let selected: ComputeProviderId | null = null;

  for (const id of opts.enabled) {
    const table = computeProviderDescriptor(id);
    if (table === undefined) {
      skipped.push({ providerId: id, reason: 'unknown provider id (not in the broker table)' });
      continue;
    }
    const state = opts.states.find((s) => s.id === id) ?? { id, available: true, hasKey: true };
    if (!table.workloads.includes(workload)) {
      skipped.push({ providerId: id, reason: `does not serve workload "${workload}" (serves: ${table.workloads.join(', ')})` });
      continue;
    }
    const servedAdapters = table.adapters[workload] ?? [];
    if (!servedAdapters.includes(adapter)) {
      skipped.push({
        providerId: id,
        reason: `adapter "${adapter}" not served (serves: ${servedAdapters.join(' | ')}) — svg-portrait-1 is a deterministic in-process renderer and never routes hosted`,
      });
      continue;
    }
    if (strictLocal && table.hosted) {
      skipped.push({ providerId: id, reason: `privacy "${opts.privacy}" forbids provider egress — hosted providers are skipped` });
      continue;
    }
    if (table.requiredEnvKey !== null && !state.hasKey) {
      skipped.push({ providerId: id, reason: `${table.requiredEnvKey} is not configured (fail-closed — never route without credentials)` });
      continue;
    }
    if (!state.available) {
      skipped.push({ providerId: id, reason: state.skipReason ?? 'provider unavailable (circuit breaker open)' });
      if (table.hosted) hostedQualifiedButUnavailable = id;
      continue;
    }
    selected = id;
    break;
  }

  if (selected === null) {
    const reasons =
      skipped.length > 0
        ? skipped.map((s) => `${s.providerId}: ${s.reason}`).join('; ')
        : `no enabled compute provider serves workload "${workload}" (enabled: ${opts.enabled.join(',') || 'none'})`;
    return { providerId: null, refusalReason: `compute routing refused — ${reasons}`, skipped, failover: false };
  }
  return {
    providerId: selected,
    refusalReason: null,
    skipped,
    failover: hostedQualifiedButUnavailable !== null && selected !== hostedQualifiedButUnavailable,
  };
}

// ─── Per-tenant quoted-cost guard (fail-closed) ──────────────────────────────

export const COMPUTE_QUOTA_ENV = 'YOU_COMPUTE_TENANT_MAX_COST_USD';
export const DEFAULT_TENANT_COST_CEILING_USD = 50;
export const QUOTA_WINDOW_HOURS = 24;
export const COMPUTE_QUOTA_EXCEEDED_CODE = 'compute_quota_exceeded';
export const COMPUTE_QUOTA_UNVERIFIABLE_CODE = 'compute_quota_unverifiable';

/**
 * Parse YOU_COMPUTE_TENANT_MAX_COST_USD. SAFE fallbacks: unset, empty,
 * non-numeric or negative values fall back to the default ceiling (a garbage
 * value can never silently disable the guard). An explicit "0" is a VALID
 * operator choice: block all paid work (zero-cost deterministic renders still
 * pass).
 */
export function parseTenantCostCeiling(raw: string | undefined): number {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_TENANT_COST_CEILING_USD;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TENANT_COST_CEILING_USD;
  return n;
}

export interface QuotaRefusal {
  readonly code: typeof COMPUTE_QUOTA_EXCEEDED_CODE | typeof COMPUTE_QUOTA_UNVERIFIABLE_CODE;
  readonly message: string;
  readonly details: Record<string, unknown>;
}

export interface QuotaDecision {
  readonly allowed: boolean;
  readonly ceilingUsd: number;
  readonly windowSpendUsd: number;
  readonly quotedUsd: number;
  readonly windowHours: number;
  readonly refusal: QuotaRefusal | null;
}

/**
 * The pure cost-guard decision: the tenant's rolling-window quoted spend plus
 * the new quote must stay within the ceiling. Compared in ROUNDED CENTS so
 * binary float artifacts (0.04 + 0.01 vs 0.05) can never flip a refusal.
 *
 * The window spend is a MODELED-basis, conservative upper bound: it counts
 * every broker-submitted job in the window regardless of terminal status
 * (failed/dead/cancelled included) — the fail-closed direction for a guard.
 *
 * FAIL-CLOSED: if any input is non-finite or negative (accounting broken),
 * the submit is REFUSED with the distinct unverifiable code — never guessed.
 */
export function quotaDecision(opts: {
  ceilingUsd: number;
  windowSpendUsd: number;
  quotedUsd: number;
  workload: string;
  providerId?: string;
}): QuotaDecision {
  const { ceilingUsd, windowSpendUsd, quotedUsd, workload } = opts;
  const numbersOk =
    Number.isFinite(ceilingUsd) && ceilingUsd >= 0 &&
    Number.isFinite(windowSpendUsd) && windowSpendUsd >= 0 &&
    Number.isFinite(quotedUsd) && quotedUsd >= 0;

  if (!numbersOk) {
    return {
      allowed: false,
      ceilingUsd,
      windowSpendUsd,
      quotedUsd,
      windowHours: QUOTA_WINDOW_HOURS,
      refusal: {
        code: COMPUTE_QUOTA_UNVERIFIABLE_CODE,
        message:
          `per-tenant cost accounting is unverifiable for workload "${workload}" ` +
          `(ceiling=${ceilingUsd}, windowSpend=${windowSpendUsd}, quoted=${quotedUsd}) — the submit is refused (fail-closed), never guessed`,
        details: { workload, providerId: opts.providerId ?? null, ceilingUsd, windowSpendUsd, quotedUsd, windowHours: QUOTA_WINDOW_HOURS },
      },
    };
  }

  const projectedCents = Math.round((windowSpendUsd + quotedUsd) * 100);
  const ceilingCents = Math.round(ceilingUsd * 100);
  if (projectedCents <= ceilingCents) {
    return { allowed: true, ceilingUsd, windowSpendUsd, quotedUsd, windowHours: QUOTA_WINDOW_HOURS, refusal: null };
  }
  return {
    allowed: false,
    ceilingUsd,
    windowSpendUsd,
    quotedUsd,
    windowHours: QUOTA_WINDOW_HOURS,
    refusal: {
      code: COMPUTE_QUOTA_EXCEEDED_CODE,
      message:
        `per-tenant quoted-cost ceiling exceeded: window spend $${windowSpendUsd.toFixed(2)} + new quote $${quotedUsd.toFixed(2)} ` +
        `> ceiling $${ceilingUsd.toFixed(2)} (rolling ${QUOTA_WINDOW_HOURS}h, modeled-basis quoted costs — a conservative upper bound that ` +
        `counts failed/dead/cancelled broker submits too) — submit refused (fail-closed)`,
      details: {
        workload,
        providerId: opts.providerId ?? null,
        ceilingUsd,
        windowSpendUsd,
        quotedUsd,
        windowHours: QUOTA_WINDOW_HOURS,
        basis: 'modeled (quoted costs; observed provider pricing is not exposed to this sandbox)',
      },
    },
  };
}

// ─── Embedded routing record (Job.input.__compute) ───────────────────────────

export interface EmbeddedComputeRouting {
  /** broker implementation label, e.g. 'compute-broker/p6c3'. */
  readonly broker?: string;
  /** the provider the broker routed this job to. */
  readonly providerId: string;
  /** how the routing decision was made (surfaced for operators). */
  readonly routedVia?: string;
  /** when the embedded quote was taken. */
  readonly quotePhase?: string;
  /** the full ComputeQuote embedded at submit time (shape owned by compute.ts). */
  readonly quote?: unknown;
}

/** Embed the routing record into a durable-job input (pure — copies, never mutates). */
export function embedComputeRouting(
  input: Record<string, unknown>,
  record: EmbeddedComputeRouting,
): Record<string, unknown> {
  return { ...input, __compute: { ...record } };
}

/**
 * Parse a Job.input JSON string back into the embedded routing record.
 * Returns null for anything that is not a well-formed record (a plain
 * route-submitted job stays plain — structure is never fabricated).
 */
export function parseEmbeddedCompute(inputJson: string | null | undefined): EmbeddedComputeRouting | null {
  if (!inputJson) return null;
  try {
    const parsed: unknown = JSON.parse(inputJson);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const rec = (parsed as Record<string, unknown>).__compute;
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) return null;
    const record = rec as Record<string, unknown>;
    if (typeof record.providerId !== 'string' || record.providerId.length === 0) return null;
    return {
      broker: typeof record.broker === 'string' ? record.broker : undefined,
      providerId: record.providerId,
      routedVia: typeof record.routedVia === 'string' ? record.routedVia : undefined,
      quotePhase: typeof record.quotePhase === 'string' ? record.quotePhase : undefined,
      quote: record.quote,
    };
  } catch {
    return null;
  }
}

/** Object-input variant (executors hold the parsed input object). */
export function embeddedComputeOf(input: Record<string, unknown>): EmbeddedComputeRouting | null {
  const rec = input.__compute;
  if (rec === null || rec === undefined || typeof rec !== 'object' || Array.isArray(rec)) return null;
  const record = rec as Record<string, unknown>;
  if (typeof record.providerId !== 'string' || record.providerId.length === 0) return null;
  return {
    broker: typeof record.broker === 'string' ? record.broker : undefined,
    providerId: record.providerId,
    routedVia: typeof record.routedVia === 'string' ? record.routedVia : undefined,
    quotePhase: typeof record.quotePhase === 'string' ? record.quotePhase : undefined,
    quote: record.quote,
  };
}

// ─── Broker provider → render-seam provider mapping ──────────────────────────

export type RoutedRenderProvider = 'station' | 'dashscope';

/**
 * Map the broker's routing decision onto the P6.C2 render seam override.
 *   'dashscope-render' → 'dashscope'  (the executor passes the explicit
 *                                    override; per-job routing WINS over the
 *                                    YOU_RENDER_PROVIDER env default)
 *   'local-executor'   → undefined   (no override — the C2 seam law governs:
 *                                    YOU_RENDER_PROVIDER keeps deciding the
 *                                    station/dashscope question, preserving
 *                                    every existing C2 deployment byte-for-byte)
 *   absent / unknown   → undefined   (route-submitted jobs keep env behavior)
 */
export function renderProviderForRouting(providerId: string | null | undefined): RoutedRenderProvider | undefined {
  if (providerId === 'dashscope-render') return 'dashscope';
  return undefined;
}
