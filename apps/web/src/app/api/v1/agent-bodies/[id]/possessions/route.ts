// POST /api/v1/agent-bodies/:id/possessions — bind a Soul from SOUL_CATALOG.
// Previous bindings are marked active=false (possession history is kept);
// returns the updated body with its possession list.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { badRequest, handleRoute, notFound, readJsonBody } from '@/lib/you/core/errors';
import { emitEvent } from '@/lib/you/core/events';
import { SOUL_CATALOG } from '@/lib/you/lab/seed';
import { agentBodyView } from '@/lib/you/core/views';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const body = await readJsonBody(request);

    const agentBody = await db.agentBody.findFirst({ where: { id, tenantId: auth.tenantId } });
    if (!agentBody) throw notFound(`agent body "${id}" not found`);

    if (typeof body.soulKey !== 'string' || !body.soulKey.trim()) {
      throw badRequest('soulKey is required');
    }
    const soul = SOUL_CATALOG.find((s) => s.soulKey === body.soulKey);
    if (!soul) {
      throw notFound(
        `unknown soulKey "${body.soulKey}" — available: ${SOUL_CATALOG.map((s) => s.soulKey).join(', ')}`,
      );
    }

    await db.agentSoulBinding.updateMany({ where: { bodyId: agentBody.id, active: true }, data: { active: false } });
    // reuse an existing binding row for this soul (possession history without duplicates)
    const existing = await db.agentSoulBinding.findFirst({
      where: { bodyId: agentBody.id, soulKey: soul.soulKey },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      await db.agentSoulBinding.update({ where: { id: existing.id }, data: { active: true } });
    } else {
      await db.agentSoulBinding.create({
        data: {
          bodyId: agentBody.id,
          soulKey: soul.soulKey,
          provider: soul.provider,
          model: soul.model,
          routingClass: soul.routingClass,
          params: JSON.stringify(soul.params),
          active: true,
        },
      });
    }

    // live sessions follow the body's new active soul (Body contract unchanged,
    // only the Soul binding is swapped — ADR-0002)
    await db.agentAvatarSession.updateMany({
      where: { bodyId: agentBody.id, status: 'live' },
      data: { soulKey: soul.soulKey },
    });

    await emitEvent(auth.tenantId, 'agent.body.possessed', 'agent_body', agentBody.id, {
      bodyId: agentBody.id,
      soulKey: soul.soulKey,
    });

    const updated = await db.agentBody.findUniqueOrThrow({
      where: { id: agentBody.id },
      include: { possessions: { orderBy: { createdAt: 'asc' } } },
    });
    return Response.json(agentBodyView(updated, updated.possessions));
  });
}
