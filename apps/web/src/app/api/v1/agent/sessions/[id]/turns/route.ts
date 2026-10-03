// POST /api/v1/agent/sessions/:id/turns — submit one chat turn.
//
// Honest flow (all typed, all server-enforced):
//   1. accept-time circuit-breaker admission for the zai chat seam (503 with
//      retry guidance when open — the B8 degraded pattern);
//   2. session must be live (409 conflict on ended sessions);
//   3. embodiment consent is RE-VERIFIED at submit time (403 consent_required)
//      — and again inside the durable executor (fail-closed at both layers);
//   4. the user turn is persisted FIRST (the honest interaction record), then
//      the durable `agent.turn` job is created (202 { jobId, turn }) — the
//      turn executes through the resilience stack: per-LLM-call retries +
//      breaker inside ai/zai.ts, job-level bounded retry + dead-letter in
//      core/jobs.ts. Exhausted retryable failures land in the dead-letter
//      queue (GET /api/v1/maintenance/dead-jobs) and surface per-turn via the
//      session detail's honest jobStatus/jobError join.
//
// Idempotency: x-idempotency-key dedupes the job; a replay returns the
// existing job + user turn (no duplicate turns, no duplicate LLM calls).
import { requireApiAuth } from '@/lib/you/core/auth';
import { badRequest, getIdempotencyKey, handleRoute, readJsonBody } from '@/lib/you/core/errors';
import { submitRuntimeTurn, toHttpError } from '@/lib/you/agent/runtime';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const body = await readJsonBody(request);
    if (typeof body.message !== 'string' || !body.message.trim()) {
      throw badRequest('field "message" is required (non-empty string)');
    }
    const message = body.message.trim().slice(0, 8000);
    try {
      const result = await submitRuntimeTurn(auth.tenantId, id, message, getIdempotencyKey(request));
      return Response.json(
        { jobId: result.jobId, turn: result.turn, ...(result.replayed ? { replayed: true } : {}) },
        { status: 202 },
      );
    } catch (err) {
      throw toHttpError(err);
    }
  });
}
