// ═══════════════════════════════════════════════════════════════════════════
// YOU core — consent enforcement (Worker A lane)
// Consent is explicit, scoped, revocable and SERVER-ENFORDED. No endpoint
// bypasses requireConsent: capture upload (capture), twin compile
// (reconstruct), renders (render), agent avatar sessions with a twin
// (embodiment). Grants are never deleted — only revoked.
// ═══════════════════════════════════════════════════════════════════════════
import type { ConsentGrant } from '@prisma/client';
import { db } from '@/lib/db';
import type { ConsentScope } from '../contracts';
import { consentRequired } from './errors';
import { parseJson } from './views';

export const CONSENT_SCOPES: ConsentScope[] = ['capture', 'reconstruct', 'render', 'embodiment'];

export function isValidScopeList(scopes: unknown): scopes is ConsentScope[] {
  return (
    Array.isArray(scopes) &&
    scopes.length > 0 &&
    scopes.every((s) => typeof s === 'string' && (CONSENT_SCOPES as string[]).includes(s))
  );
}

function grantCovers(grant: ConsentGrant, scope: ConsentScope): boolean {
  if (grant.revokedAt) return false;
  if (grant.expiresAt.getTime() <= Date.now()) return false;
  return parseJson<string[]>(grant.scopes, []).includes(scope);
}

/**
 * Throws 403 consent_required unless an active (not revoked, not expired)
 * grant covering `scope` exists for the subject within the tenant.
 * Returns the covering grant when found.
 */
export async function requireConsent(
  tenantId: string,
  subjectId: string,
  scope: ConsentScope,
): Promise<ConsentGrant> {
  const grants = await db.consentGrant.findMany({
    where: { tenantId, subjectId, revokedAt: null, expiresAt: { gt: new Date() } },
  });
  const covering = grants.find((g) => grantCovers(g, scope));
  if (!covering) {
    throw consentRequired(
      `no active consent grant with scope "${scope}" for subject ${subjectId} — grant or renew consent first`,
      { subjectId, scope, requiredScopes: [scope] },
    );
  }
  return covering;
}

export async function hasConsent(tenantId: string, subjectId: string, scope: ConsentScope): Promise<boolean> {
  try {
    await requireConsent(tenantId, subjectId, scope);
    return true;
  } catch {
    return false;
  }
}
