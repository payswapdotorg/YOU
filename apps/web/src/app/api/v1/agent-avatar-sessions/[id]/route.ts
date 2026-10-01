// GET    /api/v1/agent-avatar-sessions/:id — session with turns
// DELETE /api/v1/agent-avatar-sessions/:id — end session (status ended + endedAt)
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, notFound } from '@/lib/you/core/errors';
import { emitEvent } from '@/lib/you/core/events';
import { avatarSessionView } from '@/lib/you/core/views';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const session = await db.agentAvatarSession.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { body: true, twin: true, turns: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) throw notFound(`agent avatar session "${id}" not found`);
    return Response.json(
      avatarSessionView(session, session.body, session.twin?.displayName ?? null, session.turns),
    );
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const session = await db.agentAvatarSession.findFirst({ where: { id, tenantId: auth.tenantId } });
    if (!session) throw notFound(`agent avatar session "${id}" not found`);

    if (session.status !== 'ended') {
      const endedAt = new Date();
      await db.agentAvatarSession.update({ where: { id: session.id }, data: { status: 'ended', endedAt } });
      await emitEvent(auth.tenantId, 'agent.session.ended', 'agent_avatar_session', session.id, {
        sessionId: session.id,
        endedAt: endedAt.toISOString(),
      });
    }

    return new Response(null, { status: 204 });
  });
}
