// POST /api/v1/agent-avatar-sessions/:id/events — synchronous chat turn.
// Persists the user turn, runs the Soul through the TL seam runAgentTurn
// (Worker C implements), then persists the agent turn with events + latency.
// If the seam is not implemented yet, responds 501 with the honest error.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { badRequest, handleRoute, jsonError, notFound, readJsonBody, conflict } from '@/lib/you/core/errors';
import { emitEvent, recordUsage } from '@/lib/you/core/events';
import { runAgentTurn } from '@/lib/you/lab/agent-turn';
import { SOUL_CATALOG } from '@/lib/you/lab/seed';
import { agentTurnView, parseJson } from '@/lib/you/core/views';
import type { AgentBody } from '@prisma/client';

function compileBodySystemPrompt(body: AgentBody, twinDisplayName: string | null): string {
  const capabilities = parseJson<string[]>(body.capabilities, []);
  const tools = parseJson<string[]>(body.tools, []);
  const permissions = parseJson<string[]>(body.permissions, []);
  const memory = parseJson<{ policy?: string }>(body.memory, {});
  const lines = [
    `You are "${body.name}", an embodied agent (Body v${body.version}).`,
    `Role: ${body.role}.`,
    `Capabilities: ${capabilities.join(', ') || 'none'}.`,
    `Tools: ${tools.join(', ') || 'none'}.`,
    `Permissions: ${permissions.join(', ') || 'none'}.`,
    `Memory policy: ${memory.policy ?? 'session-scoped'}.`,
    'Respond as an embodied presence: concise, natural, respectful.',
  ];
  if (twinDisplayName) {
    lines.push(
      `You are embodying the authorized digital twin "${twinDisplayName}". Stay faithful to the consented embodiment scope.`,
    );
  }
  return lines.join('\n');
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const body = await readJsonBody(request);

    if (typeof body.message !== 'string' || !body.message.trim()) {
      throw badRequest('message is required (non-empty string)');
    }
    const message = body.message.trim().slice(0, 8000);

    const session = await db.agentAvatarSession.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { body: true, twin: true, turns: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) throw notFound(`agent avatar session "${id}" not found`);
    if (session.status === 'ended') throw conflict(`agent avatar session "${id}" has ended`);

    const soul = SOUL_CATALOG.find((s) => s.soulKey === session.soulKey);
    if (!soul) {
      throw notFound(`session soul "${session.soulKey}" no longer exists in the catalog`);
    }

    // 1) persist the user turn (honest record of the interaction)
    const userTurn = await db.agentAvatarTurn.create({
      data: { sessionId: session.id, role: 'user', content: message, states: '[]' },
    });

    // 2) run the Soul through the TL seam
    const history = session.turns.map((t) => ({
      role: t.role === 'user' ? ('user' as const) : ('agent' as const),
      content: t.content,
    }));

    let result;
    try {
      result = await runAgentTurn({
        sessionId: session.id,
        bodySystemPrompt: compileBodySystemPrompt(session.body, session.twin?.displayName ?? null),
        soul: {
          id: `soul_${soul.soulKey}`,
          soulKey: soul.soulKey,
          label: soul.label,
          provider: soul.provider,
          model: soul.model,
          routingClass: soul.routingClass,
          params: soul.params,
        },
        history,
        message,
      });
    } catch (err) {
      // honest 501: the seam (Worker C, task 2-c) is not implemented yet
      const messageText = err instanceof Error ? err.message : String(err);
      return jsonError('internal_error', messageText, 501, { turnId: userTurn.id });
    }

    // 3) persist the agent turn with events + latency
    const agentTurn = await db.agentAvatarTurn.create({
      data: {
        sessionId: session.id,
        role: 'agent',
        content: result.reply,
        states: JSON.stringify(result.events ?? []),
        latencyMs: result.latencyMs ?? null,
      },
    });

    await emitEvent(auth.tenantId, 'agent.turn.completed', 'agent_avatar_session', session.id, {
      sessionId: session.id,
      turnId: agentTurn.id,
      soulKey: session.soulKey,
      latencyMs: result.latencyMs ?? null,
      eventCount: (result.events ?? []).length,
    });
    await recordUsage(auth.tenantId, 'llm.calls', 1, {
      sessionId: session.id,
      soulKey: session.soulKey,
    });

    const turnView = agentTurnView(agentTurn);
    return Response.json({ turn: turnView, events: turnView.states });
  });
}
