// POST /api/v1/agent-avatar-sessions — start an embodiment session.
// When a twinId is given, consent scope "embodiment" is server-enforced for
// the twin's subjectId. Sessions start with EMPTY turns.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { requireConsent } from '@/lib/you/core/consent';
import { badRequest, handleRoute, notFound, readJsonBody } from '@/lib/you/core/errors';
import { emitEvent } from '@/lib/you/core/events';
import { SOUL_CATALOG } from '@/lib/you/lab/seed';
import { avatarSessionView } from '@/lib/you/core/views';

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const body = await readJsonBody(request);

    if (typeof body.bodyId !== 'string' || !body.bodyId.trim()) throw badRequest('bodyId is required');
    if (typeof body.soulKey !== 'string' || !body.soulKey.trim()) throw badRequest('soulKey is required');

    const agentBody = await db.agentBody.findFirst({ where: { id: body.bodyId, tenantId: auth.tenantId } });
    if (!agentBody) throw notFound(`agent body "${body.bodyId}" not found`);

    const soul = SOUL_CATALOG.find((s) => s.soulKey === body.soulKey);
    if (!soul) {
      throw notFound(
        `unknown soulKey "${body.soulKey}" — available: ${SOUL_CATALOG.map((s) => s.soulKey).join(', ')}`,
      );
    }

    let twinId: string | null = null;
    let twinDisplayName: string | null = null;
    if (body.twinId !== undefined && body.twinId !== null) {
      if (typeof body.twinId !== 'string') throw badRequest('twinId must be a string');
      const twin = await db.twin.findFirst({ where: { id: body.twinId, tenantId: auth.tenantId } });
      if (!twin) throw notFound(`twin "${body.twinId}" not found`);
      // server-enforced consent: embodiment requires the embodiment scope
      await requireConsent(auth.tenantId, twin.subjectId, 'embodiment');
      twinId = twin.id;
      twinDisplayName = twin.displayName;
    }

    const session = await db.agentAvatarSession.create({
      data: { tenantId: auth.tenantId, bodyId: agentBody.id, soulKey: soul.soulKey, twinId, status: 'live' },
    });

    await emitEvent(auth.tenantId, 'agent.session.started', 'agent_avatar_session', session.id, {
      sessionId: session.id,
      bodyId: agentBody.id,
      soulKey: soul.soulKey,
      twinId,
    });

    return Response.json(avatarSessionView(session, agentBody, twinDisplayName, []), { status: 201 });
  });
}
