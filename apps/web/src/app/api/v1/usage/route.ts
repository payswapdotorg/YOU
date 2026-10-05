// GET /api/v1/usage — UsageSummary: metrics list + totals
// (evidenceMb from evidence.bytes, jobs from job.*, llmCalls from llm.*,
// renders from the RenderJob rows — the durable truth).
//
// P6.C12 (PR-13) — the response gained two ADDITIVE sections (the existing
// metrics/totals shape is byte-compatible, existing consumers keep working):
//   cost          — the tenant's current cost-budget status (mode, source,
//                   budget, accrued, remaining, period) + per-pipeline and
//                   per-application accrual breakdowns + a 14-day
//                   usage-over-time series. Every number is the modeled-basis
//                   quoted-cost accrual (metric 'compute.quoted_usd') — the
//                   same conservative numbers the broker's budget guard
//                   refuses submits against.
//   optimizations — the P6.C12 optimization evidence records (before/after
//                   benchmark pairs with cited run-ids — pairs that don't
//                   exist yet render as honest empty states, never silence).
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute } from '@/lib/you/core/errors';
import type { UsageSummary } from '@/lib/you/contracts';
import type { CostUsageSection, OptimizationEvidenceView } from '@/lib/you/contracts';
import {
  BUDGET_ENV,
  BUDGET_METRIC,
  accrualSumUsd,
  applicationUsage,
  budgetConfigFromRow,
  parseEnvBudget,
  periodStartedAt,
  pipelineUsage,
  usageOverTime,
  type AccrualRow,
  type BudgetRow,
} from '@/lib/you/lab/cost-budgets';
import { pairOptimizationEvidence } from '@/lib/you/lab/optimization-evidence';

const USAGE_SERIES_DAYS = 14;

function unitFor(metric: string): string {
  if (metric === 'evidence.bytes') return 'bytes';
  if (metric.startsWith('llm.')) return 'calls';
  if (metric.startsWith('job.')) return 'jobs';
  if (metric.startsWith('compute.')) return 'usd';
  return 'count';
}

