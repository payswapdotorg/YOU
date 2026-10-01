// GET /api/v1/evidence/:id/url — signed, expiring URL for raw evidence.
// SESSION AUTH ONLY (raw biometric evidence is never exposed to API keys
// without an explicit policy decision — wave 1 restriction).
import { db } from '@/lib/db';
import { requireSession } from '@/lib/you/core/auth';
import { handleRoute, notFound } from '@/lib/you/core/errors';
import { STORAGE_DEFAULT_TTL_SECONDS, signStorageUrl } from '@/lib/you/core/storage';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireSession(request);
    const { id } = await params;

    const asset = await db.evidenceAsset.findFirst({ where: { id, tenantId: auth.tenantId } });
    if (!asset) throw notFound(`evidence asset "${id}" not found`);

    const url = signStorageUrl(asset.storageKey, STORAGE_DEFAULT_TTL_SECONDS);
    const expiresAt = new Date(Date.now() + STORAGE_DEFAULT_TTL_SECONDS * 1000).toISOString();
    return Response.json({ url, expiresAt });
  });
}
