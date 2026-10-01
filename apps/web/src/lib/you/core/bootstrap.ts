// ═══════════════════════════════════════════════════════════════════════════
// YOU core — demo bootstrap (Worker A lane)
// POST /api/v1/session idempotently ensures the demo Tenant/User, creates a
// Session row + httpOnly cookie, then calls seedLabBaseline (TL-owned seam;
// Worker C implements it in parallel — a stub failure must NEVER break
// session creation).
// ═══════════════════════════════════════════════════════════════════════════
import { randomBytes } from 'crypto';
import { db } from '@/lib/db';
import { seedLabBaseline } from '../lab/seed';
import { SESSION_TTL_SECONDS } from './auth';
import type { SessionInfo } from '../contracts';

export const DEMO_TENANT_SLUG = 'demo';
export const DEMO_USER_EMAIL = 'founder@you.dev';

export interface DemoContext {
  tenantId: string;
  userId: string;
}

/** Idempotent demo tenant + user (never throws on repeat calls). */
export async function ensureDemoContext(): Promise<DemoContext> {
  const tenant = await db.tenant.upsert({
    where: { slug: DEMO_TENANT_SLUG },
    create: { slug: DEMO_TENANT_SLUG, name: 'YOU Demo Studio' },
    update: {},
  });
  const user = await db.user.upsert({
    where: { email: DEMO_USER_EMAIL },
    create: { tenantId: tenant.id, email: DEMO_USER_EMAIL, name: 'Studio Founder', role: 'owner' },
    update: {},
  });
  return { tenantId: tenant.id, userId: user.id };
}

/** Seed the lab baseline (Worker C seam) — best-effort, never fatal. */
export async function trySeedLabBaseline(): Promise<{ seeded: true } | { seeded: false; error: string }> {
  try {
    await seedLabBaseline(db);
    return { seeded: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[you/bootstrap] seedLabBaseline failed (non-fatal):', message);
    return { seeded: false, error: message };
  }
}

export function newSessionToken(): string {
  return randomBytes(32).toString('hex'); // 64 hex chars
}

export function sessionCookieHeader(token: string): string {
  return `you_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function sessionInfo(tenant: { id: string; name: string; slug: string }, user: { id: string; email: string; name: string; role: string }): SessionInfo {
  return {
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
  };
}
