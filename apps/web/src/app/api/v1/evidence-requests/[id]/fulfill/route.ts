// POST /api/v1/evidence-requests/:id/fulfill — fulfill a targeted evidence
// request with a capture session.
//
// Two modes (P6.B5 extended the original contract; both stay available):
//   LEGACY (default, no `guided` flag): creates a checklist-based capture
//   session with the requested capability focused (other items waived) and
//   marks the request fulfilled IMMEDIATELY — the original behavior,
//   preserved for backwards compatibility.
//
//   GUIDED (`guided: true`, the P6.B5 production path): opens a GUIDED F1
//   capture session prefilled from the request — the capability is mapped
//   onto the 8-step protocol (focused steps required + carrying the request's
//   instruction text; out-of-scope steps pre-skipped with an honest reason)
//   and the B3 SERVER-ENFORCED CONSENT GATE runs at creation (and again on
//   every advance/complete — the shared f1 routes re-verify it). The request
//   is LINKED (captureSessionId) but stays OPEN until the guided session
//   COMPLETES; `complete` then flips it to fulfilled and emits
//   evidence.request.fulfilled (the closed loop). A failed fulfillment
//   attempt may be re-fulfilled; an in-progress one is refused with the
//   linked session id so the UI can resume it.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { buildChecklist } from '@/lib/you/core/checklist';
import {
  buildF1FulfillmentProtocol, requireF1CaptureConsent,
} from '@/lib/you/core/f1-flow';
import {
  badRequest, conflict, handleRoute, notFound, readJsonBody,
} from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { captureSessionView, evidenceRequestView } from '@/lib/you/core/views';

const ACTIVE_SESSION_STATUSES = ['pending', 'uploading', 'analyzing'];

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const body = await readJsonBody(request);
    const guided = body.guided === true;

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

    if (!guided) {
      // ── LEGACY path (backwards compatible, unchanged) ────────────────────
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
    }

    // ── GUIDED path (P6.B5): prefilled F1 session, fulfilled on complete ────

    // an already-linked session decides the response honestly:
    //  - in progress → 409 with the session id (the UI resumes it)
    //  - completed   → the request should have flipped at complete; if the
    //    close-out was interrupted (crash window), repair it now instead of
    //    minting a duplicate session — and say so in the response
    if (evidenceRequest.captureSessionId) {
      const linked = await db.captureSession.findFirst({
        where: { id: evidenceRequest.captureSessionId, tenantId: auth.tenantId },
      });
      if (linked && ACTIVE_SESSION_STATUSES.includes(linked.status)) {
        throw conflict(
          `evidence request "${id}" already has a fulfillment capture in progress (${linked.id}) — complete or let it fail before starting another`,
          { captureSessionId: linked.id, reason: 'fulfillment_in_progress' },
        );
      }
      if (linked && linked.status === 'complete') {
        const repaired = await db.evidenceRequest.update({
          where: { id: evidenceRequest.id },
          data: { status: 'fulfilled', captureSessionId: linked.id },
        });
        return Response.json({
          captureSession: captureSessionView(linked, []),
          evidenceRequest: evidenceRequestView(repaired),
          resumed: true,
        });
      }
      // linked && failed (or the row vanished) → fall through, a fresh
      // fulfillment attempt replaces the link; the old session stays for
      // provenance in the event log and audit trail
    }

    // SERVER-ENFORCED consent gate — no session row exists before it passes
    const { grant, statements } = await requireF1CaptureConsent(auth.tenantId, twin.subjectId);

    const protocol = buildF1FulfillmentProtocol({
      id: evidenceRequest.id,
      capability: evidenceRequest.capability,
      reason: evidenceRequest.reason,
      instructions: evidenceRequest.instructions,
      expectedSignal: evidenceRequest.expectedSignal,
    });

    const session = await db.captureSession.create({
      data: {
        tenantId: auth.tenantId,
        twinId: twin.id,
        status: 'pending',
        checklist: '[]',
        instructions: `Fulfills evidence request "${evidenceRequest.id}" (${evidenceRequest.capability}): ${evidenceRequest.instructions}`,
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

    // LINK now, fulfill at complete — the request honestly reads "open, in
    // progress" until the guided session reaches its terminal state
    const updated = await db.evidenceRequest.update({
      where: { id: evidenceRequest.id },
      data: { captureSessionId: session.id },
    });

    if (twin.status === 'draft') {
      await db.twin.update({ where: { id: twin.id }, data: { status: 'capturing' } }).catch(() => undefined);
    }

    await audit(auth.tenantId, auth, 'evidence.request.fulfillment_started', 'evidence_request', evidenceRequest.id, {
      requestId: evidenceRequest.id,
      captureSessionId: session.id,
      twinId: twin.id,
      capability: evidenceRequest.capability,
      focusedStepIds: protocol.fulfillment?.focusedStepIds ?? [],
      consentGrantId: grant.id,
    });
    await emitEvent(auth.tenantId, 'capture.f1_created', 'capture_session', session.id, {
      captureSessionId: session.id,
      twinId: twin.id,
      consentGrantId: grant.id,
      protocolSteps: protocol.steps.length,
      fulfillsRequestId: evidenceRequest.id,
    });

    return Response.json(
      {
        captureSession: captureSessionView(session, []),
        evidenceRequest: evidenceRequestView(updated),
      },
      { status: 201 },
    );
  });
}
