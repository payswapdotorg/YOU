// GET /api/v1/captures/:id — capture session detail with assets
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, notFound } from '@/lib/you/core/errors';
import { captureSessionView } from '@/lib/you/core/views';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const session = await db.captureSession.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { assets: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) throw notFound(`capture session "${id}" not found`);
    return Response.json(captureSessionView(session, session.assets));
  });
}
