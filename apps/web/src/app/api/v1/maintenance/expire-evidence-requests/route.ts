// POST /api/v1/maintenance/expire-evidence-requests — expire open evidence
// requests past the configurable TTL (P6.B5).
//
// OPERATOR SESSION ONLY (same law as gc-storage / dead-jobs: api keys are
// refused). Honest status transition, NO silent deletion: each expired
// request stays in the list with status 'expired' and emits an
// evidence.request.expired event; the audit trail records the sweep.
//
// TTL: YOU_EVIDENCE_REQUEST_TTL_DAYS (default 30) measured from createdAt.
//
// ACTIVE-FULFILLMENT GRACE: a request whose linked guided capture session is
// still ACTIVE (pending/uploading/analyzing) is NOT expired underneath the
// operator — it is counted as skippedActiveFulfillments in the response and
// stays open (the completion path flips it to fulfilled; a failing session
// releases it for re-fulfillment or a later sweep). Requests with a FAILED
// linked session, or no linked session, DO expire: the window passed.
//
// Follows the dead-jobs purge precedent: operator-initiated sweep, no
// background scheduler in this wave (a scheduled adoption is future work,
// disclosed).
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { forbidden, handleRoute } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';

const DEFAULT_EVIDENCE_REQUEST_TTL_DAYS = 30;

/** TTL days from YOU_EVIDENCE_REQUEST_TTL_DAYS (read per call; default 30). */
export function evidenceRequestTtlDays(): number {
  const n = Number(process.env.YOU_EVIDENCE_REQUEST_TTL_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_EVIDENCE_REQUEST_TTL_DAYS;
}

const ACTIVE_SESSION_STATUSES = ['pending', 'uploading', 'analyzing'];

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    if (auth.actorType !== 'user') {
      // maintenance is an operator action — session auth only, never API keys
      throw forbidden('evidence-request expiry requires an operator session (api keys are not permitted)');
    }

    const ttlDays = evidenceRequestTtlDays();
    const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);

    const stale = await db.evidenceRequest.findMany({
      where: { tenantId: auth.tenantId, status: 'open', createdAt: { lt: cutoff } },
      orderBy: { createdAt: 'asc' },
    });

    const expired: typeof stale = [];
    const skippedActive: typeof stale = [];
    for (const req of stale) {
      if (!req.captureSessionId) {
        expired.push(req);
        continue;
      }
      const linked = await db.captureSession.findFirst({
        where: { id: req.captureSessionId, tenantId: auth.tenantId },
      });
      if (linked && ACTIVE_SESSION_STATUSES.includes(linked.status)) {
        skippedActive.push(req);
        continue; // grace: never expire a request mid-fulfillment
      }
      expired.push(req); // unlinked or the attempt already failed
    }

    for (const req of expired) {
      await db.evidenceRequest.update({
        where: { id: req.id },
        data: { status: 'expired' },
      });
      await emitEvent(auth.tenantId, 'evidence.request.expired', 'evidence_request', req.id, {
        requestId: req.id,
        capability: req.capability,
        createdAt: req.createdAt.toISOString(),
        ttlDays,
        cutoff: cutoff.toISOString(),
        linkedCaptureSessionId: req.captureSessionId,
      });
    }

    await audit(auth.tenantId, auth, 'maintenance.expire_evidence_requests', 'evidence_request', null, {
      ttlDays,
      cutoff: cutoff.toISOString(),
      considered: stale.length,
      expired: expired.length,
      skippedActiveFulfillments: skippedActive.length,
    });

    return Response.json({
      expired: expired.length,
      skippedActiveFulfillments: skippedActive.length,
      considered: stale.length,
      ttlDays,
      cutoff: cutoff.toISOString(),
    });
  });
}
