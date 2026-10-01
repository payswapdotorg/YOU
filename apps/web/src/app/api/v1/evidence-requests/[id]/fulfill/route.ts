// POST /api/v1/evidence-requests/:id/fulfill — create a prefilled
// CaptureSession focused on the requested capability (other checklist items
// waived), mark the request fulfilled, return {captureSession}.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { buildChecklist } from '@/lib/you/core/checklist';
import { badRequest, conflict, handleRoute, notFound, readJsonBody } from '@/lib/you/core/errors';
import { emitEvent } from '@/lib/you/core/events';
import { captureSessionView } from '@/lib/you/core/views';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const body = await readJsonBody(request);

    const evidenceRequest = await db.evidenceRequest.findFirst({
      where: { id, tenantId: auth.tenantId },
    });
    if (!evidenceRequest) throw notFound(`evidence request "${id}" not found`);
    if (evidenceRequest.status !== 'open') {
      throw conflict(`evidence request "${id}" is already ${evidenceRequest.status}`);
    }

    if (typeof body.twinId !== 'string' || !body.twinId.trim()) {
      throw badRequest('twinId is required');
    }
    const twin = await db.twin.findFirst({ where: { id: body.twinId, tenantId: auth.tenantId } });
    if (!twin) throw notFound(`twin "${body.twinId}" not found`);

    const checklist = buildChecklist({
      focusCapability: evidenceRequest.capability,
      requestReason: evidenceRequest.reason,
      requestInstructions: evidenceRequest.instructions,
      requestExpectedSignal: evidenceRequest.expectedSignal,
    });

    const session = await db.captureSession.create({
      data: {
        tenantId: auth.tenantId,
        twinId: twin.id,
        status: 'pending',
        checklist: JSON.stringify(checklist),
        instructions: `Fulfills evidence request "${evidenceRequest.id}" (${evidenceRequest.capability}): ${evidenceRequest.instructions}`,
      },
      include: { assets: true },
    });

    await db.evidenceRequest.update({
      where: { id: evidenceRequest.id },
      data: { status: 'fulfilled', captureSessionId: session.id },
    });

    if (twin.status === 'draft') {
      await db.twin.update({ where: { id: twin.id }, data: { status: 'capturing' } }).catch(() => undefined);
    }

    await emitEvent(auth.tenantId, 'evidence.request.fulfilled', 'evidence_request', evidenceRequest.id, {
      requestId: evidenceRequest.id,
      captureSessionId: session.id,
      twinId: twin.id,
      capability: evidenceRequest.capability,
    });
    await emitEvent(auth.tenantId, 'capture.created', 'capture_session', session.id, {
      captureSessionId: session.id,
      twinId: twin.id,
      focusedCapability: evidenceRequest.capability,
    });

    return Response.json({ captureSession: captureSessionView(session, []) }, { status: 201 });
  });
}
