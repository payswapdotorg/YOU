// POST /api/v1/maintenance/gc-storage — kick the durable storage-GC job (P6.A4).
//
// Sweeps content-addressed objects that no EvidenceAsset row references
// (twin deletion cascades rows, not bytes — keys may be shared, so the
// sweep is reference-driven, never per-twin). Idempotent per
// YOU_GC_IDEMPOTENCY window when the caller supplies a key.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { createJob } from '@/lib/you/core/jobs';
import { forbidden, getIdempotencyKey, handleRoute } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    if (auth.actorType !== 'user') {
      // maintenance is an operator action — session auth only, never API keys
      throw forbidden('maintenance jobs require an operator session (api keys are not permitted)');
    }

    const job = await createJob(
      auth.tenantId,
      'maintenance.gc-storage',
      {},
      getIdempotencyKey(request),
    );

    await audit(auth.tenantId, auth, 'maintenance.gc_storage', 'job', job.id, {});
    await emitEvent(auth.tenantId, 'maintenance.gc_storage', 'job', job.id, { jobId: job.id });

    return Response.json({ jobId: job.id }, { status: 202 });
  });
}
