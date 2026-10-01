// GET  /api/v1/webhooks — list endpoints
// POST /api/v1/webhooks — create (url validation — wave 1 accepts http too,
// events must be a non-empty array; secret generated and stored but NOT
// exposed: WebhookEndpointView has no secret field — contract gap noted for TL)
import { randomBytes } from 'crypto';
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { badRequest, handleRoute, readJsonBody, reqString, reqStringArray } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { webhookView } from '@/lib/you/core/views';

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const webhooks = await db.webhookEndpoint.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return Response.json(webhooks.map(webhookView));
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const body = await readJsonBody(request);

    const url = reqString(body, 'url', { max: 500 });
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw badRequest('url must be an absolute http(s) URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw badRequest('url protocol must be http or https');
    }

    const events = reqStringArray(body, 'events').map((e) => e.trim());
    if (events.some((e) => e.length > 100)) throw badRequest('event type names must be ≤100 chars');

    const secret = randomBytes(32).toString('hex');
    const webhook = await db.webhookEndpoint.create({
      data: {
        tenantId: auth.tenantId,
        url: parsed.toString(),
        secret,
        events: JSON.stringify(events),
        active: true,
      },
    });

    await audit(auth.tenantId, auth, 'webhook.created', 'webhook_endpoint', webhook.id, { url, events });
    await emitEvent(auth.tenantId, 'webhook.created', 'webhook_endpoint', webhook.id, { webhookId: webhook.id, url, events });

    return Response.json(webhookView(webhook), { status: 201 });
  });
}
