// ═══════════════════════════════════════════════════════════════════════════
// Compute Broker — Worker C lane (W2.C work item C3: quote/submit surface).
//
// Mirrors the FROZEN ComputeProvider interface from services/compute/src/index.ts
// (same request shape, same five methods):
//   ComputeRequest { workload: string; minVramGb?: number; maxCostUsd?: number; privacy?: string }
//   ComputeProvider { capabilities(); quote(req); submit(req); status(id); cancel(id) }
//
// Design:
// - Provider registry. The FIRST registered provider is the in-process LOCAL
//   EXECUTOR: submit() creates the canonical durable Job row through core
//   createJob (ADR-0005: long-running jobs have ONE durable source of truth)
//   and the core runner dispatches to the Worker C executor registry. No
//   remote GPU provider exists in this pod — that is disclosed in
//   capabilities(), never implied.
// - quote() is HONEST: every cost is labeled `modeled` unless it is genuinely
//   observable. The deterministic local renderer is labeled `zero-deterministic`
//   (no provider is involved, marginal cost really is 0 USD). Provider-adapter
//   costs are `modeled` (the z-ai pod does not expose pricing). Latency
//   estimates prefer OBSERVED history (median of recent succeeded runs, with
//   run count and scope) and fall back to `modeled` when no history exists.
// - Routing: `render.video`, `render.image` (provider adapters) and
//   `twin.compile` are the broker-routed workloads of W2.C. submit() embeds the
//   quote into the durable Job input (`__compute`) so status() can surface it.
// - P6.C3 — production adapters + failover + cost guard:
//     * a SECOND registered provider, DashScopeRenderProvider ('dashscope-render'),
//       routes the hosted DashScope render path proven by P6.C2 THROUGH the
//       broker (render.image/render.video with the provider-backed adapters);
//     * submitComputeRouted() is the ONE routed submission surface: enable-list
//       routing (YOU_COMPUTE_PROVIDERS), per-provider breaker admission
//       (fail-fast 503 when open), the per-tenant quoted-cost guard
//       (YOU_COMPUTE_TENANT_MAX_COST_USD — fail-closed 402 envelope), and the
//       durable createJob with the routing record embedded — so a workload
//       whose provider exhausts its bounded retries lands in the dead-letter
//       list WITH its quote (surfaced by GET /api/v1/maintenance/dead-jobs);
//     * routing honesty: privacy never widens (strict-local requests never
//       route hosted; failover only ever narrows hosted → local); the
//       deterministic svg-portrait-1 adapter never routes hosted; a hosted
//       provider without its key is skipped fail-closed, never guessed;
//     * the pure routing/quota/embed logic lives in compute-routing.ts (the
//       zero-import, node:test-importable half of the broker).
// - cancel(): the core job runner (core/jobs.ts, Worker A lane) exposes NO
//   cancellation seam and MUST NOT be edited from this lane. Honest behavior:
//   queued jobs are truly cancelled (the runner refuses non-queued jobs, so the
//   cancellation is effective); running jobs get a durable `compute.cancel_requested`
//   event + the provider-side note that the z-ai SDK exposes no task-revocation
//   API. We never fake a cancellation that did not happen.
// ═══════════════════════════════════════════════════════════════════════════
import { db } from '@/lib/db';
import { createJob } from '../core/jobs';
import type { JobKind } from '../contracts';
import { emitEvent } from './events';
import { assertProviderAvailable } from '../core/circuit-breaker';
import { bumpCounter } from '../core/metrics';
import {
  BUDGET_ENV,
  BUDGET_METRIC,
  budgetConfigFromRow,
  budgetGuardDecision,
  parseEnvBudget,
  parseAccrualMeta,
  pickBudgetRow,
  periodStartedAt,
  accrualSumUsd,
  type AccrualRow,
  type BudgetConfig,
  type BudgetRow,
} from './cost-budgets';
import {
  BROKER_WORKLOADS,
  MODELED_LATENCY_MS,
  PROVIDER_ADAPTERS,
  QUOTA_WINDOW_HOURS,
  COMPUTE_PROVIDER_ENV,
  COMPUTE_PROVIDER_TABLE,
  costFor,
  embedComputeRouting,
  embeddedComputeOf,
  isBrokerWorkload,
  parseComputeProviderList,
  parseEmbeddedCompute,
  renderProviderForRouting,
  resolveAdapter,
  routeCompute,
  type ComputeProviderId,
  type EmbeddedComputeRouting,
  type ProviderRuntimeState,
  type RoutingDecision,
} from './compute-routing';

// The broker workload set + routing types are owned by compute-routing.ts
// (pure, node:test-importable); re-exported for the established surface.
export { BROKER_WORKLOADS, type BrokerWorkload } from './compute-routing';
export type { ComputeProviderId as BrokerProviderId } from './compute-routing';

// ─── Frozen interface mirror (services/compute/src/index.ts) ────────────────

export type ComputeRequest = {
  workload: string;
  minVramGb?: number;
  maxCostUsd?: number;
  privacy?: string;
};

export interface ComputeProvider {
  capabilities(): unknown;
  quote(req: ComputeRequest): Promise<unknown>;
  submit(req: ComputeRequest): Promise<string>;
  status(id: string): Promise<unknown>;
  cancel(id: string): Promise<void>;
}

// ─── Broker-routed workloads (W2.C scope) ───────────────────────────────────
// (BROKER_WORKLOADS + BrokerWorkload moved to compute-routing.ts — re-exported
// above — so the pure routing half carries no app-toolchain imports.)

const WORKLOAD_JOB_KIND: Record<import('./compute-routing').BrokerWorkload, JobKind> = {
  'render.image': 'render.image',
  'render.video': 'render.video',
  'twin.compile': 'twin.compile',
};

/**
 * Extended submission — the frozen ComputeRequest plus the fields the local
 * executor provider needs to create a durable job. A ComputeSubmission IS a
 * ComputeRequest (structural superset), so the frozen interface stays intact.
 */
