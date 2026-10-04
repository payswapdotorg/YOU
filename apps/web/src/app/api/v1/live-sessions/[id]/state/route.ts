// POST /api/v1/live-sessions/:id/state — one live state event:
//   { kind: 'connection', connectionState: connecting|connected|failed|closed }
//     → the REAL RTCPeerConnection lifecycle; only a peer-reported `connected`
//       makes the session live (no fake liveness — ever).
//   { kind: 'performance', delta: { gaze?, expression?, speech?, intensity? } }
//     → performance deltas (validated, bounded).
//   { kind: 'agent', agentState: <P4 surface state> }
//     → agent state machine transitions on the live surface.
// Idempotency: x-idempotency-key — a replayed key returns the original
// event (duplicate: true) and appends nothing. Requires the session's
// signaling token (x-signaling-token). Consent is re-verified per write
// (fail-closed: a revoked grant ends the session honestly).
import { requireApiAuth } from '@/lib/you/core/auth';
import { getIdempotencyKey, handleRoute, readJsonBody } from '@/lib/you/core/errors';
import { submitStateEvent, toLiveHttpError } from '@/lib/you/live/runtime';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  // P6.C12: observed under the declared 'live.state.stream' SLO (docs/COST_LATENCY.md).
  const observedRoute = (fn: () => Promise<Response>) => handleRoute(fn, { request, slo: 'live.state.stream' });
  return observedRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const body = await readJsonBody(request);
    const token = request.headers.get('x-signaling-token');
    if (!token || !token.trim()) {
      return Response.json(
        {
          error: {
            code: 'unauthenticated',
            message: 'state events require the session signaling token — pass the x-signaling-token header minted at session create',
          },
        },
        { status: 401 },
      );
    }
    try {
      const result = await submitStateEvent(
        auth.tenantId,
        id,
        body,
        getIdempotencyKey(request),
        token.trim(),
      );
      return Response.json(result, { status: 201 });
    } catch (err) {
      throw toLiveHttpError(err);
    }
  });
}
