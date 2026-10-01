// DELETE /api/v1/webhooks/:id — remove endpoint (+ its delivery rows)
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, notFound } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;

    const webhook = await db.webhookEndpoint.findFirst({ where: { id, tenantId: auth.tenantId } });
    if (!webhook) throw notFound(`webhook endpoint "${id}" not found`);

    await audit(auth.tenantId, auth, 'webhook.deleted', 'webhook_endpoint', webhook.id, {
      url: webhook.url,
      events: JSON.parse(webhook.events),
    });

    await db.webhookDelivery.deleteMany({ where: { endpointId: webhook.id } });
    await db.webhookEndpoint.delete({ where: { id: webhook.id } });

    await emitEvent(auth.tenantId, 'webhook.deleted', 'webhook_endpoint', webhook.id, {
      webhookId: webhook.id,
      url: webhook.url,
    });

    return new Response(null, { status: 204 });
  });
}
