// ═══════════════════════════════════════════════════════════════════════════
// YOU core — events, audit trail, webhook fan-out, usage metering (Worker A)
// emitEvent inserts an EventRecord AND fans out WebhookDelivery rows for
// active endpoints subscribed to the type, then attempts actual delivery in
// the background (5s timeout per attempt).
//
// P6.A6 full — bounded delivery retries: each delivery runs through the
// shared retry helper (core/retry.ts) — network errors, 429 and 5xx retry
// with exponential backoff + jitter; the receiver's Retry-After is honored;
// 4xx (other) is permanent and never retried. Attempts are recorded on the
// WebhookDelivery row either way (honest counters, no fabrication).
//
// W4.A F-04: every delivery is SIGNED — receivers verify
//   X-You-Signature: sha256=HMAC-SHA256(secret, timestamp + "." + rawBody)
//   X-You-Timestamp: <unix-seconds>
// over the exact raw body bytes sent (see docs/API_CONTRACTS.md §Webhook
// deliveries). A fresh signature is computed per attempt.
// ═══════════════════════════════════════════════════════════════════════════
import { createHmac } from 'crypto';
import type { AuthContext } from './auth';
import { db } from '@/lib/db';
import { parseJson } from './views';
import { retry, type RetryOptions } from './retry';
import { incrCounter } from './metrics';

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

/** Webhook delivery retry knobs (see .env.example). */
export function webhookRetryEnvOptions(): Pick<RetryOptions, 'maxAttempts' | 'baseDelayMs' | 'maxDelayMs'> {
  const num = (name: string, d: number) => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return d;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return d; // fail-closed safe default
    return n;
  };
  return {
    maxAttempts: num('YOU_WEBHOOK_MAX_ATTEMPTS', 5),
    baseDelayMs: num('YOU_WEBHOOK_RETRY_BASE_DELAY_MS', 1_000),
    maxDelayMs: num('YOU_WEBHOOK_RETRY_MAX_DELAY_MS', 30_000),
  };
}

/** Receiver responded with a retryable status (429/5xx) — carries Retry-After when sent. */
class WebhookRetryableStatusError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  constructor(status: number, retryAfterMs: number | undefined) {
    super(`HTTP ${status}`);
    this.name = 'WebhookRetryableStatusError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
  return undefined; // HTTP-date form is out of scope (disclosed); seconds only
}

function webhookRetryDecision(err: unknown): boolean | { retry: boolean; retryAfterMs?: number } {
  if (err instanceof WebhookRetryableStatusError) {
    return { retry: true, ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}) };
  }
  if (err instanceof Error && /network|econn|timeout|timed out|etimedout|socket|fetch failed|aborted/i.test(err.message)) {
    return true;
  }
  return false;
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

      let attemptsMade = 0;
      let outcome: { status: 'delivered' | 'failed'; error?: string };
      try {
        const result = await retry(
          async (): Promise<{ ok: boolean; status: number }> => {
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
            if (res.ok) return { ok: true as const, status: res.status };
            const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
            if (res.status === 429 || res.status >= 500) {
              // retryable receiver state — bounded retries, Retry-After honored
              throw new WebhookRetryableStatusError(res.status, retryAfterMs);
            }
            // other 4xx: permanent — stop honestly (no retry)
            return { ok: false as const, status: res.status };
          },
          'webhook',
          {
            ...webhookRetryEnvOptions(),
            retryOn: webhookRetryDecision,
            onAttempt: (info) => {
              attemptsMade = info.attempt;
              if (info.attempt > 1) {
                incrCounter('retries');
                incrCounter('retry.webhook');
              }
            },
          },
        );
        if (result.ok) {
          incrCounter('webhook.delivered');
          outcome = { status: 'delivered' };
        } else {
          incrCounter('webhook.failed');
          outcome = { status: 'failed', error: `HTTP ${result.status} (permanent — not retried)` };
        }
      } catch (err) {
        incrCounter('webhook.failed');
        incrCounter('retries.exhausted');
        incrCounter('retry.exhausted.webhook');
        outcome = { status: 'failed', error: err instanceof Error ? err.message : String(err) };
      }

      await db.webhookDelivery.update({
        where: { id },
        data: {
          status: outcome.status,
          attempts: { increment: Math.max(1, attemptsMade) },
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
