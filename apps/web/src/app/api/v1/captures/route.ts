// GET /api/v1/captures — capture sessions (newest first, assets included)
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute } from '@/lib/you/core/errors';
import { captureSessionView } from '@/lib/you/core/views';

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const sessions = await db.captureSession.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'desc' },
      include: { assets: { orderBy: { createdAt: 'asc' } } },
    });
    return Response.json(sessions.map((s) => captureSessionView(s, s.assets)));
  });
}
