// GET /api/v1/verification-sessions/:id — session view (challenge, submitted
// evidence, result states visible). Lazily transitions an elapsed session to
// "expired" so the durable state never lies about freshness.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, notFound } from '@/lib/you/core/errors';
import { verificationSessionView } from '@/lib/you/core/verification';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    let session = await db.verificationSession.findFirst({ where: { id, tenantId: auth.tenantId } });
    if (!session) throw notFound(`verification session "${id}" not found`);

    if ((session.status === 'pending' || session.status === 'in_review') && session.expiresAt.getTime() <= Date.now()) {
      session = await db.verificationSession.update({
        where: { id: session.id },
        data: { status: 'expired' },
      });
    }

    return Response.json(verificationSessionView(session));
  });
}
