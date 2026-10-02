// POST /api/v1/session — bootstrap demo tenant/user + create session (cookie)
// GET  /api/v1/session — SessionInfo from cookie or 401
import { db } from '@/lib/db';
import {
  ensureDemoContext, newSessionToken, sessionCookieHeader, sessionInfo, trySeedLabBaseline,
} from '@/lib/you/core/bootstrap';
import { SESSION_TTL_SECONDS, requireSession } from '@/lib/you/core/auth';
import { handleRoute, unauthorized } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { demoBootstrapEnabled } from '@/lib/you/core/config';
import { serviceUnavailable } from '@/lib/you/core/errors';

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    // P6.A2: the demo bootstrap (auto-provisioned founder@you.dev tenant) is
    // a dev affordance — production requires YOU_DEMO_BOOTSTRAP=1 to opt in.
    if (!demoBootstrapEnabled()) {
      throw serviceUnavailable(
        'demo bootstrap is disabled — provision real users/auth (YOU_DEMO_BOOTSTRAP=1 only for staged demos)',
      );
    }
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
      // request passed for F-03: Secure is appended when x-forwarded-proto is https
      headers: { 'set-cookie': sessionCookieHeader(token, request) },
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
