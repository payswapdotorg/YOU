// POST /api/v1/agent/sessions/:id/interrupt — user interrupt of the session's
// LATEST in-flight turn (P6.B7 embodiment: interrupted → idle).
//
// Honest semantics (the lab/compute.ts cancelCompute precedent — no fake
// cancellations, ever):
//   - QUEUED job  → EFFECTIVE cancellation (the core runner refuses non-queued
//     jobs, so the turn never runs; no reply is produced). 202 { effective: true }.
//   - RUNNING job → a DURABLE `agent.turn.interrupt_requested` event is emitted
//     (the core runner has no cooperative cancel seam; the in-flight turn may
//     still complete and records its real terminal state). 202 { effective: false }.
//   - No turn in flight → 409 conflict (nothing to interrupt).
//   - Ended session → 409 (nothing to interrupt).
//
// The user turn row is NEVER deleted — the message stays recorded with its
// cancelled/jobbed state; the avatar shows `interrupted` then settles to idle.
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute } from '@/lib/you/core/errors';
import { interruptRuntimeTurn, toHttpError } from '@/lib/you/agent/runtime';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    try {
      const result = await interruptRuntimeTurn(auth.tenantId, id);
      return Response.json(result, { status: 202 });
    } catch (err) {
      throw toHttpError(err);
    }
  });
}
