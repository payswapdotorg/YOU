// ═══════════════════════════════════════════════════════════════════════════
// YOU core — Cloudflare R2 object storage client (Worker A lane, P6.A1)
//
// Hand-rolled AWS Signature Version 4 against the R2 S3-compatible XML API
// (path-style: https://<account>.r2.cloudflarestorage.com/<bucket>/<key>).
// No aws4fetch dependency — the repo keeps deps lean and the signer is small,
// fully testable, and fixed-vector verifiable.
//
// This module is a byte-store ONLY: keys stay content-addressed and immutable
// by the storage seam above it (core/storage.ts computes `${kind}/${sha256}.${ext}`
// and never overwrites). Capability URLs (signStorageUrl/verifyStorageSig) are
// backend-independent and therefore UNCHANGED — R2 objects are served through
// the same /api/v1/storage route, so the frozen v1 API contract is untouched.
//
// Env (all required when YOU_STORAGE_BACKEND=r2 — fail closed, never guess):
//   YOU_R2_ACCOUNT_ID        — Cloudflare account ID (hex)
//   YOU_R2_ACCESS_KEY_ID      — R2 API token access key
//   YOU_R2_SECRET_ACCESS_KEY  — R2 API token secret
//   YOU_R2_BUCKET             — bucket name
//   YOU_R2_ENDPOINT           — optional full override (default
//                               https://<account>.r2.cloudflarestorage.com);
//                               tests point this at a local S3 mock.
//
// Region is "auto" (R2's documented region for SigV4).
// ═══════════════════════════════════════════════════════════════════════════
import { createHash, createHmac } from 'crypto';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string; // origin only, no trailing slash, no path
}

const R2_REGION = 'auto';
const SERVICE = 's3';

/** Read + validate the R2 env contract. Throws with the missing var names. */
export function r2Config(): R2Config {
  const missing: string[] = [];
  // P6.A6-FULL tsc fix: the old `x || missing.push(...) && ''` idiom typed the
  // values as `string | 0` (push returns number) — same behavior, honest types.
  const envOrMissing = (name: string): string => {
    const v = process.env[name]?.trim();
    if (!v) {
      missing.push(name);
      return '';
    }
    return v;
  };
  const accountId = envOrMissing('YOU_R2_ACCOUNT_ID');
  const accessKeyId = envOrMissing('YOU_R2_ACCESS_KEY_ID');
  const secretAccessKey = envOrMissing('YOU_R2_SECRET_ACCESS_KEY');
  const bucket = envOrMissing('YOU_R2_BUCKET');
  if (missing.length) {
    throw new Error(
      `R2 backend is not configured — missing ${missing.join(', ')} (YOU_STORAGE_BACKEND=r2 requires all four; refusing to guess where bytes live)`,
    );
  }
  const endpoint = (
    process.env.YOU_R2_ENDPOINT?.trim() ||
    `https://${accountId}.r2.cloudflarestorage.com`
  ).replace(/\/+$/, '');
  return { accountId, accessKeyId, secretAccessKey, bucket, endpoint };
}

// ─── SigV4 primitives (exported for fixed-vector tests) ─────────────────────

