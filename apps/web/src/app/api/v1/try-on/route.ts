// POST /api/v1/try-on — create a virtual try-on (P6.C8).
//
// Validates twin + twinVersion + garmentAsset (tenant-scoped), enforces
// RENDER consent server-side (a try-on RENDERS the twin — the render scope
// law), creates the TryOnJob row, then submits the durable `tryon.render`
// job through the jobs seam (tenant-scoped, idempotent via x-idempotency-key
// — createJob dedupes on the key). Returns 202 { jobId, tryOnJobId }.
//
// WITHOUT a configured try-on provider the JOB fails honestly at its
// provider step with the verbatim fail-closed reason (never a stub image);
// the create itself still succeeds — the honest unavailability is a job
// outcome, not a hidden refusal.
//
// MERCHANT INTEGRATION SURFACE (documented minimal shape, not a portal):
//   1. POST /api/v1/try-on/garments — upload the product image with its
//      productRef (external product reference) + productUrl;
//   2. POST /api/v1/try-on { twinId, twinVersionId, garmentAssetId } — the
//      product reference rides the garment asset;
//   3. on completion, 'tryon.completed' fans out through the EXISTING signed
//      webhook delivery path (register the callback URL as a
//      WebhookEndpoint subscribing to 'tryon.completed'):
//        X-You-Signature: sha256=HMAC-SHA256(secret, timestamp + '.' + body)
//        X-You-Timestamp: <unix-seconds>
//      with the payload carrying { tryOnJobId, artifactId, productRef,
//      identityChecksPassed, visualOnlyDisclaimer } — everything a merchant
//      callback needs, nothing more.
//
// GET /api/v1/try-on — list try-on jobs (newest first, bounded), each with
// the visual-only disclaimer (contract field on every surface).
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { requireConsent } from '@/lib/you/core/consent';
import { badRequest, getIdempotencyKey, handleRoute, notFound, readJsonBody } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { createJob } from '@/lib/you/core/jobs';
import { validateTryOnInput, TRYON_STYLES } from '@/lib/you/adapters/try-on';
import { toTryOnHttpError, tryOnJobSummaryView } from '@/lib/you/tryon/views';
import { parseJson } from '@/lib/you/core/views';

const LIST_LIMIT = 100;

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const rows = await db.tryOnJob.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
      include: { twin: true, garmentAsset: true },
    });
    const views = await Promise.all(
      rows.map(async (row) => {
        let identityChecksPassed: boolean | null = null;
        if (row.artifactId) {
          const artifact = await db.outputArtifact.findFirst({
            where: { id: row.artifactId, tenantId: auth.tenantId },
          });
          const report = artifact
            ? parseJson<{ identityReport?: { checksPassed?: unknown } }>(artifact.meta, {}).identityReport
            : undefined;
          if (report && typeof report.checksPassed === 'boolean') identityChecksPassed = report.checksPassed;
        }
        return tryOnJobSummaryView({
          job: row,
          twinDisplayName: row.twin?.displayName ?? null,
          garmentDisplayName: row.garmentAsset?.displayName ?? null,
          productRef: row.garmentAsset?.productRef ?? null,
          identityChecksPassed,
        });
      }),
    );
    return Response.json(views);
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const body = await readJsonBody(request);

    let input;
    try {
      input = validateTryOnInput({
        twinId: body.twinId,
        twinVersionId: body.twinVersionId,
        garmentAssetId: body.garmentAssetId,
        style: body.style,
      });
    } catch (err) {
      throw toTryOnHttpError(err);
    }

    const twin = await db.twin.findFirst({ where: { id: input.twinId, tenantId: auth.tenantId } });
    if (!twin) throw notFound(`twin "${input.twinId}" not found`);
    const twinVersion = await db.twinVersion.findFirst({
      where: { id: input.twinVersionId, twinId: twin.id },
    });
    if (!twinVersion) throw notFound(`twin version "${input.twinVersionId}" not found for this twin`);
    const garment = await db.garmentAsset.findFirst({
      where: { id: input.garmentAssetId, tenantId: auth.tenantId },
    });
    if (!garment) throw notFound(`garment asset "${input.garmentAssetId}" not found`);

    // server-enforced consent: a try-on renders the twin → the render scope
    const grant = await requireConsent(auth.tenantId, twin.subjectId, 'render');

    if (!(TRYON_STYLES as readonly string[]).includes(input.style)) {
      // defensive: validateTryOnInput already enforced the union
      throw badRequest(`style must be one of: ${TRYON_STYLES.join(', ')}`);
    }

    // idempotent replay: an existing tryon.render job with this key returns
    // ITS ids — a replay must not mint a second TryOnJob row (the jobs seam
    // would dedupe the durable job, leaving an orphan row pointing at it)
    const idem = getIdempotencyKey(request);
    if (idem) {
      const existing = await db.job.findUnique({ where: { idempotencyKey: idem } });
      if (existing && existing.kind === 'tryon.render') {
        const existingInput = parseJson<{ tryOnJobId?: string }>(existing.input, {});
        if (existingInput.tryOnJobId) {
          return Response.json(
            { jobId: existing.id, tryOnJobId: existingInput.tryOnJobId, idempotentReplay: true },
            { status: 202 },
          );
        }
      }
    }

    const tryOnJob = await db.tryOnJob.create({
      data: {
        tenantId: auth.tenantId,
        twinId: twin.id,
        twinVersionId: twinVersion.id,
        garmentAssetId: garment.id,
        style: input.style,
        status: 'queued',
      },
    });

    // the durable job — the jobs seam (tenant-scoped, idempotent by key).
    // Failure inside the job (e.g. the fail-closed provider gate) lands on
    // BOTH the Job row and the TryOnJob row verbatim.
    const job = await createJob(
      auth.tenantId,
      'tryon.render',
      {
        tryOnJobId: tryOnJob.id,
        twinId: twin.id,
        twinVersionId: twinVersion.id,
        garmentAssetId: garment.id,
        style: input.style,
        subjectId: twin.subjectId,
        consentGrantId: grant.id,
      },
      idem,
    );
    await db.tryOnJob.update({ where: { id: tryOnJob.id }, data: { jobId: job.id } }).catch(() => undefined);

    await audit(auth.tenantId, auth, 'tryon.created', 'tryOnJob', tryOnJob.id, {
      jobId: job.id,
      twinId: twin.id,
      twinVersionId: twinVersion.id,
      garmentAssetId: garment.id,
      style: input.style,
      productRef: garment.productRef,
      consentGrantId: grant.id,
    });
    await emitEvent(auth.tenantId, 'tryon.created', 'tryOnJob', tryOnJob.id, {
      tryOnJobId: tryOnJob.id,
      jobId: job.id,
      twinId: twin.id,
      garmentAssetId: garment.id,
      productRef: garment.productRef,
      style: input.style,
    });

    return Response.json({ jobId: job.id, tryOnJobId: tryOnJob.id }, { status: 202 });
  });
}
