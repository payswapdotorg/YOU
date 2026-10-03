// GET   /api/v1/agent/souls/:id — Soul detail (with its immutable version snapshots)
// PATCH /api/v1/agent/souls/:id — lifecycle action (activate/deactivate) OR
//        definition update (persona/params/capabilities/name/description —
//        appends an immutable version snapshot; twinId/provider/model/seed
//        are immutable: rebinding is a NEW Soul, mutating the seed would
//        break reproducibility of past turns).
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { badRequest, handleRoute, readJsonBody, notFound, optString } from '@/lib/you/core/errors';
import { runtimeSoulView, toHttpError, updateRuntimeSoul } from '@/lib/you/agent/runtime';

function optObject(body: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw badRequest(`field "${field}" must be an object`);
  }
  return v as Record<string, unknown>;
}

function optCapabilities(body: Record<string, unknown>): string[] | undefined {
  const v = body.capabilities;
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((c) => typeof c !== 'string' || !c.trim())) {
    throw badRequest('field "capabilities" must be an array of capability strings');
  }
  return (v as string[]).map((c) => c.trim());
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const soul = await db.agentRuntimeSoul.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { twin: true, versions: { orderBy: { version: 'asc' } } },
    });
    if (!soul) throw notFound(`agent soul "${id}" not found`);
    const view = runtimeSoulView(soul);
    return Response.json({
      ...view,
      versions: soul.versions.map((v) => ({
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
      if (body.twinId !== undefined || body.provider !== undefined || body.model !== undefined || body.seed !== undefined) {
        throw badRequest(
          'twinId, provider, model and seed are immutable after create — rebind by creating a new Soul (identity + reproducibility law)',
        );
      }
      const action = body.action;
      if (action !== undefined && action !== null && action !== 'activate' && action !== 'deactivate') {
        throw badRequest('field "action" must be "activate" or "deactivate"');
      }
      const persona = optObject(body, 'persona');
      const params = optObject(body, 'params');
      const capabilities = optCapabilities(body);
      const descriptionRaw = body.description;
      const description =
        descriptionRaw === null ? null : optString(body, 'description', { max: 2000 });
      const updated = await updateRuntimeSoul(auth.tenantId, id, {
        ...(action ? { action } : {}),
        ...(optString(body, 'name', { max: 120 }) !== undefined ? { name: optString(body, 'name', { max: 120 }) } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(persona !== undefined ? { persona } : {}),
        ...(params !== undefined ? { params } : {}),
        ...(capabilities !== undefined ? { capabilities } : {}),
      });
      return Response.json(updated);
    } catch (err) {
      throw toHttpError(err);
    }
  });
}
