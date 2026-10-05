// GET  /api/v1/renders — render jobs (newest first)
// POST /api/v1/renders — validate twin+version, consent "render", create
// RenderJob row, then submit the durable render.image/render.video job
// THROUGH THE COMPUTE BROKER (P6.C3: submitComputeRouted — enable-list
// routing, per-provider breaker admission, the cost-budget guard (P6.C12
// PR-13: db-backed tenant/application/pipeline budgets with env/default
// fail-closed fallback), routing record + quote embedded in the durable
// job). Returns {jobId}.
//
// Broker-refusal envelopes (honest, mapped):
//   402 compute_quota_exceeded    — the cost-budget guard refused the submit
//                                   (CostBudget rows > YOU_COMPUTE_TENANT_MAX_COST_USD
//                                   > the documented fail-closed default)
//   503 service_unavailable       — the routed provider's breaker is open
//                                   (Retry-After) or no enabled provider could
//                                   serve the workload (every skip reason in
//                                   details)
//   400 validation/quote refusal  — invalid input or an unacceptable quote
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { requireConsent } from '@/lib/you/core/consent';
import { badRequest, getIdempotencyKey, handleRoute, HttpError, notFound, readJsonBody, serviceUnavailable } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { ComputeQuotaExceededError, ComputeRoutingRefusedError, submitComputeRouted } from '@/lib/you/lab/compute';
import { ProviderUnavailableError } from '@/lib/you/core/circuit-breaker';
import { renderJobView } from '@/lib/you/core/views';
import type { RenderStyle } from '@/lib/you/contracts';

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

    const jobKind = kind === 'video' ? 'render.video' : 'render.image';
    // P6.C3: the durable job is submitted THROUGH the compute broker (quote →
    // routing → cost guard → createJob with the routing record embedded). The
    // idempotency key keeps its exact createJob semantics (broker-submitted
    // jobs embed __compute BEFORE the row is created, so the dedupe window is
    // identical — an idempotent replay returns the original job unchanged).
    // A broker refusal (quota / routing / breaker / unacceptable quote) marks
    // the RenderJob row FAILED with the verbatim refusal — an attempted render
    // that never ran is never left "queued forever".
    let submitted: Awaited<ReturnType<typeof submitComputeRouted>>;
    try {
      submitted = await submitComputeRouted({
        workload: jobKind,
        tenantId: auth.tenantId,
        adapter: adapter ?? undefined,
        // P6.C12 (PR-13): application-scoped budgets + accrual — the API key
        // actor id when the submit is application-authenticated
        applicationActorId: auth.actorType === 'application' ? auth.actorId : undefined,
        input: {
          renderJobId: renderJob.id,
          twinId: twin.id,
          twinVersionId: twinVersion.id,
          performanceId,
          style,
          adapter,
          subjectId: twin.subjectId,
          consentGrantId: grant.id,
        },
        idempotencyKey: getIdempotencyKey(request),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.renderJob
        .update({
          where: { id: renderJob.id },
          data: { status: 'failed', error: `compute broker refused the submit: ${message}`, finishedAt: new Date() },
        })
        .catch(() => undefined);
      if (err instanceof ComputeQuotaExceededError) {
        // 402 — the cost guard refused the submit (fail-closed, observable in
        // /api/v1/metrics as compute_quota_refusals{workload})
        throw new HttpError(402, err.code, err.message, err.details);
      }
      if (err instanceof ProviderUnavailableError) {
        // honest degraded 503 with retry guidance (the A6-FULL route law)
        const retryAfter = Math.max(1, Math.ceil((err.retryAfterMs ?? 1000) / 1000));
        throw serviceUnavailable(err.message, { provider: err.provider, breakerState: err.breakerState }, { 'retry-after': String(retryAfter) });
      }
      if (err instanceof ComputeRoutingRefusedError) {
        // no enabled provider could serve the workload — every skip reason disclosed
        throw serviceUnavailable(err.message, err.details);
      }
      if (message.startsWith('compute_refused:') || message.startsWith('validation_failed:')) {
        // an unacceptable quote or invalid broker input is a client-side refusal
        throw badRequest(message);
      }
      throw err;
    }
    const job = { id: submitted.jobId };

    await audit(auth.tenantId, auth, 'render.created', 'render_job', renderJob.id, {
      jobId: job.id,
      twinId: twin.id,
      twinVersionId: twinVersion.id,
      kind,
      style,
      adapter,
      consentGrantId: grant.id,
      computeProviderId: submitted.providerId,
      computeRoutedVia: submitted.routedVia,
    });
    await emitEvent(auth.tenantId, 'render.created', 'render_job', renderJob.id, {
      renderJobId: renderJob.id,
      jobId: job.id,
      twinId: twin.id,
      kind,
      style,
      computeProviderId: submitted.providerId,
    });

    return Response.json({ jobId: job.id, providerId: submitted.providerId }, { status: 202 });
  });
}
