// POST /api/v1/session — bootstrap demo tenant/user + create session (cookie)
// GET  /api/v1/session — SessionInfo from cookie or 401
import { db } from '@/lib/db';
import {
  ensureDemoContext, newSessionToken, sessionCookieHeader, sessionInfo, trySeedLabBaseline,
} from '@/lib/you/core/bootstrap';
import { SESSION_TTL_SECONDS, requireSession } from '@/lib/you/core/auth';
import { handleRoute, unauthorized } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const { tenantId, userId } = await ensureDemoContext();
    await trySeedLabBaseline(); // Worker C seam — never fatal

    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
    const session = await db.session.create({ data: { userId, token, expiresAt } });

    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });

    await audit(tenantId, { actorType: 'user', actorId: userId }, 'session.created', 'session', session.id, {
      userId,
      expiresAt: expiresAt.toISOString(),
    });
    await emitEvent(tenantId, 'session.created', 'session', session.id, { userId });

    return Response.json(sessionInfo(tenant, user), {
      headers: { 'set-cookie': sessionCookieHeader(token) },
    });
  });
}

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireSession(request).catch(() => {
      throw unauthorized('no active session — POST /api/v1/session to create one');
    });
    const user = await db.user.findUnique({ where: { id: auth.userId } });
    if (!user) throw unauthorized('session user no longer exists');
    const tenant = await db.tenant.findUnique({ where: { id: user.tenantId } });
    if (!tenant) throw unauthorized('session tenant no longer exists');
    return Response.json(
      sessionInfo(tenant, { id: user.id, email: user.email, name: user.name, role: user.role }),
    );
  });
}
