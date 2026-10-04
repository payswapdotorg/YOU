// GET /api/v1/lab/runs/:id/artifact — P6.C11 artifact export: the full run +
// manifest + per-org evaluations as a downloadable JSON artifact,
// content-addressed (sha256 of the stable-stringified bytes in the
// X-Content-Sha256 response header + ETag). The same run always yields the
// same bytes and therefore the same sha256 (deterministic construction — no
// clocks, no map-iteration order). This is the "benchmark artifacts"
// deliverable of P10. Enforcement order exactly as the decideRunArtifact
// fold: 401 → 403 (read scope) → 404 → artifact bytes.
import { createHash } from 'crypto';
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, jsonError } from '@/lib/you/core/errors';
import { buildRunArtifact, decideRunArtifact } from '@/lib/you/lab/run-manifest';
import { parseJson } from '@/lib/you/core/views';
import { ERR } from '@/lib/you/contracts';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;

    const run = await db.benchmarkRun.findUnique({
      where: { id },
      include: { reports: { orderBy: { createdAt: 'asc' } } },
    });
    const objective = run ? await db.labObjective.findUnique({ where: { id: run.objectiveId } }) : null;

    const decision = decideRunArtifact(
      {
        tenantId: auth.tenantId,
        actorType: auth.actorType,
        actorId: auth.actorId,
        scopes: auth.scopes,
      },
      id,
      run ? { id: run.id, status: run.status } : null,
    );

    if (!('run' in decision)) {
      return jsonError(decision.code, decision.message, decision.status);
    }

    const manifest = parseJson<Record<string, unknown> | null>(run?.manifest ?? '{}', null);
    const { bytes, sha256 } = buildRunArtifact(
      {
        run: {
          id: run!.id,
          objectiveCode: objective?.code ?? '',
          worldSeed: run!.worldSeed,
          status: run!.status,
          createdAt: run!.createdAt.toISOString(),
          rerunOfId: run!.rerunOfId ?? null,
          manifest,
        },
        reports: run!.reports.map((r) => ({
          organizationId: r.organizationId,
          scores: parseJson<Record<string, number>>(r.scores, {}),
          reproducible: r.reproducible,
          seed: r.seed,
          detail: parseJson<Record<string, unknown>>(r.detail, {}),
        })),
        metrics: parseJson<Record<string, unknown> | null>(run!.metrics, null),
      },
      (b) => createHash('sha256').update(b, 'utf8').digest('hex'),
    );

    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="you-benchmark-run-${run!.id}.json"`,
        'x-content-sha256': sha256,
        etag: `"${sha256}"`,
        // honest one-shot hint: re-download of the same run is byte-identical
        'cache-control': 'private, max-age=60',
      },
    });
  });
}
