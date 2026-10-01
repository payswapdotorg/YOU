// GET /api/v1/lab/promotions — PromotionRecordView[] (evidence parsed)
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute } from '@/lib/you/core/errors';
import { promotionRecordView } from '@/lib/you/core/views';

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    await requireApiAuth(request);
    const promotions = await db.promotionRecord.findMany({ orderBy: { createdAt: 'desc' } });
    return Response.json(promotions.map(promotionRecordView));
  });
}
