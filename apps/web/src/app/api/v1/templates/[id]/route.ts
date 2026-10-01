// GET /api/v1/templates/:id — template view (manifest, scene recipes, last
// analyze output). Tenant-scoped; 404 for other tenants' templates.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, notFound } from '@/lib/you/core/errors';
import { templateView } from '@/lib/you/core/templates';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const template = await db.template.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { recipes: true },
    });
    if (!template) throw notFound(`template "${id}" not found`);
    return Response.json(templateView(template, template.recipes));
  });
}
