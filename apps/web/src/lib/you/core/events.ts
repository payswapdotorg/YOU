// ═══════════════════════════════════════════════════════════════════════════
// YOU core — events, audit trail, webhook fan-out, usage metering (Worker A)
// emitEvent inserts an EventRecord AND fans out WebhookDelivery rows for
// active endpoints subscribed to the type, then attempts actual delivery in
// the background (5s timeout; wave-1 records attempts honestly, no retry
// scheduler). audit() writes the immutable AuditEvent compliance trail.
//
// W4.A F-04: every delivery is SIGNED — receivers verify
//   X-You-Signature: sha256=HMAC-SHA256(secret, timestamp + "." + rawBody)
//   X-You-Timestamp: <unix-seconds>
// over the exact raw body bytes sent (see docs/API_CONTRACTS.md §Webhook
// deliveries). The no-retry-scheduler limitation is unchanged (documented).
// ═══════════════════════════════════════════════════════════════════════════
import { createHmac } from 'crypto';
import type { AuthContext } from './auth';
import { db } from '@/lib/db';
import { parseJson } from './views';

export type ActorType = 'user' | 'application' | 'system' | 'job';

export async function emitEvent(
  tenantId: string,
  type: string,
  entityType: string,
  entityId: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  try {
    const event = await db.eventRecord.create({
      data: {
        tenantId,
        type,
        entityType,
        entityId,
        payload: JSON.stringify(payload),
      },
    });

    const endpoints = await db.webhookEndpoint.findMany({ where: { tenantId, active: true } });
    const matching = endpoints.filter((e) => {
      const subscribed = parseJson<string[]>(e.events, []);
      return subscribed.includes(type) || subscribed.includes('*');
    });
    if (matching.length === 0) return;

    const deliveries = await Promise.all(
      matching.map((endpoint) =>
        db.webhookDelivery.create({
          data: { endpointId: endpoint.id, eventId: event.id, status: 'pending' },
        }),
      ),
    );

    // background delivery attempts — never block the API path
    void deliverPending(deliveries.map((d) => d.id)).catch(() => undefined);
  } catch (err) {
    // events must never break the primary write path; surface in logs only
    console.error(`[you/events] emitEvent(${type}) failed:`, err instanceof Error ? err.message : err);
  }
}

/** F-04: sign `timestamp + "." + rawBody` with the endpoint's stored secret. */
export function webhookSignature(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
}

async function deliverPending(deliveryIds: string[]): Promise<void> {
  for (const id of deliveryIds) {
    try {
      const delivery = await db.webhookDelivery.findUnique({
        where: { id },
        include: { endpoint: true, event: true },
      });
      if (!delivery || !delivery.endpoint.active) continue;

      const body = JSON.stringify({
        id: delivery.event.id,
        type: delivery.event.type,
        entityType: delivery.event.entityType,
        entityId: delivery.event.entityId,
        payload: parseJson<Record<string, unknown>>(delivery.event.payload, {}),
        createdAt: delivery.event.createdAt.toISOString(),
      });

      let outcome: { status: 'delivered' | 'failed'; error?: string };
      try {
        // F-04: signed delivery — signature over timestamp + '.' + raw body
        // with the endpoint's stored secret (WebhookEndpoint.secret, never
        // exposed by the API; receivers read it from their registration flow)
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = webhookSignature(delivery.endpoint.secret, timestamp, body);
        const res = await fetch(delivery.endpoint.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'you-webhooks/1',
            'x-you-timestamp': timestamp,
            'x-you-signature': `sha256=${signature}`,
          },
          body,
          signal: AbortSignal.timeout(5000),
        });
        outcome = res.ok
          ? { status: 'delivered' }
          : { status: 'failed', error: `HTTP ${res.status}` };
      } catch (err) {
        outcome = { status: 'failed', error: err instanceof Error ? err.message : String(err) };
      }

      await db.webhookDelivery.update({
        where: { id },
        data: {
          status: outcome.status,
          attempts: { increment: 1 },
          lastError: outcome.error ?? null,
        },
      });
    } catch (err) {
      console.error(`[you/events] delivery ${id} recording failed:`, err instanceof Error ? err.message : err);
    }
  }
}

/** Immutable compliance trail (AuditEvent table). Never throws. */
export async function audit(
  tenantId: string,
  actor: Pick<AuthContext, 'actorType' | 'actorId'> | { actorType: ActorType; actorId?: string | null },
  action: string,
  entityType: string,
  entityId: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db.auditEvent.create({
      data: {
        tenantId,
        actorType: actor.actorType,
        actorId: actor.actorId ?? null,
        action,
        entityType,
        entityId,
        payload: JSON.stringify(payload),
      },
    });
  } catch (err) {
    console.error(`[you/audit] ${action} failed:`, err instanceof Error ? err.message : err);
  }
}

export async function recordUsage(
  tenantId: string,
  metric: string,
  quantity: number,
  meta: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db.usageRecord.create({
      data: { tenantId, metric, quantity, meta: JSON.stringify(meta) },
    });
  } catch (err) {
    console.error(`[you/usage] recordUsage(${metric}) failed:`, err instanceof Error ? err.message : err);
  }
}
