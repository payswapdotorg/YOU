// ═══════════════════════════════════════════════════════════════════════════
// YOU storage r2-backend integration tests (P6.A1) — node:test.
//
// Boots the app with YOU_STORAGE_BACKEND=r2 pointed at a LOCAL mock of the
// R2 S3 XML API (node:http). The mock verifies every request's AWS SigV4
// signature cryptographically (recomputes the canonical request + signing
// chain with the same fixed test credentials) and records requests for
// shape assertions — so the adapter's signing is proven end-to-end, not
// just "it made an HTTP call".
//
// Verified through the public API (frozen v1 contract, no internals):
//   1. authorized capture upload → 201 with the content-addressed
//      contentHash AND a SigV4-valid PUT observed by the mock at exactly
//      /<bucket>/evidence/<sha256>.png (path-style, x-amz-content-sha256 =
//      payload hash, credential = the configured access key id);
//   2. signed-URL capability round-trip — GET /api/v1/storage/<key>?exp&sig
//      WITHOUT any session cookie: 200, correct content-type, byte-identical
//      body served FROM R2 (the mock);
//   3. content addressing — re-uploading identical bytes lands on the SAME
//      content-addressed key (the mock holds exactly one object);
//   4. capability model is backend-independent — a tampered signature is
//      refused (403) with bytes in R2 exactly as with fs/db;
//   5. unstored key → 404 (r2 NoSuchKey → null → route 404).
//
// STANDALONE BY DESIGN — NOT imported by tests/index.mjs (same rule as
// storage-db.test.mjs): this suite boots its OWN `next dev` with
// YOU_STORAGE_BACKEND=r2 + mock-endpoint env. Gate command:
//   node --test tests/contract/storage-r2.test.mjs
// Prerequisites: cd apps/web && bun install && cp .env.example .env && bun run db:push
// ═══════════════════════════════════════════════════════════════════════════
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const APP_DIR = path.join(REPO_ROOT, 'apps', 'web');

const stamp = `${Date.now()}-${process.pid}`;

// ─── fixed test credentials (mock + app share them via env) ─────────────────
const TEST_R2 = {
  accountId: 'deadbeefdeadbeefdeadbeefdeadbeef',
  accessKeyId: 'test-akid-p6a1',
  secretAccessKey: 'test-secret-p6a1',
  bucket: 'you-objects-test',
};
const TEST_STORAGE_SECRET = 'test-storage-secret-p6a1';

// ─── deterministic sample bytes (a real 8×8 PNG, mime image/png) ────────────
const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dwn4GBgYGJgQoAAF9vAgOZcDyHAAAAAElFTkSuQmCC',
  'base64',
);
const SAMPLE_SHA256 = createHash('sha256').update(SAMPLE_PNG).digest('hex');
const EXPECTED_KEY = `evidence/${SAMPLE_SHA256}.png`;

// ─── the SigV4-verifying S3 mock ─────────────────────────────────────────────
const mockStore = new Map(); // key → { bytes: Buffer, mime: string }
const mockRequests = []; // { method, path, key, authorization, contentSha256, verified, why }
let mockServer = null;
let mockPort = 0;

function s3UriEncode(value) {
  let out = '';
  for (const ch of value) {
    if (/[A-Za-z0-9-._~]/.test(ch)) out += ch;
    else if (ch === '/') out += '/';
    else out += '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** Recompute the SigV4 signature for a received request; {ok, why}. */
function verifySigV4(req, body) {
  const auth = req.headers.authorization || '';
  const m = auth.match(
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/,
  );
  if (!m) return { ok: false, why: 'authorization-shape' };
  const [, akid, dateStamp, region, service, signedHeaders, wantSig] = m;
  if (akid !== TEST_R2.accessKeyId) return { ok: false, why: 'akid' };
  if (region !== 'auto' || service !== 's3') return { ok: false, why: 'scope' };

  const u = new URL(req.url, 'http://x');
  const canonicalUri = u.pathname.split('/').map(s3UriEncode).join('/');
  const canonicalQuery = [...u.searchParams.entries()]
    .map(([k, v]) => [s3UriEncode(k), s3UriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const names = signedHeaders.split(';');
  const canonicalHeaders = names.map((n) => `${n}:${String(req.headers[n] ?? '').trim()}\n`).join('');
  const contentSha256 = createHash('sha256').update(body).digest('hex');
  if (req.headers['x-amz-content-sha256'] !== contentSha256) return { ok: false, why: 'content-hash' };

  const canonicalRequest = [req.method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, contentSha256].join('\n');
  const amzDate = req.headers['x-amz-date'];
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest();
  const signingKey = hmac(hmac(hmac(hmac('AWS4' + TEST_R2.secretAccessKey, dateStamp), region), service), 'aws4_request');
  const gotSig = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  if (gotSig !== wantSig) return { ok: false, why: 'signature' };
  if (!/^20\d{6}T\d{6}Z$/.test(amzDate)) return { ok: false, why: 'amz-date' };
  return { ok: true };
}

function startMock() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const verified = verifySigV4(req, body);
        const u = new URL(req.url, 'http://x');
        const key = decodeURIComponent(u.pathname.slice(TEST_R2.bucket.length + 2));
        mockRequests.push({
          method: req.method, path: u.pathname, key,
          authorization: req.headers.authorization || '',
          contentSha256: req.headers['x-amz-content-sha256'],
          verified: verified.ok, why: verified.why,
        });
        if (!verified.ok) {
          res.writeHead(403, { 'content-type': 'application/xml' });
          res.end(`<Error><Code>SignatureDoesNotMatch</Code><Detail>${verified.why}</Detail></Error>`);
          return;
        }
        if (req.method === 'PUT') {
          mockStore.set(key, { bytes: body, mime: req.headers['content-type'] || 'application/octet-stream' });
          res.writeHead(200, { etag: `"${createHash('md5').update(body).digest('hex')}"` });
          res.end();
        } else if (req.method === 'GET') {
          if (!mockStore.has(key)) {
            res.writeHead(404, { 'content-type': 'application/xml' });
            res.end('<Error><Code>NoSuchKey</Code></Error>');
          } else {
            const obj = mockStore.get(key);
            res.writeHead(200, { 'content-type': obj.mime, 'content-length': String(obj.bytes.length) });
            res.end(obj.bytes);
          }
        } else {
          res.writeHead(405); res.end();
        }
      });
    });
    mockServer.listen(0, '127.0.0.1', () => {
      mockPort = mockServer.address().port;
      resolve();
    });
  });
}

