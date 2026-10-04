// GET  /api/v1/live-sessions/:id/signal?since=<seq> — poll the relayed
//        signaling state (the v1 transport: HTTP polling — documented honest
//        limit; no WebSocket/SSE yet). Returns offer/answer + candidates
//        with seq > since.
// POST /api/v1/live-sessions/:id/signal — relay one SDP offer/answer or ICE
//        candidate. Requires the session's short-lived signaling token
//        (x-signaling-token). The pure state machine enforces offer →
//        answer → candidates with honest 409s on wrong-phase; nothing is
//        silently dropped or reordered.
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, readJsonBody } from '@/lib/you/core/errors';
import { pollSignaling, relaySignal, toLiveHttpError } from '@/lib/you/live/runtime';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const sinceRaw = new URL(request.url).searchParams.get('since');
    const since = sinceRaw !== null && sinceRaw !== '' && Number.isFinite(Number(sinceRaw)) ? Number(sinceRaw) : undefined;
    try {
      return Response.json(await pollSignaling(auth.tenantId, id, since));
    } catch (err) {
      throw toLiveHttpError(err);
    }
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const body = await readJsonBody(request);
    const token = request.headers.get('x-signaling-token');
    if (!token || !token.trim()) {
      // honest 401 naming the required header (not a silent consent-style 403:
      // this is the session capability check, distinct from consent)
      return Response.json(
        {
          error: {
            code: 'unauthenticated',
            message: 'signaling requires the session signaling token — pass the x-signaling-token header minted at session create',
          },
        },
        { status: 401 },
      );
    }
    try {
      const result = await relaySignal(auth.tenantId, id, body, token.trim());
      return Response.json(result, { status: 201 });
    } catch (err) {
      throw toLiveHttpError(err);
    }
  });
}
