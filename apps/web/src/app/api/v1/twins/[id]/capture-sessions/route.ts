// POST /api/v1/twins/:id/capture-sessions — open a capture session with a
// checklist. Supports fulfillRequestId: checklist focuses the requested
// capability, all other items are waived (targeted evidence).
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { buildChecklist } from '@/lib/you/core/checklist';
import { handleRoute, notFound, readJsonBody, conflict, badRequest } from '@/lib/you/core/errors';
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

    const twin = await db.twin.findFirst({ where: { id, tenantId: auth.tenantId } });
    if (!twin) throw notFound(`twin "${id}" not found`);

    let fulfillRequest: { id: string; capability: string; reason: string; instructions: string; expectedSignal: string } | null = null;
    if (body.fulfillRequestId !== undefined && body.fulfillRequestId !== null) {
      if (typeof body.fulfillRequestId !== 'string') throw badRequest('fulfillRequestId must be a string');
      const req = await db.evidenceRequest.findFirst({ where: { id: body.fulfillRequestId, tenantId: auth.tenantId } });
      if (!req) throw notFound(`evidence request "${body.fulfillRequestId}" not found`);
      if (req.status !== 'open') throw conflict(`evidence request "${req.id}" is already ${req.status}`);
      fulfillRequest = {
        id: req.id,
        capability: req.capability,
        reason: req.reason,
        instructions: req.instructions,
        expectedSignal: req.expectedSignal,
      };
    }

    const checklist = buildChecklist(
      fulfillRequest
        ? {
            focusCapability: fulfillRequest.capability,
            requestReason: fulfillRequest.reason,
            requestInstructions: fulfillRequest.instructions,
            requestExpectedSignal: fulfillRequest.expectedSignal,
          }
        : {},
    );

    const session = await db.captureSession.create({
      data: {
        tenantId: auth.tenantId,
        twinId: twin.id,
        status: 'pending',
        checklist: JSON.stringify(checklist),
        instructions: fulfillRequest
          ? `Targeted capture for evidence request "${fulfillRequest.id}" (capability: ${fulfillRequest.capability}).`
          : 'Complete the checklist below. Even, front-facing light and a plain background give the strongest signal.',
      },
      include: { assets: true },
    });

    if (twin.status === 'draft') {
      await db.twin.update({ where: { id: twin.id }, data: { status: 'capturing' } }).catch(() => undefined);
    }

    await emitEvent(auth.tenantId, 'capture.created', 'capture_session', session.id, {
      captureSessionId: session.id,
      twinId: twin.id,
      focusedCapability: fulfillRequest?.capability ?? null,
    });

    return Response.json(captureSessionView(session, []), { status: 201 });
  });
}
