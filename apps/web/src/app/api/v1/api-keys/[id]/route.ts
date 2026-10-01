// DELETE /api/v1/api-keys/:id — revoke (set revokedAt, never delete rows)
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, notFound } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { apiKeyView } from '@/lib/you/core/views';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;

    const key = await db.apiKey.findFirst({ where: { id, tenantId: auth.tenantId } });
    if (!key) throw notFound(`api key "${id}" not found`);

    if (!key.revokedAt) {
      const revokedAt = new Date();
      await db.apiKey.update({ where: { id: key.id }, data: { revokedAt } });
      await audit(auth.tenantId, auth, 'key.revoked', 'api_key', key.id, { name: key.name });
      await emitEvent(auth.tenantId, 'key.revoked', 'api_key', key.id, { keyId: key.id, name: key.name });
    }

    const fresh = await db.apiKey.findUniqueOrThrow({ where: { id: key.id } });
    return Response.json(apiKeyView(fresh));
  });
}
