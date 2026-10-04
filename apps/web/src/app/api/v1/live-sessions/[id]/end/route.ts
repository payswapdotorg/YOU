// POST /api/v1/live-sessions/:id/end — EXPLICIT teardown (idempotent: an
// already-ended session returns 204 unchanged). The bounded state-event
// ring and the recorded signaling state are kept on the row; endedAt is
// recorded; the closed phase is terminal (no further signaling/state).
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute } from '@/lib/you/core/errors';
import { endLiveSession, toLiveHttpError } from '@/lib/you/live/runtime';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    try {
      await endLiveSession(auth.tenantId, id);
      return new Response(null, { status: 204 });
    } catch (err) {
      throw toLiveHttpError(err);
    }
  });
}
