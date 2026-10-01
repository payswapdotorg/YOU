// GET /api/v1/renders/:id — render job detail; artifact (when present)
// carries a FRESH signed URL.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, notFound } from '@/lib/you/core/errors';
import { renderJobView } from '@/lib/you/core/views';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const render = await db.renderJob.findFirst({ where: { id, tenantId: auth.tenantId } });
    if (!render) throw notFound(`render job "${id}" not found`);

    const artifact = render.artifactId
      ? await db.outputArtifact.findUnique({ where: { id: render.artifactId } })
      : null;

    return Response.json(renderJobView(render, artifact));
  });
}
