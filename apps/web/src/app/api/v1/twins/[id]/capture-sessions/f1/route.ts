// POST /api/v1/twins/:id/capture-sessions/f1 — open a GUIDED F1 capture
// session (P6.B3, Worker B lane; docs/F1_OPERATOR_CAPTURE.md is THE LAW).
//
// Server-enforced consent gate at CREATION: an active capture-scope grant
// whose statements cover the six F1 requirements (what / why / tests /
// retention / training-default-denied / deletion) must exist — otherwise an
// honest 403 consent_required envelope with a machine-readable
// missingStatements list (never a silent pass, never a UI-only gate).
//
// The 8-step protocol is initialized with its ACTUAL operator instruction
// text persisted on the capture record (the acceptance-fixture instruction
// law), the covering grant id is recorded for provenance, and the effective
// retention/deletion policy is snapshotted from the consent statements.
// Legacy sessions (POST /twins/:id/capture-sessions) are untouched.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { buildF1ProtocolState, requireF1CaptureConsent } from '@/lib/you/core/f1-flow';
import { handleRoute, notFound } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { captureSessionView } from '@/lib/you/core/views';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;

    const twin = await db.twin.findFirst({ where: { id, tenantId: auth.tenantId } });
    if (!twin) throw notFound(`twin "${id}" not found`);

    // fail-closed F1 consent gate — no session row exists before it passes
    const { grant, statements } = await requireF1CaptureConsent(auth.tenantId, twin.subjectId);

    const protocol = buildF1ProtocolState();
    const session = await db.captureSession.create({
      data: {
        tenantId: auth.tenantId,
        twinId: twin.id,
        status: 'pending',
        // the guided flow carries its own protocol state; the legacy checklist
        // stays empty so legacy surfaces render nothing stale
        checklist: '[]',
        instructions:
          'Guided F1 capture — walk the consenting subject through the 8 steps in order. Evidence is immutable once uploaded; skipped steps require a reason and are disclosed at review.',
        consentGrantId: grant.id,
        protocol: JSON.stringify(protocol),
        retention: JSON.stringify({
          ...statements.retention,
          deletionProcess: statements.deletion,
        }),
        review: '{}',
      },
      include: { assets: true },
    });

    if (twin.status === 'draft') {
      await db.twin.update({ where: { id: twin.id }, data: { status: 'capturing' } }).catch(() => undefined);
    }

    await audit(auth.tenantId, auth, 'capture.f1_created', 'capture_session', session.id, {
      twinId: twin.id,
      consentGrantId: grant.id,
      trainingPermitted: statements.training.permitted,
      retentionPolicy: statements.retention.policy,
    });
    await emitEvent(auth.tenantId, 'capture.f1_created', 'capture_session', session.id, {
      captureSessionId: session.id,
      twinId: twin.id,
      consentGrantId: grant.id,
      protocolSteps: protocol.steps.length,
    });

    return Response.json(captureSessionView(session, []), { status: 201 });
  });
}
