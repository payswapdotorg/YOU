// POST /api/v1/twins/:id/compile — durable twin.compile job (Idempotency-Key
// aware, body-fingerprint bound per W4.A F-01: the Job row persists its
// `input`, so a same-key replay with a different derived input — different
// style/captureSession — is a 409 idempotency_conflict, never a silent
// return of the existing job for a different payload).
// Consent scope "reconstruct" is server-enforced for the twin's subjectId.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { requireConsent } from '@/lib/you/core/consent';
import { handleRoute, notFound, readJsonBody, badRequest, getIdempotencyKey, serviceUnavailable } from '@/lib/you/core/errors';
import { assertProviderAvailable, ProviderUnavailableError } from '@/lib/you/core/circuit-breaker';
import { assertSameBodyFingerprint } from '@/lib/you/core/idempotency';
import { createJob } from '@/lib/you/core/jobs';
import { parseJson } from '@/lib/you/core/views';
import { reconProvider } from '@/lib/you/ai/recon-provider';
import type { RenderStyle } from '@/lib/you/contracts';

const RENDER_STYLES: RenderStyle[] = [
  'photorealistic', 'anime', 'cartoon', 'low-poly', 'game', 'illustration', 'stylized-portrait',
];

/**
 * P6.A6-FULL — graceful degraded state: reconstruction needs an external
 * vision provider; when that provider's circuit breaker is OPEN the route
 * returns an honest 503 (service_unavailable + Retry-After + guidance)
 * instead of accepting a job that would burn its retry budget and die. No
 * spin, no hang — the refusal is immediate.
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

    // degraded-state gate BEFORE any work: refuse honestly while the vision
    // provider is down rather than enqueueing work that cannot run
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

    const body = await readJsonBody(request);

    const twin = await db.twin.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { captureSessions: { select: { id: true } } },
    });
    if (!twin) throw notFound(`twin "${id}" not found`);

    // server-enforced consent: reconstruction requires the reconstruct scope
    const grant = await requireConsent(auth.tenantId, twin.subjectId, 'reconstruct');

    let captureSessionId: string | undefined;
    if (body.captureSessionId !== undefined && body.captureSessionId !== null) {
      if (typeof body.captureSessionId !== 'string') throw badRequest('captureSessionId must be a string');
      if (!twin.captureSessions.some((c) => c.id === body.captureSessionId)) {
        throw notFound(`capture session "${body.captureSessionId}" not found for this twin`);
      }
      captureSessionId = body.captureSessionId;
    }

    let style: RenderStyle | undefined;
    if (body.style !== undefined && body.style !== null) {
      if (typeof body.style !== 'string' || !RENDER_STYLES.includes(body.style as RenderStyle)) {
        throw badRequest(`style must be one of: ${RENDER_STYLES.join(', ')}`);
      }
      style = body.style as RenderStyle;
    }

    const idempotencyKey = getIdempotencyKey(request);
    const compileInput = {
      twinId: twin.id,
      subjectId: twin.subjectId,
      captureSessionId: captureSessionId ?? null,
      style: style ?? null,
      consentGrantId: grant.id,
    };
    const job = await createJob(auth.tenantId, 'twin.compile', compileInput, idempotencyKey);
    // F-01: on a key replay createJob returns the stored job — its persisted
    // input must match this request's derived input or the replay conflicts
    if (idempotencyKey) {
      assertSameBodyFingerprint(
        idempotencyKey,
        'twin.compile job input',
        parseJson<Record<string, unknown>>(job.input, {}),
        compileInput,
      );
    }

    return Response.json({ jobId: job.id }, { status: 202 });
  });
}
