// GET /api/v1/agent-souls — SOUL_CATALOG mapped to AgentSoulView[]
// (ids are `soul_<soulKey>`; provider is an adapter id, never a hard vendor)
import { SOUL_CATALOG } from '@/lib/you/lab/seed';
import { soulView } from '@/lib/you/core/views';
import { handleRoute } from '@/lib/you/core/errors';

export async function GET(): Promise<Response> {
  return handleRoute(async () => {
    return Response.json(SOUL_CATALOG.map(soulView));
  });
}
