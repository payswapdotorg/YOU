// GET /api/v1/lab/runs/:id — BenchmarkRunView (organizations/metrics/reports parsed)
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, notFound } from '@/lib/you/core/errors';
import { benchmarkRunView } from '@/lib/you/core/views';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    await requireApiAuth(request);
    const { id } = await params;

    const run = await db.benchmarkRun.findUnique({
      where: { id },
      include: { reports: { orderBy: { createdAt: 'asc' } } },
    });
    if (!run) throw notFound(`benchmark run "${id}" not found`);

    // objectiveCode comes from the LabObjective row (no FK relation —
    // BenchmarkRun stores objectiveId as a plain reference)
    const objective = await db.labObjective.findUnique({ where: { id: run.objectiveId } });

    return Response.json(benchmarkRunView({ ...run, objective }, run.reports));
  });
}
