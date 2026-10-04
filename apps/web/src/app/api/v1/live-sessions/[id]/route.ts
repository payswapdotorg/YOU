// GET /api/v1/live-sessions/:id — session detail (the live state monitor's
// poll target): status + signaling phase, current agent state, last
// connection state, and the bounded recent state-event ring. Signaling SDP
// blobs are NOT included (the signal route's poll view carries them).
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute } from '@/lib/you/core/errors';
import { getLiveSession, toLiveHttpError } from '@/lib/you/live/runtime';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    try {
      return Response.json(await getLiveSession(auth.tenantId, id));
    } catch (err) {
      throw toLiveHttpError(err);
    }
  });
}