/** S3 URI-encoding: unreserved chars stay, everything else percent-encodes. */
export function s3UriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const ch of value) {
    if (/[A-Za-z0-9-._~]/.test(ch)) out += ch;
    else if (ch === '/' && !encodeSlash) out += '/';
    else out += '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** Derive the SigV4 signing key: kDate → kRegion → kService → kSigning. */
export function sigv4SigningKey(secret: string, dateStamp: string, region = R2_REGION, service = SERVICE): Buffer {
  return hmac(hmac(hmac(hmac('AWS4' + secret, dateStamp), region), service), 'aws4_request');
}

export interface SigV4Request {
  method: string;
  /** Path with leading '/', already split into raw (unencoded) segments. */
  path: string;
  query?: Record<string, string>;
  headers: Record<string, string>; // keys lowercase; MUST include host
  payload: Buffer;
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>; // original headers + x-amz-* + authorization
  authorization: string;
  amzDate: string;
  contentSha256: string;
}

/** Sign a request per AWS SigV4 (service s3, region auto). */
export function sigv4Sign(req: SigV4Request, cfg: R2Config, now = new Date()): SignedRequest {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20261002T181500Z
  const dateStamp = amzDate.slice(0, 8);
  const contentSha256 = sha256Hex(req.payload);

  // canonical URI: encoded path, slashes preserved
  const canonicalUri = req.path
    .split('/')
    .map((seg) => s3UriEncode(seg))
    .join('/');

  // canonical query: sorted, encoded key=value
  const query = req.query ?? {};
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${s3UriEncode(k)}=${s3UriEncode(query[k])}`)
    .join('&');

  const headers: Record<string, string> = {
    ...req.headers,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': contentSha256,
  };
  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${String(headers[k]).trim()}\n`).join('');
  const signedHeaders = sortedKeys.join(';');

  const canonicalRequest = [
    req.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    contentSha256,
  ].join('\n');

  const scope = `${dateStamp}/${R2_REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signature = createHmac('sha256', sigv4SigningKey(cfg.secretAccessKey, dateStamp)).update(stringToSign, 'utf8').digest('hex');
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const search = canonicalQuery ? `?${canonicalQuery}` : '';
  return {
    url: `${cfg.endpoint}${canonicalUri}${search}`,
    headers,
    authorization,
    amzDate,
    contentSha256,
  };
}

// ─── object operations ───────────────────────────────────────────────────────

function objectUrl(cfg: R2Config, key: string): { path: string; host: string } {
  const u = new URL(cfg.endpoint);
  return { path: `/${cfg.bucket}/${key}`, host: u.host };
}

/**
 * Put an object. S3 PUT on an existing key overwrites — the storage seam's
 * content addressing makes that a no-op semantically (identical bytes), and
 * this module trusts the seam for key construction (never invents keys).
 */
export async function r2PutObject(
  key: string,
  buf: Buffer,
  mime: string,
  cfg: R2Config = r2Config(),
): Promise<void> {
  const { path, host } = objectUrl(cfg, key);
  const signed = sigv4Sign(
    { method: 'PUT', path, headers: { host, 'content-type': mime }, payload: buf },
    cfg,
  );
  const res = await fetch(signed.url, {
    method: 'PUT',
    headers: { ...signed.headers, authorization: signed.authorization },
    body: new Uint8Array(buf),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`R2 PutObject ${key} failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  await res.arrayBuffer().catch(() => undefined); // drain
}

/** Get an object's bytes; null on 404 (S3 NoSuchKey). Other errors throw. */
export async function r2GetObject(key: string, cfg: R2Config = r2Config()): Promise<Buffer | null> {
  const { path, host } = objectUrl(cfg, key);
  const signed = sigv4Sign(
    { method: 'GET', path, headers: { host }, payload: Buffer.alloc(0) },
    cfg,
  );
  const res = await fetch(signed.url, {
    method: 'GET',
    headers: { ...signed.headers, authorization: signed.authorization },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`R2 GetObject ${key} failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ─── maintenance operations (P6.A4 GC) ──────────────────────────────────────

/** Delete an object; 404 is success (idempotent sweep). */
export async function r2DeleteObject(key: string, cfg: R2Config = r2Config()): Promise<void> {
  const { path, host } = objectUrl(cfg, key);
  const signed = sigv4Sign(
    { method: 'DELETE', path, headers: { host }, payload: Buffer.alloc(0) },
    cfg,
  );
  const res = await fetch(signed.url, {
    method: 'DELETE',
    headers: { ...signed.headers, authorization: signed.authorization },
  });
  await res.arrayBuffer().catch(() => undefined); // drain
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '');
    throw new Error(`R2 DeleteObject ${key} failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
}

/**
 * List object keys under the bucket (ListObjectsV2, paginated). Returns the
 * raw <Key> extraction — a minimal, honest parser for the keys-only need
 * (full XML parsing is out of scope; malformed XML throws).
 */
export async function r2ListKeys(cfg: R2Config = r2Config()): Promise<string[]> {
  const { host } = { host: new URL(cfg.endpoint).host };
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const query: Record<string, string> = { 'list-type': '2', 'max-keys': '1000' };
    if (token) query['continuation-token'] = token;
    const signed = sigv4Sign(
      { method: 'GET', path: `/${cfg.bucket}`, query, headers: { host }, payload: Buffer.alloc(0) },
      cfg,
    );
    const res = await fetch(signed.url, {
      method: 'GET',
      headers: { ...signed.headers, authorization: signed.authorization },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`R2 ListObjectsV2 failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      keys.push(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
    }
    const tm = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    token = tm ? tm[1] : undefined;
  } while (token);
  return keys;
}
