// POST /api/v1/captures/:id/reconstruct — P6.C4: kick the durable
// f1.reconstruct job (real-human F1 reconstruction, the reconstruction side
// of docs/F1_OPERATOR_CAPTURE.md). Idempotency-Key aware with the W4.A F-01
// body-fingerprint law (same key + different derived input → 409, never a
// silent replay for a different payload).
//
// Consent scope "reconstruct" is server-enforced HERE for the twin's subject
// (403 consent_required envelope) and re-enforced inside the pipeline before
// any evidence byte is loaded — consent gates both layers, fail-closed.
// The session must be COMPLETE (capture.quality done): reconstructing from an
// unfinished evidence set is refused with an honest 400.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { requireConsent } from '@/lib/you/core/consent';
import {
  handleRoute,
  notFound,
  badRequest,
  readJsonBody,
  getIdempotencyKey,
  serviceUnavailable,
} from '@/lib/you/core/errors';
import { assertProviderAvailable, ProviderUnavailableError } from '@/lib/you/core/circuit-breaker';
import { assertSameBodyFingerprint } from '@/lib/you/core/idempotency';
import { createJob } from '@/lib/you/core/jobs';
import { parseJson } from '@/lib/you/core/views';
import { reconProvider } from '@/lib/you/ai/recon-provider';
import { F1_RECONSTRUCT_JOB_KIND } from '@/lib/you/lab/f1-recon';
import type { RenderStyle } from '@/lib/you/contracts';

const RENDER_STYLES: RenderStyle[] = [
  'photorealistic', 'anime', 'cartoon', 'low-poly', 'game', 'illustration', 'stylized-portrait',
];

/**
 * P6.A6-FULL — graceful degraded state (same law as the compile route): the
 * F1 reconstruction pipeline needs the vision provider; when its circuit
 * breaker is OPEN the route refuses honestly (503 + Retry-After + guidance)
 * instead of enqueueing a job that would burn its retry budget and die.
 */
function reconBreakerName(): 'zai' | 'openrouter' {
  return reconProvider() === 'openrouter' ? 'openrouter' : 'zai';
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;

    // degraded-state gate BEFORE any work (never enqueue unrunnable jobs)
    try {
      assertProviderAvailable(reconBreakerName());
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        const retryAfterSeconds = Math.max(1, Math.ceil(err.retryAfterMs / 1000));
        throw serviceUnavailable(
          `reconstruction provider "${err.provider}" is temporarily unavailable (circuit breaker open) — please retry in ~${retryAfterSeconds}s; already-queued jobs are unaffected`,
          {
            provider: err.provider,
            breakerState: err.breakerState,
            retryAfterSeconds,
            guidance:
              'this request was not enqueued; retry after the suggested delay. Operators: GET /api/v1/metrics, POST /api/v1/maintenance/provider-breaker to inspect/reset.',
          },
          { 'retry-after': String(retryAfterSeconds), 'cache-control': 'no-store' },
        );
      }
      // unknown provider env (reconProvider() fail-closed throw) — honest 503
      throw serviceUnavailable(
        `reconstruction is not available: ${err instanceof Error ? err.message : String(err)}`,
        { provider: 'unknown', breakerState: 'closed', guidance: 'fix the provider configuration and retry' },
      );
    }

    const session = await db.captureSession.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { twin: true, assets: { select: { id: true } } },
    });
    if (!session) throw notFound(`capture session "${id}" not found`);

    // server-enforced consent for the twin's subject (scope: reconstruct)
    const grant = await requireConsent(auth.tenantId, session.twin.subjectId, 'reconstruct');

    if (session.status !== 'complete') {
      throw badRequest(
        `capture session "${session.id}" status is "${session.status}" — F1 reconstruction requires a COMPLETE session (POST /api/v1/captures/${session.id}/complete first, which runs capture.quality; refusing to reconstruct from an unfinished evidence set)`,
        { captureSessionId: session.id, status: session.status, requiredStatus: 'complete' },
      );
    }
    if (session.assets.length === 0) {
      throw badRequest(
        `capture session "${session.id}" has no evidence assets — nothing to reconstruct (refusing to fabricate an F1 report)`,
        { captureSessionId: session.id, assets: 0 },
      );
    }

    let style: RenderStyle | undefined;
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const body = await readJsonBody(request);
      if (body.style !== undefined && body.style !== null) {
        if (typeof body.style !== 'string' || !RENDER_STYLES.includes(body.style as RenderStyle)) {
          throw badRequest(`style must be one of: ${RENDER_STYLES.join(', ')}`);
        }
        style = body.style as RenderStyle;
      }
    }

    const idempotencyKey = getIdempotencyKey(request);
    const reconInput = {
      captureSessionId: session.id,
      twinId: session.twinId,
      subjectId: session.twin.subjectId,
      consentGrantId: grant.id,
      style: style ?? null,
    };
    const job = await createJob(auth.tenantId, F1_RECONSTRUCT_JOB_KIND, reconInput, idempotencyKey);
    // F-01: on a key replay createJob returns the stored job — its persisted
    // input must match this request's derived input or the replay conflicts
    if (idempotencyKey) {
      assertSameBodyFingerprint(
        idempotencyKey,
        'f1.reconstruct job input',
        parseJson<Record<string, unknown>>(job.input, {}),
        reconInput,
      );
    }

    return Response.json({ jobId: job.id }, { status: 202 });
  });
}
