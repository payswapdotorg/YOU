// GET  /api/v1/agent/bodies — list Bodies (production runtime, P6.C6)
// POST /api/v1/agent/bodies — create a Body (status draft; activate via PATCH)
//
// A Body is visual/physical avatar assets bound to a TwinVersion plus the
// ADR-0002 role/tool contract, with an honest capability manifest. The
// standard honest 4xx taxonomy applies (validation_failed / not_found /
// conflict envelopes via the shared error seam).
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, readJsonBody, reqString, optString, optStringArray } from '@/lib/you/core/errors';
import { createRuntimeBody, runtimeBodyView, toHttpError } from '@/lib/you/agent/runtime';

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const bodies = await db.agentRuntimeBody.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'asc' },
      include: { twinVersion: { include: { twin: true } } },
    });
    return Response.json(bodies.map((b) => runtimeBodyView(b)));
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const body = await readJsonBody(request);
    try {
      const description = optString(body, 'description', { max: 2000 });
      const twinId = optString(body, 'twinId');
      const tools = optStringArray(body, 'tools');
      const capabilities = optStringArray(body, 'capabilities');
      const created = await createRuntimeBody(auth.tenantId, {
        name: reqString(body, 'name', { max: 120 }),
        role: reqString(body, 'role', { max: 160 }),
        ...(description !== undefined ? { description } : {}),
        ...(twinId !== undefined ? { twinId } : {}),
        ...(tools !== undefined ? { tools } : {}),
        ...(capabilities !== undefined ? { capabilities } : {}),
      });
      return Response.json(created, { status: 201 });
    } catch (err) {
      throw toHttpError(err);
    }
  });
}