export async function GET(request: Request): Promise<Response> {
  // P6.C12: observed under the declared 'api.read' SLO (docs/COST_LATENCY.md).
  const observedRoute = (fn: () => Promise<Response>) => handleRoute(fn, { request, slo: 'api.read' });
  return observedRoute(async () => {
    const auth = await requireApiAuth(request);
    const tenantId = auth.tenantId;

    const groups = await db.usageRecord.groupBy({
      by: ['metric'],
      where: { tenantId },
      _sum: { quantity: true },
    });

    const metrics = groups.map((g) => ({
      metric: g.metric,
      quantity: g._sum.quantity ?? 0,
      unit: unitFor(g.metric),
    }));

    const evidenceBytes = metrics.find((m) => m.metric === 'evidence.bytes')?.quantity ?? 0;
    const jobs = metrics.filter((m) => m.metric.startsWith('job.')).reduce((acc, m) => acc + m.quantity, 0);
    const llmCalls = metrics.filter((m) => m.metric.startsWith('llm.')).reduce((acc, m) => acc + m.quantity, 0);
    const renders = await db.renderJob.count({ where: { tenantId } });

    // ── P6.C12: the cost-budget section (PR-13) ────────────────────────────
    // Budget resolution mirrors the broker's guard exactly: the most specific
    // db CostBudget row for (tenant, application actor, any workload) wins;
    // without rows the env ceiling (parseEnvBudget — unlimited is the explicit
    // opt-in there); without either the documented fail-closed default.
    // The usage view is tenant-wide, so the budget shown is the tenant-wide
    // configuration (applicationId null, pipeline null) — the per-application
    // and per-pipeline breakdowns below come from the accrual rows.
    const budgetRows: BudgetRow[] = await db.costBudget.findMany({
      where: { tenantId },
      select: { id: true, applicationId: true, pipeline: true, budgetUsd: true, periodHours: true, note: true, updatedAt: true },
    });
    // The usage view is tenant-wide: it shows the tenant-wide configuration a
    // human operator sees (applicationId null, pipeline null). The broker's
    // per-submit guard additionally picks application/pipeline-scoped rows —
    // the per-application and per-pipeline breakdowns below surface those
    // scopes from the accrual rows themselves.
    const tenantWideRow = budgetRows.find((r) => r.applicationId === null && r.pipeline === null) ?? null;
    const config = tenantWideRow !== null ? budgetConfigFromRow(tenantWideRow) : parseEnvBudget(process.env[BUDGET_ENV]);

    const now = new Date();
    const since = periodStartedAt(now, config.periodHours);
    const seriesSince = new Date(now.getTime() - USAGE_SERIES_DAYS * 24 * 60 * 60 * 1000);
    const accrualRowsRaw = await db.usageRecord.findMany({
      where: { tenantId, metric: BUDGET_METRIC, createdAt: { gte: seriesSince } },
      orderBy: { createdAt: 'asc' },
      select: { quantity: true, createdAt: true, meta: true },
    });
    const toAccrual = (row: { quantity: number; createdAt: Date; meta: string }): AccrualRow => {
      let workload: string | null = null;
      let applicationActorId: string | null = null;
      let jobId: string | null = null;
      try {
        const parsed = JSON.parse(row.meta) as Record<string, unknown>;
        workload = typeof parsed.workload === 'string' ? parsed.workload : null;
        applicationActorId = typeof parsed.applicationActorId === 'string' ? parsed.applicationActorId : null;
        jobId = typeof parsed.jobId === 'string' ? parsed.jobId : null;
      } catch {
        /* malformed meta stays null — honest, never guessed */
      }
      return { quantity: row.quantity, createdAt: row.createdAt, workload, applicationActorId, jobId };
    };
    const seriesRows = accrualRowsRaw.map(toAccrual);
    const periodRows = seriesRows.filter((r) => r.createdAt.getTime() >= since.getTime());
    const accruedUsd = accrualSumUsd(periodRows);
    const remainingUsd = config.mode === 'unlimited' ? null : Math.round(((config.budgetUsd ?? 0) - accruedUsd) * 100) / 100;

    const cost: CostUsageSection = {
      basis: 'modeled (quoted costs; observed provider pricing is not exposed to this sandbox)',
      budget: {
        mode: config.mode,
        source: config.source,
        budgetUsd: config.budgetUsd,
        periodHours: config.periodHours,
        periodStartedAt: since.toISOString(),
        accruedUsd,
        remainingUsd,
        note: config.note,
      },
      byPipeline: pipelineUsage(periodRows),
      byApplication: applicationUsage(periodRows),
      series: usageOverTime(seriesRows, USAGE_SERIES_DAYS),
      accrualMetric: BUDGET_METRIC,
    };

    // ── P6.C12: the optimization evidence records ──────────────────────────
    // Pairs of BenchmarkRuns (sequential vs parallel evaluation; cold vs warm
    // deterministic-subresult cache) with cited run-ids — every cited id is a
    // real row in the tenant's database (nothing invented; unpaired
    // optimizations carry an honest empty-state reason).
    const runRows = await db.benchmarkRun.findMany({
      orderBy: { createdAt: 'desc' },
      take: 40,
      select: { id: true, worldSeed: true, metrics: true, createdAt: true },
    });
    const optimizations: OptimizationEvidenceView[] = pairOptimizationEvidence(runRows);

    const summary: UsageSummary & { cost: CostUsageSection; optimizations: OptimizationEvidenceView[] } = {
      metrics: metrics.sort((a, b) => a.metric.localeCompare(b.metric)),
      totals: {
        evidenceMb: Math.round((evidenceBytes / (1024 * 1024)) * 1000) / 1000,
        jobs,
        renders,
        llmCalls,
      },
      cost,
      optimizations,
    };

    return Response.json(summary, { headers: { 'cache-control': 'no-store' } });
  });
}
