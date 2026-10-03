// GET  /api/v1/agent/sessions — list sessions (newest first, bounded)
// POST /api/v1/agent/sessions — start a session binding (Twin, Body, Soul)
//
// Binding law: both entities must be active (409), both manifests must
// declare `conversation` (403 policy_blocked), the Body's TwinVersion (when
// bound) must belong to the Soul's twin (409), and the twin's subject needs
// an active consent grant with the `embodiment` scope (403 consent_required —
// server-enforced; the grant id is recorded on the session as provenance and
// re-verified on every turn).
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, readJsonBody, reqString } from '@/lib/you/core/errors';
import { createRuntimeSession, runtimeSessionSummaryView, toHttpError } from '@/lib/you/agent/runtime';

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const sessions = await db.agentRuntimeSession.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { twin: true, body: true, soul: true, _count: { select: { turns: true } } },
    });
    return Response.json(sessions.map((s) => runtimeSessionSummaryView(s)));
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const body = await readJsonBody(request);
    try {
      const session = await createRuntimeSession(auth.tenantId, {
        bodyId: reqString(body, 'bodyId'),
        soulId: reqString(body, 'soulId'),
      });
      return Response.json(session, { status: 201 });
    } catch (err) {
      throw toHttpError(err);
    }
  });
}