export interface ComputeSubmission extends ComputeRequest {
  tenantId: string;
  /** durable-job input (e.g. { renderJobId, style, adapter } for renders) */
  input?: Record<string, unknown>;
  idempotencyKey?: string;
  /** render adapter hint ('svg-portrait-1' | 'ai-image-1'); affects quote honesty */
  adapter?: string;
  /**
   * P6.C12 (PR-13): the submitting APPLICATION ACTOR (an API key id) when
   * the submit originates from an application actor — scopes db budget rows
   * and usage accrual per application. Absent for interactive human
   * sessions (they accrue tenant-wide with application null).
   */
  applicationActorId?: string;
}

// ─── Quote shape — every number carries its basis ───────────────────────────

export type CostBasis = 'zero-deterministic' | 'modeled' | 'observed';
export type LatencyBasis = 'observed-history' | 'modeled' | 'none';

export interface ComputeQuote {
  providerId: string;
  workload: string;
  acceptable: boolean;
  rejectReason?: string;
  cost: { usd: number; basis: CostBasis; note: string };
  latency: { p50EstimateMs: number | null; basis: LatencyBasis; observedRuns: number; scope: 'tenant' | 'global' | 'none'; note: string };
  resources: { vramGb: number; computeClass: string; runtime: string };
  privacy: { mode: string; note: string };
  queueDepth: number;
  quotedAt: string;
}

// Modeled defaults — used ONLY when no observed history exists; always labeled.
// Default adapters mirror the executor defaults: render.image → svg-portrait-1,
// render.video → ai-video-1, twin.compile → vlm-recon-1.
// (The tables themselves live in compute-routing.ts — ONE source shared by the
// local executor AND the hosted DashScope provider: "the same honest-cost
// semantics as the local executor", the P6.C3 work-order law.)

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Observed latency history for a workload:
 * - render.image / render.video → RenderJob.latencyMs (executor-measured, real)
 *   optionally filtered by adapter;
 * - twin.compile → Job wall-clock (finishedAt − startedAt) of succeeded runs.
 * Tenant-scoped first; global fallback when the tenant has no history. The
 * scope is returned and labeled in the quote.
 */
