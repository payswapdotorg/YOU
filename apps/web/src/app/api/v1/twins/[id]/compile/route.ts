// POST /api/v1/twins/:id/compile — durable twin.compile job (Idempotency-Key
// aware, body-fingerprint bound per W4.A F-01: the Job row persists its
// `input`, so a same-key replay with a different derived input — different
// style/captureSession — is a 409 idempotency_conflict, never a silent
// return of the existing job for a different payload).
// Consent scope "reconstruct" is server-enforced for the twin's subjectId.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { requireConsent } from '@/lib/you/core/consent';
import { handleRoute, notFound, readJsonBody, badRequest, getIdempotencyKey } from '@/lib/you/core/errors';
import { assertProviderAvailable } from '@/lib/you/core/resilience';
import { assertSameBodyFingerprint } from '@/lib/you/core/idempotency';
import { createJob } from '@/lib/you/core/jobs';
import { parseJson } from '@/lib/you/core/views';
import { reconProviderName } from '@/lib/you/ai/recon-provider';
import type { RenderStyle } from '@/lib/you/contracts';

const RENDER_STYLES: RenderStyle[] = [
  'photorealistic', 'anime', 'cartoon', 'low-poly', 'game', 'illustration', 'stylized-portrait',
];

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const body = await readJsonBody(request);

    const twin = await db.twin.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { captureSessions: { select: { id: true } } },
    });
    if (!twin) throw notFound(`twin "${id}" not found`);

    // server-enforced consent: reconstruction requires the reconstruct scope
    const grant = await requireConsent(auth.tenantId, twin.subjectId, 'reconstruct');

    // P6.A6 graceful degraded state (the reconstruction-executor path): when
    // the recon provider's circuit breaker is open, refuse FAST with an
    // honest 503 + retry guidance — no queued job that hangs against a down
    // provider, no spin. peek()-based: it never consumes the half-open probe.
    assertProviderAvailable(reconProviderName());

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
