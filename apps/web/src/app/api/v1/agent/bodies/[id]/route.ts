// GET   /api/v1/agent/bodies/:id — Body detail (with its version snapshots)
// PATCH /api/v1/agent/bodies/:id — lifecycle action (activate/deactivate) OR
//        definition update (appends an immutable version snapshot; 409 on
//        invalid transitions, 400 on mixed payloads).
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { badRequest, handleRoute, readJsonBody, notFound, optString, optStringArray } from '@/lib/you/core/errors';
import { runtimeBodyView, toHttpError, updateRuntimeBody } from '@/lib/you/agent/runtime';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const body = await db.agentRuntimeBody.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { twinVersion: { include: { twin: true } }, versions: { orderBy: { version: 'asc' } } },
    });
    if (!body) throw notFound(`agent body "${id}" not found`);
    const view = runtimeBodyView(body);
    return Response.json({
      ...view,
      versions: body.versions.map((v) => ({
        version: v.version,
        createdAt: v.createdAt.toISOString(),
        snapshot: JSON.parse(v.snapshot) as Record<string, unknown>,
      })),
    });
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const body = await readJsonBody(request);
    try {
      const action = body.action;
      if (action !== undefined && action !== null) {
        if (action !== 'activate' && action !== 'deactivate') {
          throw badRequest('field "action" must be "activate" or "deactivate"');
        }
      }
      const description =
        body.description === null ? null : optString(body, 'description', { max: 2000 });
      const twinIdRaw = body.twinId;
      const twinId =
        twinIdRaw === null ? null : typeof twinIdRaw === 'string' && twinIdRaw.trim() ? twinIdRaw.trim() : undefined;
      const tools = optStringArray(body, 'tools');
      const capabilities = optStringArray(body, 'capabilities');
      const updated = await updateRuntimeBody(auth.tenantId, id, {
        ...(action ? { action } : {}),
        ...(optString(body, 'name', { max: 120 }) !== undefined ? { name: optString(body, 'name', { max: 120 }) } : {}),
        ...(optString(body, 'role', { max: 160 }) !== undefined ? { role: optString(body, 'role', { max: 160 }) } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(twinId !== undefined ? { twinId } : {}),
        ...(tools !== undefined ? { tools } : {}),
        ...(capabilities !== undefined ? { capabilities } : {}),
      });
      return Response.json(updated);
    } catch (err) {
      throw toHttpError(err);
    }
  });
}
