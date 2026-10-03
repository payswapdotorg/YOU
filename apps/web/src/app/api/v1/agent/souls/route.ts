// GET  /api/v1/agent/souls — list Souls (production runtime, P6.C6)
// POST /api/v1/agent/souls — create a Soul (status draft; activate via PATCH)
//
// A Soul is personality/behavior configuration bound to a Twin, with an
// honest capability manifest and a deterministic seed. Provider is a chat
// adapter id (wave-1: zai); provider/model are recorded provenance.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { badRequest, handleRoute, readJsonBody, reqString, optString } from '@/lib/you/core/errors';
import { createRuntimeSoul, runtimeSoulView, toHttpError } from '@/lib/you/agent/runtime';

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

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const souls = await db.agentRuntimeSoul.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'asc' },
      include: { twin: true },
    });
    return Response.json(souls.map((s) => runtimeSoulView(s)));
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const body = await readJsonBody(request);
    try {
      const persona = optObject(body, 'persona');
      const params = optObject(body, 'params');
      const capabilities = optCapabilities(body);
      const description = optString(body, 'description', { max: 2000 });
      const provider = optString(body, 'provider');
      const created = await createRuntimeSoul(auth.tenantId, {
        name: reqString(body, 'name', { max: 120 }),
        twinId: reqString(body, 'twinId'),
        ...(description !== undefined ? { description } : {}),
        ...(provider !== undefined ? { provider } : {}),
        model: reqString(body, 'model', { max: 64 }),
        ...(persona !== undefined ? { persona } : {}),
        ...(params !== undefined ? { params } : {}),
        ...(capabilities !== undefined ? { capabilities } : {}),
      });
      return Response.json(created, { status: 201 });
    } catch (err) {
      throw toHttpError(err);
    }
  });
}
