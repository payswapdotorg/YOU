// GET /api/v1/usage — UsageSummary: metrics list + totals
// (evidenceMb from evidence.bytes, jobs from job.*, llmCalls from llm.*,
// renders from the RenderJob rows — the durable truth).
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute } from '@/lib/you/core/errors';
import type { UsageSummary } from '@/lib/you/contracts';

function unitFor(metric: string): string {
  if (metric === 'evidence.bytes') return 'bytes';
  if (metric.startsWith('llm.')) return 'calls';
  if (metric.startsWith('job.')) return 'jobs';
  return 'count';
}

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
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

    const summary: UsageSummary = {
      metrics: metrics.sort((a, b) => a.metric.localeCompare(b.metric)),
      totals: {
        evidenceMb: Math.round((evidenceBytes / (1024 * 1024)) * 1000) / 1000,
        jobs,
        renders,
        llmCalls,
      },
    };

    return Response.json(summary);
  });
}
