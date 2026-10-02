// GET /api/v1/health — liveness + readiness (P6.A7).
//
// UNAUTHENTICATED BY DESIGN: uptime checks and load-balancer probes must not
// burn sessions or trip rate limits. Returns:
//   200 {"status":"ok","db":"ok","uptimeSeconds":N,"version":<git sha or dev>}
//   503 {"status":"degraded","db":"unreachable", ...}  (honest readiness)
// No secrets, no counts, no tenant data — a probe, not an intelligence leak.
import { db } from '@/lib/db';

export async function GET(): Promise<Response> {
  const started = Date.now();
  let dbState = 'ok';
  try {
    await db.$queryRaw`SELECT 1`;
  } catch (err) {
    dbState = err instanceof Error ? `unreachable: ${err.message.slice(0, 120)}` : 'unreachable';
  }
  const body = {
    status: dbState === 'ok' ? 'ok' : 'degraded',
    db: dbState,
    uptimeSeconds: Math.round(process.uptime()),
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? process.env.YOU_VERSION ?? 'dev',
    checkedAt: new Date().toISOString(),
  };
  return Response.json(body, {
    status: dbState === 'ok' ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  });
}
