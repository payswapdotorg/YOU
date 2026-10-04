// GET /api/v1/lab/runs/:id/compare?baseline={id} — P6.C11 run comparison +
// regression detection: stage-level metric diff between two runs (same world
// seed REQUIRED, else 400 with a clear error), per-organization regression
// flags against configurable thresholds (defaults documented), and a
// machine-readable verdict. This is the evidence the C10 promotion gates can
// cite. Enforcement order exactly as the decideCompareRuns fold: 401 → 403
// (read scope) → 404 → 400 (missing baseline / cross-seed) → compare.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, jsonError } from '@/lib/you/core/errors';
import { compareRuns, decideCompareRuns, parseThresholdOverrides, REGRESSION_THRESHOLD_DOCS, type CompareRunInput } from '@/lib/you/lab/run-manifest';
import { parseJson } from '@/lib/you/core/views';
import { ERR } from '@/lib/you/contracts';

async function loadRunForCompare(id: string): Promise<CompareRunInput | null> {
  const run = await db.benchmarkRun.findUnique({
    where: { id },
    include: { reports: { orderBy: { createdAt: 'asc' } } },
  });
  if (!run) return null;
  const objective = await db.labObjective.findUnique({ where: { id: run.objectiveId } });
  return {
    id: run.id,
    worldSeed: run.worldSeed,
    objectiveCode: objective?.code ?? '',
    reports: run.reports.map((r) => {
      const detail = parseJson<Record<string, unknown>>(r.detail, {});
      return {
        organizationId: r.organizationId,
        scores: parseJson<Record<string, number>>(r.scores, {}),
        detail: {
          perStage: Array.isArray(detail.perStage)
            ? (detail.perStage as Array<Record<string, unknown>>).map((s) => ({
                adapterId: String(s.adapterId ?? ''),
                role: String(s.role ?? ''),
                modeledLatencyMs: typeof s.modeledLatencyMs === 'number' ? s.modeledLatencyMs : 0,
                modeledCostUsd: typeof s.modeledCostUsd === 'number' ? s.modeledCostUsd : 0,
                ...(typeof s.observedLatencyMs === 'number' ? { observedLatencyMs: s.observedLatencyMs } : {}),
              }))
            : [],
        },
      };
    }),
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const url = new URL(request.url);

    const thresholdParse = parseThresholdOverrides(url.searchParams);
    if (!thresholdParse.ok) {
      return jsonError(ERR.VALIDATION, thresholdParse.message, 400);
    }

    const run = await loadRunForCompare(id);
    const baselineParam = url.searchParams.get('baseline');
    const baselineRun = baselineParam ? await loadRunForCompare(baselineParam) : null;

    const decision = decideCompareRuns({
      auth: {
        tenantId: auth.tenantId,
        actorType: auth.actorType,
        actorId: auth.actorId,
        scopes: auth.scopes,
      },
      runId: id,
      baselineParam,
      run,
      baselineRun,
      thresholdOverrides: thresholdParse.thresholds,
    });

    if (decision.kind === 'error') {
      return jsonError(decision.code, decision.message, decision.status);
    }

    const comparison = compareRuns(decision.baseline, decision.candidate, decision.thresholds);
    return Response.json({
      ...comparison,
      thresholds: {
        ...comparison.thresholds,
        docs: REGRESSION_THRESHOLD_DOCS,
      },
    });
  });
}
