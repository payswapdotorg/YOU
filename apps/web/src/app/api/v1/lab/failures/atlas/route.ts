// GET /api/v1/lab/failures/atlas — P6.C11 Failure Atlas production surface:
// aggregation by code, region, pipeline, technology version and time window —
// counts + confidence rollups + top suspected causes + the recorded policy
// decisions (enforced vs proposed) per class — over REAL recorded cases only.
// Query params: from / to (inclusive ISO bounds on createdAt; invalid values
// are honest 400s), topCauses (1..10, default 3).
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, jsonError } from '@/lib/you/core/errors';
import { aggregateAtlas, type AtlasCase } from '@/lib/you/lab/failure-codes';
import { parseJson } from '@/lib/you/core/views';
import { ERR } from '@/lib/you/contracts';

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    await requireApiAuth(request);
    const url = new URL(request.url);

    const parseBound = (name: string): string | null | 'invalid' => {
      const raw = url.searchParams.get(name);
      if (raw === null || raw.trim() === '') return null;
      const trimmed = raw.trim();
      if (Number.isNaN(Date.parse(trimmed))) return 'invalid';
      return new Date(trimmed).toISOString();
    };
    const from = parseBound('from');
    if (from === 'invalid') {
      return jsonError(ERR.VALIDATION, `query parameter "from" is not a parseable date (got "${url.searchParams.get('from')}")`, 400);
    }
    const to = parseBound('to');
    if (to === 'invalid') {
      return jsonError(ERR.VALIDATION, `query parameter "to" is not a parseable date (got "${url.searchParams.get('to')}")`, 400);
    }
    let topCauses = 3;
    const rawTop = url.searchParams.get('topCauses');
    if (rawTop !== null && rawTop.trim() !== '') {
      const num = Number(rawTop);
      if (!Number.isInteger(num) || num < 1 || num > 10) {
        return jsonError(ERR.VALIDATION, 'query parameter "topCauses" must be an integer 1..10', 400);
      }
      topCauses = num;
    }

    const rows = await db.failureCase.findMany({ orderBy: { createdAt: 'desc' } });
    const cases: AtlasCase[] = rows.map((f) => ({
      id: f.id,
      code: f.code ?? 'UNCLASSIFIED',
      inputConditions: parseJson<Record<string, unknown>>(f.inputConditions, {}),
      payload: parseJson<Record<string, unknown>>(f.payload ?? '{}', {}),
      pipeline: parseJson<Record<string, unknown>>(f.pipeline, {}),
      technologyVersions: parseJson<unknown[]>(f.technologyVersions, []),
      suspectedCause: f.suspectedCause,
      confidence: f.confidence,
      status: f.status ?? 'open',
      createdAt: f.createdAt.toISOString(),
    }));

    return Response.json(aggregateAtlas(cases, { from, to, topCauses }));
  });
}
