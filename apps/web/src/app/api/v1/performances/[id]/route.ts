// GET /api/v1/performances/:id — performance with parsed tracks
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, notFound } from '@/lib/you/core/errors';
import { performanceView } from '@/lib/you/core/views';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const performance = await db.performance.findFirst({ where: { id, tenantId: auth.tenantId } });
    if (!performance) throw notFound(`performance "${id}" not found`);
    return Response.json(performanceView(performance));
  });
}
