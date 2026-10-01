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

export const BROKER_WORKLOADS = ['render.image', 'render.video', 'twin.compile'] as const;
export type BrokerWorkload = (typeof BROKER_WORKLOADS)[number];

const WORKLOAD_JOB_KIND: Record<BrokerWorkload, JobKind> = {
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
const DEFAULT_ADAPTER: Record<BrokerWorkload, string> = {
  'render.image': 'svg-portrait-1',
  'render.video': 'ai-video-1',
  'twin.compile': 'vlm-recon-1',
};

const MODELED_COST_USD: Record<string, number> = {
  'render.image:svg-portrait-1': 0,
  'render.image:ai-image-1': 0.04, // mirrors the adapter meta modeled estimate
  'render.video:ai-video-1': 0.1, // mirrors the adapter meta modeled estimate
  'twin.compile:vlm-recon-1': 0.02, // $0.01/invocation × estimated 2 invocations
};

const MODELED_LATENCY_MS: Record<string, number> = {
  'render.image:svg-portrait-1': 200,
  'render.image:ai-image-1': 45_000,
  'render.video:ai-video-1': 260_000,
  'twin.compile:vlm-recon-1': 15_000,
};

const PROVIDER_ADAPTERS = new Set(['ai-image-1', 'ai-video-1', 'vlm-recon-1']);

function resolveAdapter(workload: BrokerWorkload, adapter: string | undefined): string {
  return adapter && adapter.length > 0 ? adapter : DEFAULT_ADAPTER[workload];
}

function costFor(workload: BrokerWorkload, adapter: string | undefined): { usd: number; basis: CostBasis; note: string } {
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
    note: 'modeled estimate — the z-ai provider does not expose pricing to this sandbox; MUST be replaced with a measured cost before any promotion gate',
  };
}

function isBrokerWorkload(workload: string): workload is BrokerWorkload {
  return (BROKER_WORKLOADS as readonly string[]).includes(workload);
}

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
  workload: BrokerWorkload,
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
  observed?: {
    latencyMs: number | null;
    costUsd: number | null;
    costBasis: string | null;
    source: string;
  } | null;
  output?: Record<string, unknown> | null;
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

  const parsedInput = safeParse<Record<string, unknown>>(job.input, {});
  const embedded = (parsedInput.__compute ?? null) as { quote?: ComputeQuote; quotePhase?: string } | null;
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
    providerId: LOCAL_EXECUTOR_PROVIDER_ID,
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

/** Register a compute provider. Registration order = routing order (first match wins). */
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

/** The Compute Broker facade — routes to the first registered provider. */
export const computeBroker = {
  registerProvider,
  listProviders,
  capabilities: providerCapabilities,
  quote: (req: ComputeRequest) => providers[0]?.quote(req) ?? Promise.reject(new Error('no compute provider registered')),
  submit: (req: ComputeRequest) => providers[0]?.submit(req) ?? Promise.reject(new Error('no compute provider registered')),
  status: (id: string) => providers[0]?.status(id) ?? Promise.reject(new Error('no compute provider registered')),
  cancel: (id: string) => providers[0]?.cancel(id) ?? Promise.reject(new Error('no compute provider registered')),
};

// The local executor is the FIRST provider (registration order is routing order).
registerProvider(new LocalExecutorProvider());
