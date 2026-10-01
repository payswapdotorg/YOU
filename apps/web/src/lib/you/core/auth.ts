// ═══════════════════════════════════════════════════════════════════════════
// YOU core — authentication/authorization (Worker A lane)
// Session cookie (httpOnly `you_session`) OR `Authorization: Bearer you_sk_…`
// API key (sha256 hash lookup, revokedAt check, lastUsedAt touch, scope
// enforcement: read → GET/HEAD only, write → everything).
// ═══════════════════════════════════════════════════════════════════════════
import { createHash } from 'crypto';
import { db } from '@/lib/db';
import { parseJson } from './views';
import { unauthorized, forbidden } from './errors';

export const SESSION_COOKIE = 'you_session';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface AuthContext {
  tenantId: string;
  actorType: 'user' | 'application';
  actorId: string; // user id (session) or api key id (bearer)
  userId?: string;
  /** null = interactive session (full studio access); array = api key scopes */
  scopes: string[] | null;
}

export function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

async function sessionContextFromToken(token: string): Promise<AuthContext | null> {
  const session = await db.session.findUnique({ where: { token }, include: { user: true } });
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  return {
    tenantId: session.user.tenantId,
    actorType: 'user',
    actorId: session.userId,
    userId: session.userId,
    scopes: null,
  };
}

/** Session-cookie auth only (used by GET /session and raw-evidence URL signing). */
export async function requireSession(request: Request): Promise<AuthContext> {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) throw unauthorized('no session cookie present');
  const ctx = await sessionContextFromToken(token);
  if (!ctx) throw unauthorized('session is missing or expired');
  return ctx;
}

/**
 * Session cookie OR Bearer API key. Scope rules for keys:
 *  - `read`  allows GET/HEAD only
 *  - `write` allows every method
 */
export async function requireApiAuth(request: Request): Promise<AuthContext> {
  const token = getCookie(request, SESSION_COOKIE);
  if (token) {
    const ctx = await sessionContextFromToken(token);
    if (ctx) return ctx;
  }

  const authorization = request.headers.get('authorization');
  if (authorization && authorization.toLowerCase().startsWith('bearer you_sk_')) {
    const secret = authorization.slice(7).trim();
    if (!secret) throw unauthorized('malformed bearer token');
    const key = await db.apiKey.findUnique({ where: { hash: sha256hex(secret) } });
    if (!key) throw unauthorized('unknown api key');
    if (key.revokedAt) throw unauthorized('api key has been revoked');

    const scopes = parseJson<string[]>(key.scopes, []);
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    const allowsRead = scopes.includes('read') || scopes.includes('write');
    if (isRead ? !allowsRead : !scopes.includes('write')) {
      throw forbidden(`api key lacks the "${isRead ? 'read' : 'write'}" scope required for ${request.method} ${new URL(request.url).pathname}`);
    }

    // best-effort lastUsedAt touch — never fail the request on it
    db.apiKey
      .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    return {
      tenantId: key.tenantId,
      actorType: 'application',
      actorId: key.id,
      scopes,
    };
  }

  throw unauthorized();
}
