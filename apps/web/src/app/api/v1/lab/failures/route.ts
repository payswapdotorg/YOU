// GET /api/v1/lab/failures — FailureCaseView[] (newest first)
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute } from '@/lib/you/core/errors';
import { failureCaseView } from '@/lib/you/core/views';

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    await requireApiAuth(request);
    const failures = await db.failureCase.findMany({ orderBy: { createdAt: 'desc' } });
    return Response.json(failures.map(failureCaseView));
  });
}
