// ═══════════════════════════════════════════════════════════════════════════
// YOU core — object storage with signed URLs (Worker A lane)
// Local dev stand-in for Cloudflare R2 (docs/DEPLOYMENT.md: "local:
// deterministic fixtures"). Signed URLs are capabilities: GET /api/v1/storage/<key>?exp=<epochSec>&sig=<urlsafe-b64 hmac-sha256(key + '.' + exp, YOU_STORAGE_SECRET)>
//
// Backends (YOU_STORAGE_BACKEND, read per call — server env is fixed at boot):
//   "fs" (default) — bytes live under db/you-objects/ (local dev only).
//   "db"            — bytes live in the YouObject table (content-addressed
//                     rows through the app database). Serverless-viable:
//                     the F9 station verification (2026-10-01) proved the FS
//                     backend cannot write on Vercel lambdas (read-only
//                     bundle root: ENOENT mkdir '/var/task/db'). The db
//                     backend is the hosted dev-tier stand-in, exactly like
//                     SQLite stands in for Neon locally.
//   "r2"            — bytes live in Cloudflare R2 (the S3-compatible XML
//                     API with hand-rolled SigV4, core/r2.ts). The
//                     production target (P6.A1). Requires YOU_R2_ACCOUNT_ID,
//                     YOU_R2_ACCESS_KEY_ID, YOU_R2_SECRET_ACCESS_KEY and
//                     YOU_R2_BUCKET; fails closed on any miss. Capability
//                     URLs are backend-independent: objects are served
//                     through the same /api/v1/storage route, so the frozen
//                     v1 API contract is untouched.
// Keys are content-addressed and immutable in BOTH backends — putObject
// never overwrites (a repeated key is byte-identical by construction).
// ═══════════════════════════════════════════════════════════════════════════
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { db } from '@/lib/db';
import { r2PutObject, r2GetObject } from '@/lib/you/core/r2';

const OBJECT_ROOT = path.join(process.cwd(), 'db', 'you-objects');
const DEFAULT_TTL_SECONDS = 600;

export type StorageBackend = 'fs' | 'db' | 'r2';

function storageBackend(): StorageBackend {
  const raw = (process.env.YOU_STORAGE_BACKEND ?? 'fs').trim().toLowerCase();
  if (raw === 'db') return 'db';
  if (raw === 'r2') return 'r2';
  if (raw === 'fs' || raw === '') return 'fs';
  throw new Error(
    `YOU_STORAGE_BACKEND must be "fs", "db" or "r2" (got "${raw}") — refusing to guess where bytes live`,
  );
}

function storageSecret(): string {
  const secret = process.env.YOU_STORAGE_SECRET;
  if (!secret) throw new Error('YOU_STORAGE_SECRET is not configured');
  return secret;
}

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/webm': 'weba',
  'application/json': 'json',
  'text/plain': 'txt',
  'text/csv': 'csv',
};

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  weba: 'audio/webm',
  json: 'application/json',
  txt: 'text/plain',
  csv: 'text/csv',
};

export function extFromMime(mime: string): string {
  return MIME_TO_EXT[mime.toLowerCase()] ?? 'bin';
}

export function mimeFromKey(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_MIME[ext] ?? 'application/octet-stream';
}

/** Storage keys must be strictly path-safe: `word/word.ext`, no traversal. */
export function isSafeKey(key: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(key);
}

export function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export interface PutObjectResult {
  storageKey: string;
  contentHash: string;
  bytes: number;
}

/**
 * Content-addressed immutable write: `${kind}/${sha256}.${ext}`. If the object
 * already exists the bytes are identical by construction — no overwrite.
 */
export async function putObject(
  buf: Buffer,
  opts: { kind: string; mime: string },
): Promise<PutObjectResult> {
  const kind = opts.kind.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!kind) throw new Error('putObject: kind must be non-empty');
  const contentHash = sha256Buffer(buf);
  const storageKey = `${kind}/${contentHash}.${extFromMime(opts.mime)}`;
  if (!isSafeKey(storageKey)) throw new Error(`putObject: unsafe storage key "${storageKey}"`);
  if (storageBackend() === 'db') {
    // Prisma's Bytes input is Uint8Array<ArrayBuffer>; Node's Buffer is
    // Buffer<ArrayBufferLike> — copy into a plain Uint8Array (≤10MB uploads,
    // never a hot path). Content addressing makes the copy irrelevant to keying.
    await db.youObject
      .create({ data: { key: storageKey, mime: opts.mime.toLowerCase(), bytes: new Uint8Array(buf) } })
      .catch((err: { code?: string; message?: string }) => {
        // P2002 = unique-constraint: the content-addressed key already exists
        // — identical bytes by construction, same semantics as the FS 'wx' path.
        if (err?.code !== 'P2002') throw err;
      });
  } else if (storageBackend() === 'r2') {
    // Content addressing makes re-puts byte-identical; S3 PUT overwrite is a
    // semantic no-op. Fail-closed config errors propagate (never fall back).
    await r2PutObject(storageKey, buf, opts.mime);
  } else {
    const abs = path.join(OBJECT_ROOT, storageKey);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, buf, { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err; // already stored — content-addressed, identical bytes
    });
  }
  return { storageKey, contentHash, bytes: buf.byteLength };
}

export async function getObject(key: string): Promise<Buffer | null> {
  if (!isSafeKey(key)) return null;
  if (storageBackend() === 'db') {
    const row = await db.youObject.findUnique({ where: { key } });
    if (!row) return null;
    return Buffer.from(row.bytes);
  }
  if (storageBackend() === 'r2') {
    return r2GetObject(key); // 404 → null; transport/auth errors throw (fail closed)
  }
  const abs = path.join(OBJECT_ROOT, key);
  if (!abs.startsWith(OBJECT_ROOT + path.sep)) return null; // traversal guard (defense in depth)
  try {
    return await readFile(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function urlsafeB64(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function signKey(key: string, exp: string): string {
  return urlsafeB64(createHmac('sha256', storageSecret()).update(`${key}.${exp}`, 'utf8').digest());
}

/**
 * Signed, expiring URL — the signature IS the capability (no auth on the
 * storage route). Default TTL 600s.
 */
export function signStorageUrl(key: string, ttlSeconds: number = DEFAULT_TTL_SECONDS): string {
  if (!isSafeKey(key)) throw new Error(`signStorageUrl: unsafe storage key "${key}"`);
  const exp = Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(ttlSeconds));
  const sig = signKey(key, String(exp));
  return `/api/v1/storage/${key}?exp=${exp}&sig=${sig}`;
}

export function verifyStorageSig(key: string, exp: string, sig: string): boolean {
  if (!isSafeKey(key)) return false;
  if (!/^\d+$/.test(exp) || !sig) return false;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum * 1000 <= Date.now()) return false; // expired
  const expected = Buffer.from(signKey(key, exp));
  const provided = Buffer.from(sig);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export const STORAGE_DEFAULT_TTL_SECONDS = DEFAULT_TTL_SECONDS;
