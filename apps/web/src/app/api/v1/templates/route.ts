// POST /api/v1/templates — register a template (W2.B persistence half).
// Packages a capture checklist, scene recipes and style presets as a versioned
// record. Supports Idempotency-Key (§API rules) with body-fingerprint binding
// (W4.A F-01): a replay with the same key and the SAME body returns the
// existing record (200); a replay with a DIFFERENT body returns
// 409 idempotency_conflict — the stored record is never returned for a
// different payload.
// GET  /api/v1/templates — list templates for the tenant (additive read route
// consistent with the established list-route pattern: GET /twins, /captures…).
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { badRequest, getIdempotencyKey, handleRoute, readJsonBody } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { assertSameBodyFingerprint } from '@/lib/you/core/idempotency';
import {
  parseTemplateBody, TemplateBodyError, templateCreateProjection, templateRowProjection, templateView,
} from '@/lib/you/core/templates';

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
      const existing = await db.template.findUnique({
        where: { idempotencyKey },
        include: { recipes: true },
      });
      if (existing) {
        // F-01: same key + different body → 409 idempotency_conflict; the
        // stored template is never returned for a different payload
        assertSameBodyFingerprint(
          idempotencyKey,
          'template-create body',
          templateRowProjection(existing, existing.recipes),
          templateCreateProjection(parsed),
        );
        return Response.json(templateView(existing, existing.recipes), { status: 200 });
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
      // concurrent duplicate idempotency-key insert → same-body race returns
      // the winner; a different-body race is a 409 conflict (F-01)
      if (idempotencyKey && (err as { code?: string }).code === 'P2002') {
        const existing = await db.template.findUnique({
          where: { idempotencyKey },
          include: { recipes: true },
        });
        if (existing) {
          assertSameBodyFingerprint(
            idempotencyKey,
            'template-create body',
            templateRowProjection(existing, existing.recipes),
            templateCreateProjection(parsed),
          );
          return Response.json(templateView(existing, existing.recipes), { status: 200 });
        }
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
