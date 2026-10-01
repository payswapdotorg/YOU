// GET /api/v1/lab/technologies — TechnologyCandidateView[] (versions parsed)
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute } from '@/lib/you/core/errors';
import { technologyCandidateView } from '@/lib/you/core/views';

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    await requireApiAuth(request);
    const candidates = await db.technologyCandidate.findMany({
      orderBy: { techId: 'asc' },
      include: { versions: { orderBy: { createdAt: 'asc' } } },
    });
    return Response.json(candidates.map((c) => technologyCandidateView(c, c.versions)));
  });
}
