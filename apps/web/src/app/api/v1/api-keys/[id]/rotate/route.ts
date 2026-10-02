// POST /api/v1/api-keys/:id/rotate — rotate the secret IN PLACE (P6.A3).
//
// Rotation semantics: the key row keeps its id, name and scopes; a fresh
// secret is issued and its hash+prefix replace the stored ones, so the OLD
// secret dies at the same instant the new one is born (no overlap window,
// no second row). The new secret is returned exactly once — same contract
// as creation. Revoked keys cannot be rotated (revocation is terminal —
// create a new key instead).
import { randomBytes } from 'crypto';
import { db } from '@/lib/db';
import { requireApiAuth, sha256hex } from '@/lib/you/core/auth';
import { conflict, handleRoute, notFound } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { apiKeyView } from '@/lib/you/core/views';
import { enforceRateLimit } from '@/lib/you/core/ratelimit';

function newApiSecret(): string {
  // 32 random bytes → 43 url-safe base64 chars (no padding) — same shape as creation
  return `you_sk_${randomBytes(32).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;

    enforceRateLimit('api-key-mutation', auth.tenantId); // P6.A6 interim: secret-issuing surface

    const key = await db.apiKey.findFirst({ where: { id, tenantId: auth.tenantId } });
    if (!key) throw notFound(`api key "${id}" not found`);
    if (key.revokedAt) throw conflict(`api key "${id}" is revoked — revocation is terminal; create a new key instead`);

    const secret = newApiSecret();
    const rotated = await db.apiKey.update({
      where: { id: key.id },
      data: {
        hash: sha256hex(secret),
        prefix: secret.slice(0, 14),
      },
    });

    await audit(auth.tenantId, auth, 'key.rotated', 'api_key', key.id, { name: key.name });
    await emitEvent(auth.tenantId, 'key.rotated', 'api_key', key.id, { keyId: key.id, name: key.name });

    // the new secret is returned exactly once — only its sha256 is persisted
    return Response.json({ key: apiKeyView(rotated), secret }, { status: 201 });
  });
}