// ─── app client with session-cookie memory ──────────────────────────────────
let base = null;
let cookie = null;

async function call(pathname, { method = 'GET', body, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  let payload;
  if (body !== undefined) {
    h['content-type'] = h['content-type'] ?? 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + pathname, { method, headers: h, body: payload });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, json, text, headers: res.headers };
}

function uploadForm() {
  const boundary = `----youp6a1${stamp}`;
  const parts = [
    `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="sample.png"\r\ncontent-type: image/png\r\n\r\n`,
  ];
  const tail = `\r\n--${boundary}\r\ncontent-disposition: form-data; name="regions"\r\n\r\n["face.front"]\r\n--${boundary}--\r\n`;
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat([Buffer.from(parts[0], 'utf8'), SAMPLE_PNG, Buffer.from(tail, 'utf8')]),
  };
}

async function callUpload(pathname) {
  const form = uploadForm();
  const h = { ...form.headers };
  if (cookie) h.cookie = cookie;
  const res = await fetch(base + pathname, { method: 'POST', headers: h, body: form.body });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, json, text };
}

/** Fresh twin + capture-scoped consent + capture session (returns sessionId). */
async function freshCaptureContext(label) {
  const twin = await call('/api/v1/twins', { method: 'POST', body: { displayName: `${label} ${stamp}` } });
  assert.equal(twin.status, 201, `twin create → ${twin.status}`);
  const grant = await call('/api/v1/consent-grants', {
    method: 'POST',
    body: { subjectId: twin.json.subjectId, purpose: `${label} ${stamp}`, scopes: ['capture'] },
  });
  assert.equal(grant.status, 201, `consent grant → ${grant.status}`);
  const cap = await call(`/api/v1/twins/${twin.json.id}/capture-sessions`, { method: 'POST', body: {} });
  assert.equal(cap.status, 201, `capture session → ${cap.status}`);
  return cap.json.id;
}

/** Mint a capability URL exactly as the app does (documented HMAC scheme). */
function mintCapability(key, ttlSeconds = 600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = createHmac('sha256', TEST_STORAGE_SECRET)
    .update(`${key}.${exp}`, 'utf8')
    .digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `/api/v1/storage/${key}?exp=${exp}&sig=${sig}`;
}

// ─── app server lifecycle (own boot ALWAYS — r2 backend) ─────────────────────
let child = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function killTree() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const pid = child.pid;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
    child.once('exit', finish);
    setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
      setTimeout(finish, 500);
    }, 8000).unref();
  });
}

