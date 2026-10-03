// POST /api/v1/captures/:id/f1/steps/:stepId/skip — skip one guided step
// WITH a recorded reason (P6.B3). Skipping is the operator's honest call and
// is always allowed on a non-terminal step (including REQUIRED steps — the
// protocol persists the skip, and the review/export surfaces disclose every
// skipped required step; nothing is silently waived). The ADVANCE consent
// gate is server-enforced here exactly like submit.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { parseF1Protocol, requireF1CaptureConsent } from '@/lib/you/core/f1-flow';
import { badRequest, conflict, handleRoute, notFound, readJsonBody, reqString } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { captureSessionView } from '@/lib/you/core/views';
import type { F1GuidedStep, F1ProtocolState } from '@/lib/you/contracts';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; stepId: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id, stepId } = await params;

    const session = await db.captureSession.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { twin: true },
    });
    if (!session) throw notFound(`capture session "${id}" not found`);
    if (session.status === 'complete' || session.status === 'failed') {
      throw conflict(`capture session "${id}" is already ${session.status}`);
    }

    const protocol = parseF1Protocol(session);
    if (!protocol) {
      throw badRequest(`capture session "${id}" is not a guided F1 session (no persisted protocol)`);
    }
    const step = protocol.steps.find((s) => s.id === stepId);
    if (!step) throw notFound(`protocol step "${stepId}" not found on session "${id}"`);
    if (step.state === 'done' || step.state === 'skipped') {
      throw conflict(`step "${stepId}" is already ${step.state}`);
    }

    const body = await readJsonBody(request);
    const reason = reqString(body, 'reason', { max: 400 });

    // ── ADVANCE GATE: server-enforced, re-verified on EVERY skip ────────────
    const { grant } = await requireF1CaptureConsent(auth.tenantId, session.twin.subjectId);

    const updatedSteps: F1GuidedStep[] = protocol.steps.map((s) =>
      s.id === stepId ? { ...s, state: 'skipped' as const, skipReason: reason } : s,
    );
    let currentStepId = protocol.currentStepId;
    if (currentStepId === stepId) {
      const nextPending = updatedSteps.find((s) => s.state === 'pending');
      currentStepId = nextPending?.id ?? null;
      if (nextPending) {
        const idx = updatedSteps.findIndex((s) => s.id === nextPending.id);
        updatedSteps[idx] = { ...updatedSteps[idx], state: 'current' };
      }
    }
    const updatedProtocol: F1ProtocolState = { ...protocol, steps: updatedSteps, currentStepId };

    await db.captureSession.update({
      where: { id: session.id },
      data: { protocol: JSON.stringify(updatedProtocol), consentGrantId: grant.id },
    });

    await audit(auth.tenantId, auth, 'capture.f1_step_skipped', 'capture_session', session.id, {
      stepId,
      reason,
      required: step.required,
      consentGrantId: grant.id,
    });
    await emitEvent(auth.tenantId, 'capture.f1_step_skipped', 'capture_session', session.id, {
      captureSessionId: session.id,
      twinId: session.twinId,
      stepId,
      reason,
      required: step.required,
    });

    const refreshed = await db.captureSession.findUnique({
      where: { id: session.id },
      include: { assets: { orderBy: { createdAt: 'asc' } } },
    });
    return Response.json({
      ...captureSessionView(refreshed ?? session, refreshed?.assets ?? []),
      skipped: { stepId, reason, required: step.required },
    });
  });
}
