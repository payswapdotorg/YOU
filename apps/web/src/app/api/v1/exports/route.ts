// POST /api/v1/exports — create a game/AR export (P6.C9).
//
// Validates twin + twinVersion (tenant-scoped) and the export options
// (format glb|vrm, lodLevel 0|1|2, includeFacialControls), enforces
// RECONSTRUCT consent server-side (an export reconstructs the twin's HTIR
// geometry into a new engine representation — the reconstruct scope law),
// creates the ExportJob row, then submits the durable `export.glb`/`export.vrm`
// job through the jobs seam (tenant-scoped, idempotent via x-idempotency-key
// — createJob dedupes on the key; a replay returns the ORIGINAL ids).
// Returns 202 { jobId, exportJobId }.
//
// WITHOUT usable HTIR geometry the JOB fails honestly at its geometry step
// with the verbatim fail-closed reason (never a default body pretending to
// be this twin); the create itself still succeeds — the honest refusal is a
// job outcome, not a hidden rejection.
//
// ENGINE INTEGRATION SURFACE (documented minimal shape — no fake plugins):
//   1. POST /api/v1/exports { twinId, twinVersionId, format, lodLevel,
//      includeFacialControls } → { jobId, exportJobId };
//   2. poll GET /api/v1/exports/{id} until status=succeeded;
//   3. read the artifact view: the GLB/VRM binary (signed URL) + the
//      machine-readable retargeting mapping table + the structural-vs-derived
//      manifest + the package manifest whose README states exactly what is
//      and is NOT included (no Unity prefab, no Unreal plugin, no scripts).
//
// GET /api/v1/exports — list export jobs (newest first, bounded), each with
// the honest-claims text (contract field on every surface).
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { requireConsent } from '@/lib/you/core/consent';
import {
  badRequest,
  handleRoute,
  getIdempotencyKey,
  HttpError,
  notFound,
  readJsonBody,
} from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { createJob } from '@/lib/you/core/jobs';
import { decideCreateExport, exportJobKindFor } from '@/lib/you/adapters/game-export';
import { exportJobSummaryView } from '@/lib/you/export/views';
import { parseJson } from '@/lib/you/core/views';

const LIST_LIMIT = 100;

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const rows = await db.exportJob.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
      include: { twin: true },
    });
    // list surface: summaries with the contract claims text; the full
    // manifest/mapping/package views live on the detail route (the artifact
    // is only assembled when the export completed — never fabricated here)
    const views = rows.map((row) =>
      exportJobSummaryView({
        job: row,
        twinDisplayName: row.twin?.displayName ?? null,
        manifest: null,
      }),
    );
    return Response.json(views);
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const body = await readJsonBody(request);

    // tenant-scoped row loads, then the pure route-decision fold (the exact
    // validate → scope → consent → replay order the fold encodes; the fold
    // is the same code the contract tests exercise)
    const twinRow = body.twinId
      ? await db.twin.findFirst({ where: { id: String(body.twinId), tenantId: auth.tenantId } })
      : null;
    const twinVersionRow =
      twinRow && body.twinVersionId
        ? await db.twinVersion.findFirst({ where: { id: String(body.twinVersionId), twinId: twinRow.id } })
        : null;
    const idem = getIdempotencyKey(request);
    const existingJob = idem ? await db.job.findUnique({ where: { idempotencyKey: idem } }) : null;
    const grants = twinRow
      ? await db.consentGrant.findMany({
          where: { tenantId: auth.tenantId, subjectId: twinRow.subjectId, revokedAt: null, expiresAt: { gt: new Date() } },
        })
      : [];

    const decision = decideCreateExport({
      body: {
        twinId: body.twinId,
        twinVersionId: body.twinVersionId,
        format: body.format,
        lodLevel: body.lodLevel,
        includeFacialControls: body.includeFacialControls,
      },
      twin: twinRow ? { id: twinRow.id, tenantId: twinRow.tenantId, subjectId: twinRow.subjectId } : null,
      twinVersion: twinVersionRow ? { id: twinVersionRow.id, twinId: twinVersionRow.twinId } : null,
      tenantId: auth.tenantId,
      idempotencyKey: idem,
      existingJob: existingJob
        ? {
            id: existingJob.id,
            kind: existingJob.kind,
            input: parseJson<Record<string, unknown>>(existingJob.input, {}),
          }
        : null,
      activeGrants: grants.map((g) => ({
        id: g.id,
        scopes: parseJson<string[]>(g.scopes, []),
        revokedAt: g.revokedAt,
        expiresAt: g.expiresAt,
      })),
    });

    if (decision.kind === 'error') {
      if (decision.status === 404) throw notFound(decision.message);
      if (decision.status === 403) {
        throw new HttpError(403, 'consent_required', decision.message, {
          subjectId: twinRow?.subjectId,
          scope: 'reconstruct',
          requiredScopes: ['reconstruct'],
        });
      }
      throw badRequest(decision.message);
    }
    if (decision.kind === 'replay') {
      // the C8 law: an idempotent replay returns the ORIGINAL ids — never a
      // second ExportJob row (the jobs seam would dedupe the durable job,
      // leaving an orphan row pointing at it)
      return Response.json(
        { jobId: decision.jobId, exportJobId: decision.exportJobId, idempotentReplay: true },
        { status: 202 },
      );
    }

    const input = decision.input;
    const twinId = twinRow!.id;
    const twinVersionId = twinVersionRow!.id;

    // server-enforced consent (the fold already verified a covering grant;
    // requireConsent re-checks through the canonical seam for the grant ref)
    const grant = await requireConsent(auth.tenantId, twinRow!.subjectId, 'reconstruct');

    const exportJob = await db.exportJob.create({
      data: {
        tenantId: auth.tenantId,
        twinId,
        twinVersionId,
        format: input.format,
        lodLevel: input.lodLevel,
        includeFacialControls: input.includeFacialControls,
        status: 'queued',
      },
    });

    // the durable job — the jobs seam (tenant-scoped, idempotent by key).
    // Failure inside the job (e.g. the fail-closed geometry gate) lands on
    // BOTH the Job row and the ExportJob row verbatim.
    const job = await createJob(
      auth.tenantId,
      exportJobKindFor(input.format),
      {
        exportJobId: exportJob.id,
        twinId,
        twinVersionId,
        format: input.format,
        lodLevel: input.lodLevel,
        includeFacialControls: input.includeFacialControls,
        subjectId: twinRow!.subjectId,
        consentGrantId: grant.id,
      },
      idem,
    );
    await db.exportJob.update({ where: { id: exportJob.id }, data: { jobId: job.id } }).catch(() => undefined);

    await audit(auth.tenantId, auth, 'export.created', 'exportJob', exportJob.id, {
      jobId: job.id,
      twinId,
      twinVersionId,
      format: input.format,
      lodLevel: input.lodLevel,
      includeFacialControls: input.includeFacialControls,
      consentGrantId: grant.id,
    });
    await emitEvent(auth.tenantId, 'export.created', 'exportJob', exportJob.id, {
      exportJobId: exportJob.id,
      jobId: job.id,
      twinId,
      twinVersionId,
      format: input.format,
      lodLevel: input.lodLevel,
    });

    return Response.json({ jobId: job.id, exportJobId: exportJob.id }, { status: 202 });
  });
}
