// GET  /api/v1/renders — render jobs (newest first)
// POST /api/v1/renders — validate twin+version, consent "render", create
// RenderJob row + durable render.image/render.video job. Returns {jobId}.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { requireConsent } from '@/lib/you/core/consent';
import { badRequest, getIdempotencyKey, handleRoute, notFound, readJsonBody } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { createJob } from '@/lib/you/core/jobs';
import { renderJobView } from '@/lib/you/core/views';
import type { JobKind, RenderStyle } from '@/lib/you/contracts';

const RENDER_STYLES: RenderStyle[] = [
  'photorealistic', 'anime', 'cartoon', 'low-poly', 'game', 'illustration', 'stylized-portrait',
];

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const renders = await db.renderJob.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'desc' },
    });
    const views = await Promise.all(
      renders.map(async (r) => {
        const artifact = r.artifactId
          ? await db.outputArtifact.findUnique({ where: { id: r.artifactId } })
          : null;
        return renderJobView(r, artifact);
      }),
    );
    return Response.json(views);
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const body = await readJsonBody(request);

    const twinId = typeof body.twinId === 'string' ? body.twinId : '';
    const twinVersionId = typeof body.twinVersionId === 'string' ? body.twinVersionId : '';
    if (!twinId || !twinVersionId) throw badRequest('twinId and twinVersionId are required');

    const kind = body.kind;
    if (kind !== 'image' && kind !== 'video') throw badRequest('kind must be "image" or "video"');

    if (typeof body.style !== 'string' || !RENDER_STYLES.includes(body.style as RenderStyle)) {
      throw badRequest(`style must be one of: ${RENDER_STYLES.join(', ')}`);
    }
    const style = body.style as RenderStyle;

    let adapter: string | null = null;
    if (body.adapter !== undefined && body.adapter !== null) {
      if (typeof body.adapter !== 'string' || !body.adapter.trim()) throw badRequest('adapter must be a non-empty string');
      adapter = body.adapter.trim().slice(0, 64);
    }

    let performanceId: string | null = null;
    if (body.performanceId !== undefined && body.performanceId !== null) {
      if (typeof body.performanceId !== 'string') throw badRequest('performanceId must be a string');
      const performance = await db.performance.findFirst({
        where: { id: body.performanceId, tenantId: auth.tenantId },
      });
      if (!performance) throw badRequest(`performance "${body.performanceId}" not found`);
      performanceId = performance.id;
    }

    const twin = await db.twin.findFirst({ where: { id: twinId, tenantId: auth.tenantId } });
    if (!twin) throw notFound(`twin "${twinId}" not found`);
    const twinVersion = await db.twinVersion.findFirst({ where: { id: twinVersionId, twinId: twin.id } });
    if (!twinVersion) throw notFound(`twin version "${twinVersionId}" not found for this twin`);

    // server-enforced consent: rendering requires the render scope
    const grant = await requireConsent(auth.tenantId, twin.subjectId, 'render');

    const renderJob = await db.renderJob.create({
      data: {
        tenantId: auth.tenantId,
        twinId: twin.id,
        twinVersionId: twinVersion.id,
        performanceId,
        kind,
        style,
        adapterId: adapter,
        status: 'queued',
      },
    });

    const jobKind: JobKind = kind === 'video' ? 'render.video' : 'render.image';
    const job = await createJob(
      auth.tenantId,
      jobKind,
      {
        renderJobId: renderJob.id,
        twinId: twin.id,
        twinVersionId: twinVersion.id,
        performanceId,
        style,
        adapter,
        subjectId: twin.subjectId,
        consentGrantId: grant.id,
      },
      getIdempotencyKey(request),
    );

    await audit(auth.tenantId, auth, 'render.created', 'render_job', renderJob.id, {
      jobId: job.id,
      twinId: twin.id,
      twinVersionId: twinVersion.id,
      kind,
      style,
      adapter,
      consentGrantId: grant.id,
    });
    await emitEvent(auth.tenantId, 'render.created', 'render_job', renderJob.id, {
      renderJobId: renderJob.id,
      jobId: job.id,
      twinId: twin.id,
      kind,
      style,
    });

    return Response.json({ jobId: job.id }, { status: 202 });
  });
}
