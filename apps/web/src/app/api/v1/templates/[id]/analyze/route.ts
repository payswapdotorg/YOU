// POST /api/v1/templates/:id/analyze — async durable template.analyze job
// (§API rules: asynchronous work returns a durable job ID immediately).
// The job computes deterministic coverage analysis (which capabilities the
// template exercises, which are left to targeted evidence) and persists it on
// the Template row. Idempotency-Key is body-fingerprint bound (W4.A F-01):
// the Job row persists its `input`, so a same-key replay with a different
// derived input (e.g. a different template id) is a 409 idempotency_conflict;
// the same input dedupes to the SAME durable job.
// Importing the templates module registers the template.analyze executor
// through the frozen registerExecutor seam before any job can run.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { getIdempotencyKey, handleRoute, notFound, readJsonBody } from '@/lib/you/core/errors';
import { emitEvent } from '@/lib/you/core/events';
import { assertSameBodyFingerprint } from '@/lib/you/core/idempotency';
import { createJob } from '@/lib/you/core/jobs';
import { TEMPLATE_ANALYZE_JOB_KIND } from '@/lib/you/core/templates';
import { parseJson } from '@/lib/you/core/views';

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

    const idempotencyKey = getIdempotencyKey(request);
    const analyzeInput = { templateId: template.id };
    const job = await createJob(auth.tenantId, TEMPLATE_ANALYZE_JOB_KIND, analyzeInput, idempotencyKey);
    // F-01: on a key replay createJob returns the stored job — its persisted
    // input must match this request's derived input or the replay conflicts
    if (idempotencyKey) {
      assertSameBodyFingerprint(
        idempotencyKey,
        'template.analyze job input',
        parseJson<Record<string, unknown>>(job.input, {}),
        analyzeInput,
      );
    }

    await emitEvent(auth.tenantId, 'template.analyze.queued', 'template', template.id, {
      templateId: template.id,
      jobId: job.id,
      templateVersion: template.version,
    });

    return Response.json({ jobId: job.id }, { status: 202 });
  });
}
