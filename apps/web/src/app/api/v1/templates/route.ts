// POST /api/v1/templates — register a template (W2.B persistence half).
// Packages a capture checklist, scene recipes and style presets as a versioned
// record. Supports Idempotency-Key (§API rules): a replay with the same key
// returns the existing record (200) instead of creating a duplicate.
// GET  /api/v1/templates — list templates for the tenant (additive read route
// consistent with the established list-route pattern: GET /twins, /captures…).
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { badRequest, getIdempotencyKey, handleRoute, readJsonBody } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { parseTemplateBody, TemplateBodyError, templateView } from '@/lib/you/core/templates';

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const templates = await db.template.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'desc' },
      include: { recipes: true },
    });
    return Response.json(templates.map((t) => templateView(t, t.recipes)));
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const body = await readJsonBody(request);

    let parsed;
    try {
      parsed = parseTemplateBody(body);
    } catch (err) {
      if (err instanceof TemplateBodyError) throw badRequest(err.message);
      throw err;
    }

    const idempotencyKey = getIdempotencyKey(request);
    if (idempotencyKey) {
      const existing = await db.template.findUnique({ where: { idempotencyKey } });
      if (existing) {
        const withRecipes = await db.template.findUnique({
          where: { id: existing.id },
          include: { recipes: true },
        });
        return Response.json(templateView(withRecipes ?? existing, withRecipes?.recipes ?? []), { status: 200 });
      }
    }

    let created;
    try {
      created = await db.template.create({
        data: {
          tenantId: auth.tenantId,
          name: parsed.name,
          description: parsed.description,
          version: 1,
          status: parsed.status,
          manifest: JSON.stringify(parsed.manifest),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          recipes: {
            create: parsed.scenes.map((scene) => ({
              name: scene.name,
              parameters: JSON.stringify(scene.parameters),
            })),
          },
        },
        include: { recipes: true },
      });
    } catch (err) {
      // concurrent duplicate idempotency-key insert → return the winner
      if (idempotencyKey && (err as { code?: string }).code === 'P2002') {
        const existing = await db.template.findUnique({
          where: { idempotencyKey },
          include: { recipes: true },
        });
        if (existing) return Response.json(templateView(existing, existing.recipes), { status: 200 });
      }
      throw err;
    }

    await audit(auth.tenantId, auth, 'template.created', 'template', created.id, {
      name: created.name,
      version: created.version,
      status: created.status,
      checklistItems: parsed.manifest.captureChecklist.length,
      sceneRecipes: parsed.scenes.length,
      stylePresets: parsed.manifest.stylePresets.length,
    });
    await emitEvent(auth.tenantId, 'template.created', 'template', created.id, {
      templateId: created.id,
      name: created.name,
      version: created.version,
      status: created.status,
      sceneRecipes: parsed.scenes.length,
    });

    return Response.json(templateView(created, created.recipes), { status: 201 });
  });
}
