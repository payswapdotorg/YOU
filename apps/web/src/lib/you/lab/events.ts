// ═══════════════════════════════════════════════════════════════════════════
// Honest bookkeeping helpers for job executors (Worker C lane).
//
// NOTE FOR TL / Worker A: Worker A's event emitter is not imported here (no
// cross-lane imports of in-progress code). Executors insert EventRecord and
// UsageRecord rows DIRECTLY with honest payloads. If Worker A's routes also
// emit equivalent events, deduplicate at integration time (task 3).
// ═══════════════════════════════════════════════════════════════════════════
import { db } from '@/lib/db';

export async function emitEvent(
  tenantId: string,
  type: string,
  entityType: string,
  entityId: string | null,
  payload: Record<string, unknown>
): Promise<void> {
  await db.eventRecord.create({
    data: {
      tenantId,
      type,
      entityType,
      entityId,
      payload: JSON.stringify(payload),
    },
  });
}

export async function recordUsage(
  tenantId: string,
  metric: string,
  quantity: number,
  meta: Record<string, unknown> = {}
): Promise<void> {
  await db.usageRecord.create({
    data: {
      tenantId,
      metric,
      quantity,
      meta: JSON.stringify(meta),
    },
  });
}

/** record N real provider calls at once */
export async function recordLlmCalls(
  tenantId: string,
  calls: number,
  meta: Record<string, unknown> = {}
): Promise<void> {
  if (calls <= 0) return;
  await recordUsage(tenantId, 'llm.calls', calls, meta);
}
