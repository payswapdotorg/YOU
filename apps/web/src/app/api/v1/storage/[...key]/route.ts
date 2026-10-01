// GET /api/v1/storage/[...key]?exp=&sig= — capability-constrained object access.
// NO auth: a valid signature (hmac-sha256 over key + '.' + exp with
// YOU_STORAGE_SECRET) IS the capability. 403 on bad/expired sig, 404 missing.
import { getObject, mimeFromKey, verifyStorageSig } from '@/lib/you/core/storage';
import { handleRoute, jsonError, badRequest } from '@/lib/you/core/errors';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  return handleRoute(async () => {
    const { key: segments } = await params;
    const key = segments.join('/');

    const url = new URL(request.url);
    const exp = url.searchParams.get('exp') ?? '';
    const sig = url.searchParams.get('sig') ?? '';
    if (!exp || !sig) {
      return jsonError('forbidden', 'missing exp/sig capability parameters', 403);
    }
    if (!verifyStorageSig(key, exp, sig)) {
      return jsonError('forbidden', 'invalid or expired signature', 403);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(key)) {
      throw badRequest('malformed storage key');
    }

    const buf = await getObject(key);
    if (!buf) return jsonError('not_found', `object "${key}" not found`, 404);

    return new Response(new Uint8Array(buf), {
      headers: {
        'content-type': mimeFromKey(key),
        'content-length': String(buf.byteLength),
        'cache-control': 'private, no-transform, max-age=300',
      },
    });
  });
}
