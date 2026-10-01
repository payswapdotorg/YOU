// GET /api/v1/twins/:id/versions — TwinVersionView[] (parsed HTIR documents)
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, notFound } from '@/lib/you/core/errors';
import { twinVersionView } from '@/lib/you/core/views';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const twin = await db.twin.findFirst({ where: { id, tenantId: auth.tenantId }, select: { id: true } });
    if (!twin) throw notFound(`twin "${id}" not found`);

    const versions = await db.twinVersion.findMany({
      where: { twinId: twin.id },
      orderBy: { version: 'desc' },
    });
    return Response.json(versions.map(twinVersionView));
  });
}
