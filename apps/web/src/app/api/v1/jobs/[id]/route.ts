// GET /api/v1/jobs/:id — JobView (steps/output parsed; honest error text)
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, notFound } from '@/lib/you/core/errors';
import { jobView } from '@/lib/you/core/views';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const job = await db.job.findFirst({ where: { id, tenantId: auth.tenantId } });
    if (!job) throw notFound(`job "${id}" not found`);
    return Response.json(jobView(job));
  });
}