async function startServer() {
  const port = await freePort();
  const nextBin = path.join(APP_DIR, 'node_modules', '.bin', 'next');
  assert.ok(fs.existsSync(nextBin), 'apps/web/node_modules/.bin/next missing — run `cd apps/web && bun install` first');
  assert.ok(
    fs.existsSync(path.join(APP_DIR, '.env')) || process.env.DATABASE_URL,
    'no database config: run `cd apps/web && cp .env.example .env && bun run db:push` first',
  );
  child = spawn(process.execPath, [nextBin, 'dev', '-p', String(port)], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      YOU_STORAGE_BACKEND: 'r2',
      YOU_STORAGE_SECRET: TEST_STORAGE_SECRET, // deterministic capability minting
      YOU_R2_ACCOUNT_ID: TEST_R2.accountId,
      YOU_R2_ACCESS_KEY_ID: TEST_R2.accessKeyId,
      YOU_R2_SECRET_ACCESS_KEY: TEST_R2.secretAccessKey,
      YOU_R2_BUCKET: TEST_R2.bucket,
      YOU_R2_ENDPOINT: `http://127.0.0.1:${mockPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.on('data', () => { /* dev chatter — intentionally ignored */ });
  child.stderr.on('data', () => { /* dev chatter — intentionally ignored */ });
  child.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
      console.error(`[p6a1-tests] next dev exited early: code=${code} signal=${signal}`);
    }
  });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120000;
  for (;;) {
    if (child.exitCode !== null) assert.fail(`next dev exited with code ${child.exitCode} before becoming ready`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) { base = url; console.log(`[p6a1-tests] own r2-backend server at ${base} (mock R2 :${mockPort})`); return; }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) assert.fail(`next dev did not become ready on ${url} within 120s`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ─── tests ───────────────────────────────────────────────────────────────────

before(async () => {
  await startMock();
  await startServer();
});
after(async () => {
  await killTree();
  await new Promise((r) => mockServer.close(r));
});

test('r2 backend: authorized capture upload → 201 + SigV4-valid PUT at the mock', async () => {
  await call('/api/v1/session', { method: 'POST', body: {} });
  const capId = await freshCaptureContext('P6A1 R2 Storage');

  const nPut = mockRequests.filter((r) => r.method === 'PUT').length;
  const up = await callUpload(`/api/v1/captures/${capId}/assets`);
  assert.equal(up.status, 201, `asset upload → ${up.status}`);
  assert.ok(up.json.contentHash, 'response carries the content hash');
  assert.equal(up.json.contentHash, SAMPLE_SHA256, 'sha256 content hash');
  assert.equal(up.json.mime, 'image/png');

  const puts = mockRequests.filter((r) => r.method === 'PUT');
  assert.equal(puts.length, nPut + 1, 'exactly one new PUT reached R2');
  const put = puts[puts.length - 1];
  assert.ok(put.verified, `mock verified the SigV4 signature (failure: ${put.why})`);
  assert.equal(put.path, `/${TEST_R2.bucket}/${EXPECTED_KEY}`, 'path-style URL /<bucket>/evidence/<sha256>.png');
  assert.equal(put.key, EXPECTED_KEY, 'content-addressed key');
  assert.equal(put.contentSha256, SAMPLE_SHA256, 'x-amz-content-sha256 = payload hash');
  assert.match(put.authorization, new RegExp(`Credential=${TEST_R2.accessKeyId}/`), 'credential carries the access key id');
});

test('r2 backend: capability URL round-trip serves bytes FROM R2 with no cookie', async () => {
  assert.ok(mockStore.has(EXPECTED_KEY), 'the object is in the mock (R2)');
  const got = await fetch(base + mintCapability(EXPECTED_KEY)); // NO session cookie — the sig IS the capability
  assert.equal(got.status, 200, `capability GET → ${got.status}`);
  assert.equal(got.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await got.arrayBuffer());
  assert.ok(bytes.equals(SAMPLE_PNG), 'byte-identical body served from R2 via the app route');
  const gets = mockRequests.filter((r) => r.method === 'GET' && r.key === EXPECTED_KEY);
  assert.ok(gets.some((g) => g.verified), 'the serving GET was SigV4-valid');
});

test('r2 backend: content addressing — identical bytes land on the same key', async () => {
  const before = mockStore.size;
  const putsBefore = mockRequests.filter((r) => r.method === 'PUT' && r.key === EXPECTED_KEY).length;
  const capA = await freshCaptureContext('P6A1 Re-A');
  const capB = await freshCaptureContext('P6A1 Re-B');
  const up1 = await callUpload(`/api/v1/captures/${capA}/assets`);
  assert.equal(up1.status, 201);
  const up2 = await callUpload(`/api/v1/captures/${capB}/assets`);
  assert.equal(up2.status, 201);
  assert.equal(up1.json.contentHash, up2.json.contentHash, 'same bytes → same content hash');
  const putsAfter = mockRequests.filter((r) => r.method === 'PUT' && r.key === EXPECTED_KEY).length;
  assert.equal(putsAfter - putsBefore, 2, 'both uploads PUT the SAME content-addressed key');
  assert.equal(mockStore.size, before, 'identical bytes → no new object (the key already exists)');
  assert.ok(mockStore.has(EXPECTED_KEY), 'stored at the content-addressed key');
});

test('r2 backend: tampered capability signature → 403 (backend-independent law)', async () => {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const bad = 'AAAA' + 'a'.repeat(40);
  const res = await fetch(base + `/api/v1/storage/${EXPECTED_KEY}?exp=${exp}&sig=${bad}`);
  assert.equal(res.status, 403, `tampered sig must be refused, got ${res.status}`);
});

test('r2 backend: unstored key → 404 (r2 NoSuchKey → route 404)', async () => {
  const key = `evidence/${'0'.repeat(64)}.png`;
  const res = await fetch(base + mintCapability(key));
  assert.equal(res.status, 404, `unstored key must 404, got ${res.status}`);
});
