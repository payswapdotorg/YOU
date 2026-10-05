// GET /api/v1/lab/capture-requests — the Capture Scientist queue (P6.C10):
// the Lab's own evidence requests (source='lab'), newest first, with their
// real status. TENANT-SCOPED (the requests live in the caller's tenant —
// fulfillment is a real capture there). Every row is a real derived request —
// the honest empty state shows when the Lab has none.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute } from '@/lib/you/core/errors';
import { evidenceRequestView } from '@/lib/you/core/views';

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);

    const url = new URL(request.url);
    const status = url.searchParams.get('status')?.trim() || undefined;

    const requests = await db.evidenceRequest.findMany({
      where: {
        tenantId: auth.tenantId,
        source: 'lab',
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    return Response.json(requests.map(evidenceRequestView));
  });
}
