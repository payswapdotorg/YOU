// POST /api/v1/twins/:id/compile — durable twin.compile job (Idempotency-Key aware)
// Consent scope "reconstruct" is server-enforced for the twin's subjectId.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { requireConsent } from '@/lib/you/core/consent';
import { handleRoute, notFound, readJsonBody, badRequest, getIdempotencyKey } from '@/lib/you/core/errors';
import { createJob } from '@/lib/you/core/jobs';
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
    const job = await createJob(
      auth.tenantId,
      'twin.compile',
      {
        twinId: twin.id,
        subjectId: twin.subjectId,
        captureSessionId: captureSessionId ?? null,
        style: style ?? null,
        consentGrantId: grant.id,
      },
      idempotencyKey,
    );

    return Response.json({ jobId: job.id }, { status: 202 });
  });
}
