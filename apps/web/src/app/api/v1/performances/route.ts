// GET  /api/v1/performances — list
// POST /api/v1/performances — create a minimal performance directly
//      (origin 'text', tracks from body if provided). API_CONTRACTS lists
//      POST /performances; the studio client uses from-text for jobs.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { badRequest, handleRoute, readJsonBody, reqString, optString } from '@/lib/you/core/errors';
import { emitEvent } from '@/lib/you/core/events';
import { performanceView } from '@/lib/you/core/views';
import type { PerformanceTrack } from '@/lib/you/contracts';

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const performances = await db.performance.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return Response.json(performances.map(performanceView));
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const body = await readJsonBody(request);

    const name = reqString(body, 'name', { max: 160 });
    const script = optString(body, 'script');

    let twinId: string | null = null;
    if (body.twinId !== undefined && body.twinId !== null) {
      if (typeof body.twinId !== 'string') throw badRequest('twinId must be a string');
      const twin = await db.twin.findFirst({ where: { id: body.twinId, tenantId: auth.tenantId } });
      if (!twin) throw badRequest(`twin "${body.twinId}" not found`);
      twinId = twin.id;
    }

    let tracks: PerformanceTrack[] = [];
    if (body.tracks !== undefined && body.tracks !== null) {
      if (!Array.isArray(body.tracks)) throw badRequest('tracks must be an array of performance tracks');
      tracks = body.tracks as PerformanceTrack[];
    }

    let durationMs: number | null = null;
    if (body.durationMs !== undefined && body.durationMs !== null) {
      if (typeof body.durationMs !== 'number' || !Number.isFinite(body.durationMs) || body.durationMs < 0) {
        throw badRequest('durationMs must be a non-negative number');
      }
      durationMs = Math.round(body.durationMs);
    }

    const performance = await db.performance.create({
      data: {
        tenantId: auth.tenantId,
        twinId,
        name,
        origin: 'text',
        durationMs,
        tracks: JSON.stringify(tracks),
        script: script ?? null,
      },
    });

    await emitEvent(auth.tenantId, 'performance.created', 'performance', performance.id, {
      performanceId: performance.id,
      name,
      origin: 'text',
    });

    return Response.json(performanceView(performance), { status: 201 });
  });
}
