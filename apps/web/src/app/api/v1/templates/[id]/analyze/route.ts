// POST /api/v1/templates/:id/analyze — async durable template.analyze job
// (§API rules: asynchronous work returns a durable job ID immediately).
// The job computes deterministic coverage analysis (which capabilities the
// template exercises, which are left to targeted evidence) and persists it on
// the Template row. Supports Idempotency-Key via the Job dedupe mechanism.
// Importing the templates module registers the template.analyze executor
// through the frozen registerExecutor seam before any job can run.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { getIdempotencyKey, handleRoute, notFound, readJsonBody } from '@/lib/you/core/errors';
import { emitEvent } from '@/lib/you/core/events';
import { createJob } from '@/lib/you/core/jobs';
import { TEMPLATE_ANALYZE_JOB_KIND } from '@/lib/you/core/templates';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    await readJsonBody(request); // accepts {} / empty body

    const template = await db.template.findFirst({ where: { id, tenantId: auth.tenantId } });
    if (!template) throw notFound(`template "${id}" not found`);

    const job = await createJob(
      auth.tenantId,
      TEMPLATE_ANALYZE_JOB_KIND,
      { templateId: template.id },
      getIdempotencyKey(request),
    );

    await emitEvent(auth.tenantId, 'template.analyze.queued', 'template', template.id, {
      templateId: template.id,
      jobId: job.id,
      templateVersion: template.version,
    });

    return Response.json({ jobId: job.id }, { status: 202 });
  });
}
