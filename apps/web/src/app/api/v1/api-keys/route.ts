// GET  /api/v1/api-keys — list (never secrets)
// POST /api/v1/api-keys — create: secret `you_sk_` + 43 url-safe chars,
// sha256 stored, secret returned ONCE.
import { randomBytes } from 'crypto';
import { db } from '@/lib/db';
import { requireApiAuth, sha256hex } from '@/lib/you/core/auth';
import { badRequest, handleRoute, readJsonBody, reqString, reqStringArray } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { apiKeyView } from '@/lib/you/core/views';
import { enforceRateLimit } from '@/lib/you/core/ratelimit';

const KEY_SCOPES = ['read', 'write'];

function newApiSecret(): string {
  // 32 random bytes → 43 url-safe base64 chars (no padding)
  return `you_sk_${randomBytes(32).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const keys = await db.apiKey.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return Response.json(keys.map(apiKeyView));
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const body = await readJsonBody(request);

    enforceRateLimit('api-key-mutation', auth.tenantId); // P6.A6 interim: secret-issuing surface

    const name = reqString(body, 'name', { max: 120 });
    const scopes = reqStringArray(body, 'scopes');
    if (scopes.some((s) => !KEY_SCOPES.includes(s))) {
      throw badRequest(`scopes must be a non-empty subset of [${KEY_SCOPES.join(', ')}]`);
    }

    const secret = newApiSecret();
    const key = await db.apiKey.create({
      data: {
        tenantId: auth.tenantId,
        name,
        prefix: secret.slice(0, 14), // e.g. you_sk_ + first 7 payload chars
        hash: sha256hex(secret),
        scopes: JSON.stringify(scopes),
      },
    });

    await audit(auth.tenantId, auth, 'key.created', 'api_key', key.id, { name, scopes });
    await emitEvent(auth.tenantId, 'key.created', 'api_key', key.id, { keyId: key.id, name, scopes });

    // the secret is returned exactly once — only its sha256 is persisted
    return Response.json({ key: apiKeyView(key), secret }, { status: 201 });
  });
}