async function observedLatencyHistory(
  tenantId: string,
  workload: import('./compute-routing').BrokerWorkload,
  adapter?: string
): Promise<{ p50Ms: number; n: number; scope: 'tenant' | 'global' } | null> {
  const collect = async (scopeTenantId: string | undefined): Promise<number[]> => {
    if (workload === 'render.image' || workload === 'render.video') {
      const kind = workload === 'render.image' ? 'image' : 'video';
      const rows = await db.renderJob.findMany({
        where: {
          kind,
          status: 'succeeded',
          latencyMs: { not: null },
          ...(scopeTenantId ? { tenantId: scopeTenantId } : {}),
          ...(workload === 'render.image' && adapter ? { adapterId: adapter } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { latencyMs: true },
      });
      return rows.map((r) => r.latencyMs as number);
    }
    const jobs = await db.job.findMany({
      where: {
        kind: 'twin.compile',
        status: 'succeeded',
        startedAt: { not: null },
        finishedAt: { not: null },
        ...(scopeTenantId ? { tenantId: scopeTenantId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { startedAt: true, finishedAt: true },
    });
    return jobs.map((j) => (j.finishedAt as Date).getTime() - (j.startedAt as Date).getTime());
  };
  const tenantRows = await collect(tenantId);
  if (tenantRows.length > 0) return { p50Ms: median(tenantRows), n: tenantRows.length, scope: 'tenant' };
  const globalRows = await collect(undefined);
  if (globalRows.length > 0) return { p50Ms: median(globalRows), n: globalRows.length, scope: 'global' };
  return null;
}

// ─── Status shape ────────────────────────────────────────────────────────────

export interface ComputeStatusView {
  jobId: string;
  workload: string;
  providerId: string;
  status: string;
  progress: number;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  error?: string | null;
  /** quote embedded at submit time (broker-submitted jobs) */
  quote?: ComputeQuote | null;
  /** quote recorded by the executor at execution start (route-submitted jobs) */
  executionQuote?: ComputeQuote | null;
  /** how the broker routed this job (broker-submitted jobs; null otherwise) */
  routedVia?: string | null;
  observed?: {
    latencyMs: number | null;
    costUsd: number | null;
    costBasis: string | null;
    source: string;
  } | null;
  output?: Record<string, unknown> | null;
}

// ─── P6.C3: typed broker errors (mapped to honest API envelopes by routes) ───

/** Per-tenant quoted-cost ceiling exceeded — the route maps this to a 402 envelope. */
export class ComputeQuotaExceededError extends Error {
  readonly code: 'compute_quota_exceeded' | 'compute_quota_unverifiable';
  readonly details: Record<string, unknown>;
  constructor(refusal: { code: 'compute_quota_exceeded' | 'compute_quota_unverifiable'; message: string; details: Record<string, unknown> }) {
    super(refusal.message);
    this.name = 'ComputeQuotaExceededError';
    this.code = refusal.code;
    this.details = refusal.details;
  }
}

/** No enabled provider could serve the workload — every skip reason is disclosed. */
export class ComputeRoutingRefusedError extends Error {
  readonly code = 'compute_routing_refused' as const;
  readonly details: { skipped: { providerId: string; reason: string }[] };
  constructor(refusalReason: string, skipped: readonly { providerId: string; reason: string }[]) {
    super(refusalReason);
    this.name = 'ComputeRoutingRefusedError';
    this.details = { skipped: [...skipped] };
  }
}

// ─── P6.C3: hosted DashScope render provider (the SECOND provider) ───────────

export const DASHSCOPE_RENDER_PROVIDER_ID: ComputeProviderId = 'dashscope-render';

/** Honest quote for a HOSTED (dashscope-render) broker workload. */
export async function quoteComputeHosted(req: ComputeRequest): Promise<ComputeQuote> {
  const workload = req.workload;
  if (!isBrokerWorkload(workload)) {
    throw new Error(
      `validation_failed: workload "${workload}" is not broker-routed in W2.C (routed: ${BROKER_WORKLOADS.join(', ')})`
    );
  }
  if (workload === 'twin.compile') {
    throw new Error(
      `validation_failed: workload "twin.compile" is local-executor only (the C1 recon seam) — the hosted DashScope provider serves render.image/render.video provider adapters exclusively`
    );
  }
  const submission = req as ComputeSubmission;
  const tenantId = typeof submission.tenantId === 'string' ? submission.tenantId : '';
  const resolved = resolveAdapter(workload, submission.adapter);
  const adapter = submission.adapter;

  // SAME honest-cost semantics as the local executor — the modeled table is
  // shared (compute-routing.ts): one source, one label law.
  const cost = costFor(workload, adapter);
  const history = tenantId ? await observedLatencyHistory(tenantId, workload, resolved) : null;
  const modeledMs = MODELED_LATENCY_MS[`${workload}:${resolved}`] ?? null;

  const queueDepth = tenantId
    ? await db.job.count({ where: { tenantId, status: { in: ['queued', 'provisioning', 'running', 'collecting'] } } })
    : 0;

  // honest acceptance checks — refusals carry the reason
  const rejectReasons: string[] = [];
  if (resolved === 'svg-portrait-1') {
    rejectReasons.push(
      'adapter "svg-portrait-1" is a deterministic in-process renderer — it never routes hosted (request the ai-image-1 provider adapter, or route local-executor)'
    );
  }
  const hasKey = Boolean((process.env.DASHSCOPE_API_KEY ?? '').trim());
  if (!hasKey) {
    rejectReasons.push('DASHSCOPE_API_KEY is not configured (fail-closed — the hosted provider is never quoted usable without credentials)');
  }
  if (typeof req.minVramGb === 'number' && req.minVramGb > 0) {
    rejectReasons.push(
      `the hosted DashScope API does not expose per-request VRAM — minVramGb=${req.minVramGb} cannot be VERIFIED, and an unverifiable GPU class is never claimed`
    );
  }
  if (typeof req.maxCostUsd === 'number' && cost.usd > req.maxCostUsd) {
    rejectReasons.push(`quoted cost $${cost.usd} (${cost.basis}) exceeds maxCostUsd $${req.maxCostUsd}`);
  }
  const strictLocal = req.privacy === 'local-only' || req.privacy === 'no-provider-egress';
  if (strictLocal) {
    rejectReasons.push(`privacy "${req.privacy}" forbids provider egress — hosted rendering sends consent-gated tenant-derived data to DashScope`);
  }

  return {
    providerId: DASHSCOPE_RENDER_PROVIDER_ID,
    workload,
    acceptable: rejectReasons.length === 0,
    ...(rejectReasons.length > 0 ? { rejectReason: rejectReasons.join('; ') } : {}),
    cost,
    latency: history
      ? {
          p50EstimateMs: history.p50Ms,
          basis: 'observed-history',
          observedRuns: history.n,
          scope: history.scope,
          note: `median of ${history.n} recent succeeded ${workload} run(s) via ${resolved}, ${history.scope}-scoped, from measured executor latencies (provider-agnostic — RenderJob rows record real latency whichever provider served)`,
        }
      : {
          p50EstimateMs: modeledMs,
          basis: 'modeled',
          observedRuns: 0,
          scope: 'none',
          note: `no observed history yet — modeled default for ${resolved} (${modeledMs}ms) is an estimate, not a measurement`,
        },
    resources: {
      vramGb: 0,
      computeClass: 'hosted GPU (DashScope WANX/Wan models) — per-request VRAM is not exposed by the provider API; minVramGb requirements are refused as unverifiable rather than guessed',
      runtime: 'DashScope HTTP APIs (ai/dashscope.ts) — submit → bounded poll → fetch, breaker+retry per A6-FULL',
    },
    privacy: {
      mode: 'tenant-data-egress-hosted',
      note: 'consent-gated prompts derived from HTIR descriptors are sent to DashScope (Alibaba Bailian) — the P6.C2 anti-impersonation prompt policy applies; deterministic renders never leave the process',
    },
    queueDepth,
    quotedAt: new Date().toISOString(),
  };
}

/**
 * The hosted DashScope render provider — the production render path proven by
 * P6.C2, routed THROUGH the broker (P6.C3). Models resolve through the C5
 * registry ('image-gen' / 'video-gen') inside the render seam; execution runs
 * in the durable job runner like every broker workload, with the render
 * executors honoring the embedded per-job provider override.
 */
export class DashScopeRenderProvider implements ComputeProvider {
  capabilities(): unknown {
    return {
      providerId: DASHSCOPE_RENDER_PROVIDER_ID,
      runtime: 'hosted DashScope (Alibaba Bailian) HTTP APIs via ai/dashscope.ts — the P6.C2 seam, broker-routed since P6.C3',
      workloads: ['render.image', 'render.video'],
      adapters: {
        'render.image': ['ai-image-1 (hosted wanx image generation — the deterministic svg-portrait-1 adapter never routes here)'],
        'render.video': ['ai-video-1 (hosted Wan video generation, task-based submit → bounded poll → fetch)'],
      },
      models: 'resolved through the C5 registry (ai/registry.ts — image-gen / video-gen capabilities; wanx2.1-t2i-turbo / wan2.2-t2v-plus defaults)',
      credentials: 'DASHSCOPE_API_KEY required at resolution time (fail-closed — a missing key skips this provider in routing, never guesses)',
      resilience:
        'per-provider circuit breaker (key "dashscope") INSIDE the bounded retry loop (A6-FULL composition, ai/dashscope.ts runResilient); broker submits additionally fail fast while the breaker is open (assertProviderAvailable at submit — honest 503 + Retry-After)',
      deadLetter:
        'a hosted-routed workload whose provider exhausts the bounded job retries lands in the terminal dead state WITH its embedded quote (GET /api/v1/maintenance/dead-jobs surfaces compute.quote)',
      computeClass: 'hosted GPU — per-request VRAM not exposed; minVramGb requirements are refused as unverifiable',
      gpu: true,
      vramGb: null,
      durability: 'submit() creates the canonical Job row via core createJob (ADR-0005); the routing record + quote are embedded in Job.input.__compute',
      cancellation: 'same honest semantics as the local executor — queued jobs cancel effectively; running jobs record cancel_requested durably (no cooperative-cancel seam in the core runner; DashScope tasks are not revocable via this API surface)',
      costHonesty:
        'the SAME modeled-cost table as the local executor (compute-routing.ts): $0.04 / image, $0.10 / video — modeled basis, provider pricing not exposed to this sandbox; never observed',
      latencyHonesty: 'latency estimates prefer observed RenderJob history (provider-agnostic); modeled defaults are labeled when no history exists',
    };
  }

  async quote(req: ComputeRequest): Promise<ComputeQuote> {
    return quoteComputeHosted(req);
  }

  async submit(req: ComputeRequest): Promise<string> {
    const submission = asSubmission(req);
    const { jobId } = await submitComputeRouted({ ...submission, provider: DASHSCOPE_RENDER_PROVIDER_ID });
    return jobId;
  }

  async status(id: string): Promise<ComputeStatusView> {
    return computeStatus(id);
  }

  async cancel(id: string): Promise<void> {
    await cancelCompute(id);
  }
}

// ─── P6.C3: routed submission (the ONE production submit surface) ───────────

/** Warnings for malformed YOU_COMPUTE_PROVIDERS tokens log once per reason. */
const loggedProviderListWarnings = new Set<string>();

function currentEnv(): Record<string, string | undefined> {
  return typeof process !== 'undefined' && process.env ? process.env : {};
}

/** Per-provider runtime state for routing (breaker admission + credentials). */
function providerRuntimeStates(): ProviderRuntimeState[] {
  return COMPUTE_PROVIDER_TABLE.map((p) => {
    const hasKey = p.requiredEnvKey === null || Boolean((currentEnv()[p.requiredEnvKey] ?? '').trim());
    if (p.breakerKey !== null) {
      try {
        assertProviderAvailable(p.breakerKey);
      } catch (err) {
        return {
          id: p.id,
          available: false,
          hasKey,
          skipReason: err instanceof Error ? err.message : String(err),
        } satisfies ProviderRuntimeState;
      }
    }
    return { id: p.id, available: true, hasKey } satisfies ProviderRuntimeState;
  });
}

/**
 * The tenant's rolling-window quoted spend (USD, modeled basis): the sum of
 * embedded quote costs over the tenant's broker-submitted jobs in the last
 * QUOTA_WINDOW_HOURS hours — a conservative upper bound that counts every
 * terminal status (failed/dead/cancelled included — the fail-closed direction
 * for a guard). Bounded to the 500 most recent broker-submitted rows (a tenant
 * exceeding 500 paid submits in 24h has exceeded any sane ceiling long before
 * the bound matters — disclosed rather than hidden).
 */
export async function tenantQuotedSpendUsd(tenantId: string): Promise<number> {
  const since = new Date(Date.now() - QUOTA_WINDOW_HOURS * 60 * 60 * 1000);
  const rows = await db.job.findMany({
    where: {
      tenantId,
      createdAt: { gte: since },
      // broker-submitted jobs carry the embedded routing record
      input: { contains: '"__compute"' },
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: { input: true },
  });
  let sum = 0;
  for (const row of rows) {
    const embedded = parseEmbeddedCompute(row.input);
    const quote = embedded?.quote as { cost?: { usd?: unknown } } | undefined | null;
    const usd = quote?.cost?.usd;
    if (typeof usd === 'number' && Number.isFinite(usd) && usd > 0) sum += usd;
  }
  return Math.round(sum * 100) / 100;
}

export interface RoutedSubmitResult {
  jobId: string;
  quote: ComputeQuote;
  providerId: ComputeProviderId;
  routedVia: string;
  /** P6.C12: the budget config the guard actually used (source disclosed). */
  budget: BudgetConfig;
}

interface RoutedSubmission extends ComputeSubmission {
  /** force a specific provider (used by DashScopeRenderProvider.submit); default = routed. */
  provider?: ComputeProviderId;
}

// ─── P6.C12 (PR-13): the cost-budget layer (db-bound half) ──────────────────

/**
 * The tenant's accrual rows for the budget metric in a rolling period
 * (bounded to the 1000 most recent — the same disclosed-bound law as
 * tenantQuotedSpendUsd). Application-scoped budgets filter by the
 * applicationActorId meta field client-side (meta is a JSON string column).
 */
export async function budgetAccrualRows(
  tenantId: string,
  since: Date,
  applicationActorId?: string | null,
): Promise<AccrualRow[]> {
  const rows = await db.usageRecord.findMany({
    where: { tenantId, metric: BUDGET_METRIC, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 1000,
    select: { quantity: true, createdAt: true, meta: true },
  });
  const out: AccrualRow[] = [];
  for (const row of rows) {
    const meta = parseAccrualMeta(row.meta);
    if (applicationActorId !== undefined && applicationActorId !== null) {
      if (meta.applicationActorId !== applicationActorId) continue;
    }
    out.push({
      quantity: row.quantity,
      createdAt: row.createdAt,
      workload: meta.workload,
      applicationActorId: meta.applicationActorId,
      jobId: meta.jobId,
    });
  }
  return out;
}

/**
 * Resolve the budget config for a submit: the MOST SPECIFIC db CostBudget row
 * for (tenant, application, workload) wins; without rows the env ceiling
 * applies (parseEnvBudget — the explicit unlimited opt-in lives there);
 * without either, the documented fail-closed default. A db row ALWAYS beats
 * the env value (rows are the deliberate, more specific operator choice);
 * invalid rows are skipped by the pure picker (a garbage row can never
 * disable the guard).
 */
export async function resolveCostBudget(opts: {
  tenantId: string;
  workload: string;
  applicationActorId?: string | null;
}): Promise<BudgetConfig> {
  const rows: BudgetRow[] = await db.costBudget.findMany({
    where: { tenantId: opts.tenantId },
    select: { id: true, applicationId: true, pipeline: true, budgetUsd: true, periodHours: true, note: true, updatedAt: true },
  });
  const picked = pickBudgetRow(rows, {
    tenantId: opts.tenantId,
    applicationId: opts.applicationActorId ?? null,
    workload: opts.workload,
  });
  if (picked !== null) {
    return budgetConfigFromRow(picked);
  }
  return parseEnvBudget(currentEnv()[BUDGET_ENV]);
}

/**
 * Accrue one broker submit's quoted cost (P6.C12): a UsageRecord row under
 * metric 'compute.quoted_usd' with meta { workload, providerId, jobId,
 * applicationActorId, basis }. The accrual is the durable per-pipeline /
 * per-application usage truth behind GET /api/v1/usage's cost section and the
 * budget guard's window spend. Honest best-effort: a failure LOGS (the submit
 * already succeeded — the durable job exists) and is counted, never thrown.
 */
async function accrueQuotedCost(opts: {
  tenantId: string;
  workload: string;
  providerId: string;
  jobId: string;
  quotedUsd: number;
  basis: string;
  applicationActorId?: string | null;
}): Promise<void> {
  try {
    await db.usageRecord.create({
      data: {
        tenantId: opts.tenantId,
        metric: BUDGET_METRIC,
        quantity: Number.isFinite(opts.quotedUsd) && opts.quotedUsd >= 0 ? opts.quotedUsd : 0,
        meta: JSON.stringify({
          workload: opts.workload,
          providerId: opts.providerId,
          jobId: opts.jobId,
          applicationActorId: opts.applicationActorId ?? null,
          basis: opts.basis,
        }),
      },
    });
  } catch (err) {
    bumpCounter('budget_accrual_failures', { workload: opts.workload });
    console.error(
      `[you:budget] accrueQuotedCost(${opts.workload}, $${opts.quotedUsd}) failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * THE routed submission surface (P6.C3):
 *   1. enable-list routing (YOU_COMPUTE_PROVIDERS — boot-tolerant parse, safe
 *      default local-executor; unknown tokens logged + skipped);
 *   2. provider quote with the SHARED honest-cost tables;
 *   3. per-provider breaker admission — a hosted provider whose breaker is open
 *      is skipped (failover narrows privacy, never widens) or the submit fails
 *      closed with every skip reason disclosed;
 *   4. per-tenant quoted-cost guard (YOU_COMPUTE_TENANT_MAX_COST_USD) — refuse
 *      with the typed 402-class error, counted in /api/v1/metrics;
 *   5. durable createJob with the routing record + quote embedded — so status()
 *      surfaces them and a dead-lettered job carries its quote to the
 *      dead-letter list.
 */
export async function submitComputeRouted(req: RoutedSubmission): Promise<RoutedSubmitResult> {
  const workload = req.workload;
  if (!isBrokerWorkload(workload)) {
    throw new Error(
      `validation_failed: workload "${workload}" is not broker-routed in W2.C (routed: ${BROKER_WORKLOADS.join(', ')})`
    );
  }
  if (!req.tenantId) {
    throw new Error('validation_failed: ComputeSubmission.tenantId is required for routed broker submits');
  }

  // 1. enable list (boot-tolerant; warnings logged once per reason per process)
  const { enabled, warnings } = parseComputeProviderList(currentEnv()[COMPUTE_PROVIDER_ENV]);
  for (const warning of warnings) {
    if (!loggedProviderListWarnings.has(warning)) {
      loggedProviderListWarnings.add(warning);
      console.warn(`[you:compute-broker] ${warning}`);
    }
  }

  // 2. routing (pure decision; states carry breaker admission + credentials)
  const states = providerRuntimeStates();
  const decision: RoutingDecision = routeCompute({
    workload,
    adapter: req.adapter,
    privacy: req.privacy,
    enabled: req.provider ? [req.provider] : enabled,
    states,
  });
  if (decision.providerId === null) {
    bumpCounter('compute_routing_refusals', { workload });
    throw new ComputeRoutingRefusedError(decision.refusalReason ?? 'compute routing refused', decision.skipped);
  }
  if (decision.failover) {
    bumpCounter('compute_failovers', { to: decision.providerId });
  }
  const providerId = decision.providerId;

  // 3. provider quote (shared honest-cost tables; refusal reasons carried)
  const quote = providerId === DASHSCOPE_RENDER_PROVIDER_ID ? await quoteComputeHosted(req) : await quoteCompute(req);
  if (!quote.acceptable) {
    throw new Error(`compute_refused: ${quote.rejectReason ?? 'quote not acceptable'}`);
  }

  // 4. cost-budget guard (P6.C12 / PR-13 — db-backed budgets with env/default
  //    fallback; fail-closed: unlimited is an EXPLICIT env opt-in, never a
  //    default). The window spend is the UsageRecord accrual (metric
  //    'compute.quoted_usd') over the config's rolling period — the same
  //    conservative modeled-basis numbers the /api/v1/usage cost section
  //    reports. Application-scoped rows count only that application actor's
  //    accrual; tenant-wide rows count everything.
  const budgetConfig = await resolveCostBudget({
    tenantId: req.tenantId,
    workload,
    applicationActorId: req.applicationActorId ?? null,
  });
  if (budgetConfig.mode === 'unlimited') {
    // the EXPLICIT operator opt-out (env token only — db rows always apply)
    bumpCounter('compute_budget_unlimited_skips', { workload });
  } else {
    const since = periodStartedAt(new Date(), budgetConfig.periodHours);
    const accrualScope =
      budgetConfig.applicationId !== null ? (req.applicationActorId ?? null) : undefined;
    const rows = await budgetAccrualRows(req.tenantId, since, accrualScope);
    const accruedUsd = accrualSumUsd(rows);
    const guard = budgetGuardDecision({
      config: budgetConfig,
      accruedUsd,
      quotedUsd: quote.cost.usd,
      workload,
      providerId,
    });
    if (!guard.allowed || guard.refusal !== null) {
      bumpCounter('compute_quota_refusals', { workload });
      throw new ComputeQuotaExceededError(guard.refusal as {
        code: 'compute_quota_exceeded' | 'compute_quota_unverifiable';
        message: string;
        details: Record<string, unknown>;
      });
    }
  }

  // 5. durable job with the routing record + quote embedded
  bumpCounter('compute_submits', { provider: providerId, workload });
  bumpCounter('compute_quoted_usd_cents', { provider: providerId, workload }, Math.round(quote.cost.usd * 100));
  const routedVia =
    `compute-broker/p6c3 routing (enabled: ${enabled.join(' > ')}; selected ${providerId}` +
    `${decision.skipped.length > 0 ? `; skipped: ${decision.skipped.map((s) => `${s.providerId} (${s.reason})`).join(' | ')}` : ''})`;
  const input = embedComputeRouting(req.input ?? {}, {
    broker: 'compute-broker/p6c3',
    providerId,
    routedVia,
    quotePhase: 'submit-time',
    quote,
  });
  const job = await createJob(req.tenantId, WORKLOAD_JOB_KIND[workload], input, req.idempotencyKey);

  // 6. P6.C12: accrue the quoted cost per tenant/application/pipeline (the
  //    durable usage truth behind the budget guard + GET /api/v1/usage)
  await accrueQuotedCost({
    tenantId: req.tenantId,
    workload,
    providerId,
    jobId: job.id,
    quotedUsd: quote.cost.usd,
    basis: quote.cost.basis,
    applicationActorId: req.applicationActorId ?? null,
  });

  await emitEvent(req.tenantId, 'compute.submitted', 'job', job.id, {
    jobId: job.id,
    workload,
    providerId,
    routedVia,
    idempotent: Boolean(req.idempotencyKey),
    quote: {
      cost: { usd: quote.cost.usd, basis: quote.cost.basis },
      latency: { p50EstimateMs: quote.latency.p50EstimateMs, basis: quote.latency.basis, observedRuns: quote.latency.observedRuns },
    },
    budget: { source: budgetConfig.source, mode: budgetConfig.mode, budgetUsd: budgetConfig.budgetUsd },
  });

  return { jobId: job.id, quote, providerId, routedVia, budget: budgetConfig };
}

// ─── P6.C3: executor-facing helpers (embedded routing → render seam) ────────

/** The embedded routing record of a durable-job input object (or null). */
export function embeddedComputeRoutingOf(input: Record<string, unknown>): EmbeddedComputeRouting | null {
  return embeddedComputeOf(input);
}

/**
 * The render-seam provider override for a durable-job input: 'dashscope' when
 * the broker routed the job to the hosted provider (per-job routing WINS over
 * the YOU_RENDER_PROVIDER env); undefined otherwise — the C2 seam law keeps
 * deciding (station/dashscope from env), preserving existing deployments.
 */
export function routedRenderProvider(
  input: Record<string, unknown>,
): import('../ai/render-provider').RenderProvider | undefined {
  return renderProviderForRouting(embeddedComputeOf(input)?.providerId);
}

// ─── Local executor provider (the FIRST provider) ───────────────────────────

export const LOCAL_EXECUTOR_PROVIDER_ID = 'local-executor';

export class LocalExecutorProvider implements ComputeProvider {
  capabilities(): unknown {
    return {
      providerId: LOCAL_EXECUTOR_PROVIDER_ID,
      runtime: 'in-process — apps/web durable job runner (core createJob/runJob → Worker C executor registry)',
      workloads: [...BROKER_WORKLOADS],
      adapters: {
        'render.image': ['svg-portrait-1 (deterministic, local)', 'ai-image-1 (z-ai provider adapter)'],
        'render.video': ['ai-video-1 (z-ai provider adapter)'],
        'twin.compile': ['vlm-recon-1 (z-ai VLM provider adapter)'],
      },
      computeClass: 'local-cpu + z-ai provider APIs',
      gpu: false,
      vramGb: 0,
      providerCompute:
        'z-ai SDK (chat/vision/image/video) — real provider compute when the pod provides it; provider availability and rate limits are surfaced verbatim, never implied',
      durability: 'submit() creates the canonical Job row via core createJob — one durable source of truth (ADR-0005); the quote is embedded in Job.input.__compute',
      cancellation:
        'queued jobs: cancelled effectively (the core runner refuses non-queued jobs). running jobs: cancel_requested is recorded durably, but the core job runner exposes NO cooperative cancellation seam (W2.C compatibility note — Worker A lane) and the z-ai SDK exposes no task-revocation API, so execution may still complete. No fake cancellation is ever reported.',
      costHonesty: 'every quote cost is labeled: zero-deterministic (local deterministic renderer) or modeled (provider pricing not exposed); never observed for provider adapters in this pod',
      latencyHonesty: 'latency estimates prefer observed history (median of recent succeeded runs, labeled with run count + scope); modeled defaults are labeled when no history exists',
    };
  }

  async quote(req: ComputeRequest): Promise<ComputeQuote> {
    return quoteCompute(req);
  }

  async submit(req: ComputeRequest): Promise<string> {
    const submission = asSubmission(req);
    const { jobId } = await submitCompute(submission);
    return jobId;
  }

  async status(id: string): Promise<ComputeStatusView> {
    return computeStatus(id);
  }

  async cancel(id: string): Promise<void> {
    await cancelCompute(id);
  }
}

function asSubmission(req: ComputeRequest): ComputeSubmission {
  const full = req as ComputeSubmission;
  if (!full || typeof full.tenantId !== 'string' || full.tenantId.length === 0) {
    throw new Error(
      `validation_failed: local-executor submit requires a tenantId (extended ComputeSubmission field; the frozen ComputeRequest stays unchanged)`
    );
  }
  return full;
}

// ─── Broker operations ───────────────────────────────────────────────────────

/** Honest quote for a broker-routed workload. */
export async function quoteCompute(req: ComputeRequest): Promise<ComputeQuote> {
  const workload = req.workload;
  if (!isBrokerWorkload(workload)) {
    throw new Error(
      `validation_failed: workload "${workload}" is not broker-routed in W2.C (routed: ${BROKER_WORKLOADS.join(', ')})`
    );
  }
  const submission = req as ComputeSubmission;
  const tenantId = typeof submission.tenantId === 'string' ? submission.tenantId : '';
  const resolved = resolveAdapter(workload, submission.adapter);
  const adapter = submission.adapter;

  const cost = costFor(workload, adapter);
  const history = tenantId ? await observedLatencyHistory(tenantId, workload, resolved) : null;
  const modeledMs = MODELED_LATENCY_MS[`${workload}:${resolved}`] ?? null;

  const queueDepth = tenantId
    ? await db.job.count({ where: { tenantId, status: { in: ['queued', 'provisioning', 'running', 'collecting'] } } })
    : 0;

  // honest acceptance checks — refusals carry the reason
  const rejectReasons: string[] = [];
  if (typeof req.minVramGb === 'number' && req.minVramGb > 0) {
    rejectReasons.push(
      `local-executor has no GPU (vramGb=0) but minVramGb=${req.minVramGb} was required — no remote GPU provider is registered in this pod`
    );
  }
  if (typeof req.maxCostUsd === 'number' && cost.usd > req.maxCostUsd) {
    rejectReasons.push(`quoted cost $${cost.usd} (${cost.basis}) exceeds maxCostUsd $${req.maxCostUsd}`);
  }
  const strictLocal = req.privacy === 'local-only' || req.privacy === 'no-provider-egress';
  const usesProvider = PROVIDER_ADAPTERS.has(resolved);
  if (strictLocal && usesProvider) {
    rejectReasons.push(
      `privacy "${req.privacy}" forbids provider egress, but workload ${workload} (${resolved}) requires z-ai provider calls (only svg-portrait-1 is fully local)`
    );
  }
  return {
    providerId: LOCAL_EXECUTOR_PROVIDER_ID,
    workload,
    acceptable: rejectReasons.length === 0,
    ...(rejectReasons.length > 0 ? { rejectReason: rejectReasons.join('; ') } : {}),
    cost,
    latency: history
      ? {
          p50EstimateMs: history.p50Ms,
          basis: 'observed-history',
          observedRuns: history.n,
          scope: history.scope,
          note: `median of ${history.n} recent succeeded ${workload} run(s) via ${resolved}, ${history.scope}-scoped, from measured executor latencies`,
        }
      : {
          p50EstimateMs: modeledMs,
          basis: 'modeled',
          observedRuns: 0,
          scope: 'none',
          note: `no observed history yet — modeled default for ${resolved} (${modeledMs}ms) is an estimate, not a measurement`,
        },
    resources: {
      vramGb: 0,
      computeClass: 'local-cpu + z-ai provider APIs',
      runtime: 'in-process durable job runner',
    },
    privacy: {
      mode: usesProvider ? 'tenant-local-with-provider-egress' : 'local-only',
      note: usesProvider
        ? `inputs derived from consented data are sent to the z-ai provider via ${resolved} (consent-gated); deterministic svg renders never leave the process`
        : 'svg-portrait-1 renders fully locally — no egress',
    },
    queueDepth,
    quotedAt: new Date().toISOString(),
  };
}

/** Submit through the broker: quote → embed → durable job (core createJob). */
export async function submitCompute(req: ComputeSubmission): Promise<{ jobId: string; quote: ComputeQuote }> {
  const workload = req.workload;
  if (!isBrokerWorkload(workload)) {
    throw new Error(
      `validation_failed: workload "${workload}" is not broker-routed in W2.C (routed: ${BROKER_WORKLOADS.join(', ')})`
    );
  }
  if (!req.tenantId) {
    throw new Error('validation_failed: ComputeSubmission.tenantId is required for the local-executor provider');
  }
  const quote = await quoteCompute(req);
  if (!quote.acceptable) {
    throw new Error(`compute_refused: ${quote.rejectReason ?? 'quote not acceptable'}`);
  }

  const input = { ...(req.input ?? {}) };
  const job = await createJob(
    req.tenantId,
    WORKLOAD_JOB_KIND[workload],
    {
      ...input,
      __compute: {
        broker: 'compute-broker/w2c',
        providerId: LOCAL_EXECUTOR_PROVIDER_ID,
        quotePhase: 'submit-time',
        quote,
      },
    },
    req.idempotencyKey
  );
  await emitEvent(req.tenantId, 'compute.submitted', 'job', job.id, {
    jobId: job.id,
    workload,
    providerId: LOCAL_EXECUTOR_PROVIDER_ID,
    idempotent: Boolean(req.idempotencyKey),
    quote: {
      cost: { usd: quote.cost.usd, basis: quote.cost.basis },
      latency: { p50EstimateMs: quote.latency.p50EstimateMs, basis: quote.latency.basis, observedRuns: quote.latency.observedRuns },
    },
  });

  return { jobId: job.id, quote };
}

/** Status of a broker-submitted (or any) job, with quote + observed fields. */
export async function computeStatus(jobId: string): Promise<ComputeStatusView> {
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`not_found: job ${jobId}`);

  // P6.C3: the embedded routing record is parsed through the SAME pure helper
  // the dead-letter list uses (compute-routing.ts) — one source of truth. The
  // surfaced providerId is the provider the broker actually ROUTED to (honest
  // for hosted-routed jobs), not a hardcoded local-executor label.
  const embeddedRouting = parseEmbeddedCompute(job.input);
  const parsedInput = safeParse<Record<string, unknown>>(job.input, {});
  const embedded =
    embeddedRouting !== null
      ? { quote: (embeddedRouting.quote ?? null) as ComputeQuote | null, quotePhase: embeddedRouting.quotePhase }
      : null;
  let parsedOutput: Record<string, unknown> | null = null;
  if (job.output) {
    const out = safeParse<Record<string, unknown> | null>(job.output, null);
    if (out) parsedOutput = out;
  }

  const computeRecord = (parsedOutput?.compute ?? null) as
    | { quote?: ComputeQuote; observed?: { latencyMs?: number | null; costUsd?: number | null; costBasis?: string | null; note?: string } }
    | null;

  // observed fields: executor-recorded compute record first; RenderJob fallback
  // for render workloads (RenderJob.latencyMs/costUsd are persisted by executors).
  let observed: ComputeStatusView['observed'] = null;
  if (computeRecord?.observed) {
    observed = {
      latencyMs: computeRecord.observed.latencyMs ?? null,
      costUsd: computeRecord.observed.costUsd ?? null,
      costBasis: computeRecord.observed.costBasis ?? null,
      source: 'job output compute record (executor-recorded)',
    };
  } else {
    const renderJobId = typeof parsedInput.renderJobId === 'string' ? parsedInput.renderJobId : null;
    if (renderJobId) {
      const r = await db.renderJob.findUnique({ where: { id: renderJobId } });
      if (r && (r.latencyMs !== null || r.costUsd !== null)) {
        observed = {
          latencyMs: r.latencyMs,
          costUsd: r.costUsd,
          costBasis: r.costUsd === 0 ? 'zero-deterministic' : r.costUsd === null ? 'not-observable (provider pricing not exposed)' : 'recorded',
          source: 'RenderJob row (executor-persisted latency/cost)',
        };
      }
    }
  }

  return {
    jobId: job.id,
    workload: job.kind,
    providerId: embeddedRouting?.providerId ?? LOCAL_EXECUTOR_PROVIDER_ID,
    routedVia: embeddedRouting?.routedVia ?? null,
    status: job.status,
    progress: job.progress,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    error: job.error,
    ...(embedded?.quote ? { quote: embedded.quote } : { quote: null }),
    ...(computeRecord?.quote ? { executionQuote: computeRecord.quote } : {}),
    observed,
    output: parsedOutput,
  };
}

/**
 * Cancel a compute job honestly.
 * - queued: effective cancellation (the core runner refuses non-queued jobs).
 * - running: durable cancel_requested event; execution may still complete
 *   (compatibility note — the core runner has no cooperative cancel seam and
 *   the z-ai SDK exposes no task-revocation API).
 * - terminal: idempotent no-op.
 */
export async function cancelCompute(jobId: string): Promise<void> {
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`not_found: job ${jobId}`);
  const terminal = ['succeeded', 'failed', 'cancelled', 'unavailable'];
  if (terminal.includes(job.status)) return;

  if (job.status === 'queued') {
    const updated = await db.job.updateMany({
      where: { id: jobId, status: 'queued' },
      data: { status: 'cancelled', finishedAt: new Date(), progress: 1 },
    });
    if (updated.count === 1) {
      // for render workloads, mark the RenderJob row too — execution truly
      // never happened; leaving it queued forever would be dishonest.
      const parsedInput = safeParse<Record<string, unknown>>(job.input, {});
      const renderJobId = typeof parsedInput.renderJobId === 'string' ? parsedInput.renderJobId : null;
      if (renderJobId) {
        await db.renderJob
          .update({
            where: { id: renderJobId },
            data: {
              status: 'cancelled',
              error: 'cancelled by compute broker before execution (queued-phase cancellation)',
              finishedAt: new Date(),
            },
          })
          .catch(() => undefined);
      }
      await emitEvent(job.tenantId, 'compute.cancelled', 'job', job.id, {
        jobId: job.id,
        workload: job.kind,
        note: 'cancelled while QUEUED — the core runner refuses non-queued jobs, so this cancellation is effective; provider execution never started',
      });
      return;
    }
    // raced into running between read and update — fall through honestly
  }

  await emitEvent(job.tenantId, 'compute.cancel_requested', 'job', job.id, {
    jobId: job.id,
    workload: job.kind,
    note: 'cancel requested while RUNNING — the core job runner (Worker A lane) exposes no cooperative cancellation seam and the z-ai SDK exposes no task-revocation API (W2.C compatibility note); execution may still complete and will record its real terminal state',
  });
}

function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ─── Provider registry + broker facade ──────────────────────────────────────

const providers: ComputeProvider[] = [];

/** Register a compute provider (informational for listProviders/capabilities). */
export function registerProvider(provider: ComputeProvider): void {
  providers.push(provider);
}

export function listProviders(): string[] {
  return providers.map((p) => String((p.capabilities() as { providerId?: string }).providerId ?? 'unknown'));
}

export function providerCapabilities(providerId?: string): unknown {
  const provider = providerId
    ? providers.find((p) => (p.capabilities() as { providerId?: string }).providerId === providerId)
    : providers[0];
  if (!provider) throw new Error(`not_found: compute provider "${providerId ?? 'first'}" is not registered`);
  return provider.capabilities();
}

/**
 * The Compute Broker facade (P6.C3): quote/submit route through
 * submitComputeRouted's enable-list routing + breaker admission + cost guard —
 * the production surface the renders API uses. status/cancel operate on the
 * durable Job row (provider-agnostic by construction).
 */
export const computeBroker = {
  registerProvider,
  listProviders,
  capabilities: providerCapabilities,
  quote: (req: ComputeRequest) =>
    submitComputeRoutedPreview(req).then((r) => r.quote),
  submit: (req: ComputeRequest) =>
    submitComputeRouted(asSubmission(req)).then((r) => r.jobId),
  status: (id: string) => providers[0]?.status(id) ?? Promise.reject(new Error('no compute provider registered')),
  cancel: (id: string) => providers[0]?.cancel(id) ?? Promise.reject(new Error('no compute provider registered')),
};

/** Quote-only preview through the routed path (no job created, no guard spend). */
async function submitComputeRoutedPreview(req: ComputeRequest): Promise<{ quote: ComputeQuote; providerId: ComputeProviderId }> {
  const workload = req.workload;
  if (!isBrokerWorkload(workload)) {
    throw new Error(
      `validation_failed: workload "${workload}" is not broker-routed in W2.C (routed: ${BROKER_WORKLOADS.join(', ')})`
    );
  }
  const { enabled, warnings } = parseComputeProviderList(currentEnv()[COMPUTE_PROVIDER_ENV]);
  for (const warning of warnings) {
    if (!loggedProviderListWarnings.has(warning)) {
      loggedProviderListWarnings.add(warning);
      console.warn(`[you:compute-broker] ${warning}`);
    }
  }
  const decision = routeCompute({
    workload,
    adapter: (req as ComputeSubmission).adapter,
    privacy: req.privacy,
    enabled,
    states: providerRuntimeStates(),
  });
  if (decision.providerId === null) {
    throw new ComputeRoutingRefusedError(decision.refusalReason ?? 'compute routing refused', decision.skipped);
  }
  const quote =
    decision.providerId === DASHSCOPE_RENDER_PROVIDER_ID ? await quoteComputeHosted(req) : await quoteCompute(req);
  return { quote, providerId: decision.providerId };
}

// The local executor is the FIRST provider (the W2.C default surface);
// P6.C3 registers the hosted DashScope render path as the SECOND provider.
registerProvider(new LocalExecutorProvider());
registerProvider(new DashScopeRenderProvider());
