// GET  /api/v1/live-sessions — list live sessions (newest first, bounded)
// POST /api/v1/live-sessions — open a live session (consent-enforced).
//
// Consent law: a live session CANNOT open without an active grant covering
// live performance (embodiment scope — driving a twin's live performance IS
// realtime embodiment). Pass consentGrantId to pin a specific grant (the
// Studio picker); otherwise the covering grant is resolved server-side.
// The response mints a SHORT-LIVED signaling token (10 min) bound to this
// session — signal/state submits must present it (x-signaling-token).
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, readJsonBody } from '@/lib/you/core/errors';
import { createLiveSession, listLiveSessions, toLiveHttpError } from '@/lib/you/live/runtime';

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const sessions = await listLiveSessions(auth.tenantId);
    return Response.json(sessions);
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const body = await readJsonBody(request);
    try {
      const result = await createLiveSession(auth.tenantId, {
        twinId: typeof body.twinId === 'string' && body.twinId.trim() ? body.twinId.trim() : undefined,
        agentSessionId:
          typeof body.agentSessionId === 'string' && body.agentSessionId.trim() ? body.agentSessionId.trim() : undefined,
        consentGrantId:
          typeof body.consentGrantId === 'string' && body.consentGrantId.trim() ? body.consentGrantId.trim() : undefined,
      });
      return Response.json(result, { status: 201 });
    } catch (err) {
      throw toLiveHttpError(err);
    }
  });
}
