// GET  /api/v1/agent-bodies — bodies with parsed possessions
// POST /api/v1/agent-bodies — create (defaults for capabilities/tools/
// permissions/memory/evaluation per ADR-0002 body contract)
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, readJsonBody, reqString, optStringArray } from '@/lib/you/core/errors';
import { emitEvent } from '@/lib/you/core/events';
import { agentBodyView } from '@/lib/you/core/views';

export const DEFAULT_CAPABILITIES = ['conversation', 'performance', 'tool-use'];
export const DEFAULT_TOOLS = ['none'];
export const DEFAULT_PERMISSIONS = ['speak', 'listen', 'gesture'];
export const DEFAULT_MEMORY = {
  policy: 'session-scoped working memory only; no persistent biometric memory',
  workingNotes: [],
};
export const DEFAULT_EVALUATION = {
  rubric: ['responsiveness', 'presence', 'instruction-faithfulness'],
  minScore: 0.7,
};

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const bodies = await db.agentBody.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'asc' },
      include: { possessions: { orderBy: { createdAt: 'asc' } } },
    });
    return Response.json(bodies.map((b) => agentBodyView(b, b.possessions)));
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const body = await readJsonBody(request);

    const name = reqString(body, 'name', { max: 120 });
    const role = reqString(body, 'role', { max: 160 });
    const capabilities = optStringArray(body, 'capabilities') ?? [...DEFAULT_CAPABILITIES];
    const tools = optStringArray(body, 'tools') ?? [...DEFAULT_TOOLS];
    const permissions = optStringArray(body, 'permissions') ?? [...DEFAULT_PERMISSIONS];

    const agentBody = await db.agentBody.create({
      data: {
        tenantId: auth.tenantId,
        name,
        role,
        version: 1,
        capabilities: JSON.stringify(capabilities),
        tools: JSON.stringify(tools),
        permissions: JSON.stringify(permissions),
        memory: JSON.stringify(DEFAULT_MEMORY),
        evaluation: JSON.stringify(DEFAULT_EVALUATION),
      },
      include: { possessions: { orderBy: { createdAt: 'asc' } } },
    });

    await emitEvent(auth.tenantId, 'agent.body.created', 'agent_body', agentBody.id, {
      bodyId: agentBody.id,
      name,
      role,
    });

    return Response.json(agentBodyView(agentBody, []), { status: 201 });
  });
}
