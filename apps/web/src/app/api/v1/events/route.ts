// GET /api/v1/events?type=&limit= — EventRecordView[] (payload parsed,
// newest first, default limit 50)
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute } from '@/lib/you/core/errors';
import { eventView } from '@/lib/you/core/views';

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const url = new URL(request.url);

    const type = url.searchParams.get('type')?.trim() || undefined;
    let limit = 50;
    const rawLimit = url.searchParams.get('limit');
    if (rawLimit !== null) {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
        limit = 50;
      } else {
        limit = parsed;
      }
    }

    const events = await db.eventRecord.findMany({
      where: { tenantId: auth.tenantId, ...(type ? { type } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return Response.json(events.map(eventView));
  });
}
