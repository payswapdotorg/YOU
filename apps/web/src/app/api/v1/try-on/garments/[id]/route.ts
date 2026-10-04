// GET /api/v1/try-on/garments/:id — garment asset detail with a signed,
// expiring URL for the content-addressed product image (P6.C8).
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, notFound } from '@/lib/you/core/errors';
import { garmentAssetView } from '@/lib/you/tryon/views';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const garment = await db.garmentAsset.findFirst({
      where: { id, tenantId: auth.tenantId },
    });
    if (!garment) throw notFound(`garment asset "${id}" not found`);
    return Response.json(garmentAssetView(garment));
  });
}
