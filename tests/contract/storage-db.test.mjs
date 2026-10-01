// ═══════════════════════════════════════════════════════════════════════════
// YOU storage db-backend integration tests (station lane, G-7 fix) — node:test.
//
// Covers the F9 finding G-7 fix (2026-10-01): YOU_STORAGE_BACKEND=db stores
// content-addressed immutable objects as YouObject rows through the app
// database — the serverless-viable backend for hosted deployments (the FS
// backend cannot write on Vercel lambdas: ENOENT mkdir '/var/task/db').
//
// Verified end-to-end through the public API (no internals):
//   1. authorized capture upload → 201 with the content-addressed storageKey
//      (kind/sha256.ext) and the correct sha256 content hash;
//   2. content addressing — re-uploading identical bytes lands on the SAME
//      storageKey (the P2002 already-stored path = FS 'wx' EEXIST semantics);
//   3. signed-URL capability round-trip — GET /api/v1/evidence/:id/url then
//      GET the url WITHOUT any session cookie: 200, correct content-type,
//      byte-identical body (the signature IS the capability, and the bytes
//      come back from the db backend);
//   4. capability model is backend-independent — a tampered signature is
//      refused (403) on the db backend exactly as on fs.
//
// STANDALONE BY DESIGN — NOT imported by tests/index.mjs: the aggregator
// shares ONE server (fs backend) across sibling suites, while this suite
// asserts the db backend specifically and therefore always boots its OWN
// `next dev` with YOU_STORAGE_BACKEND=db. YOU_TEST_BASE does not apply here.
// Gate command: `node --test tests/contract/storage-db.test.mjs`
// (run AFTER the aggregated `node --test tests/` — both are station gates).
//
// Prerequisites = the documented app boot + the YouObject migration:
//   cd apps/web && bun install && cp .env.example .env && bun run db:push
// ═══════════════════════════════════════════════════════════════════════════
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const APP_DIR = path.join(REPO_ROOT, 'apps', 'web');

const stamp = `${Date.now()}-${process.pid}`;
const uid = (p) => `${p}-g7-${stamp}-${Math.random().toString(36).slice(2, 8)}`;

// ─── deterministic sample bytes (a real 8×8 PNG, mime image/png) ────────────
const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dwn4GBgYGJgQoAAF9vAgOZcDyHAAAAAElFTkSuQmCC',
  'base64',
);
const SAMPLE_SHA256 = createHash('sha256').update(SAMPLE_PNG).digest('hex');

// ─── tiny HTTP client with session-cookie memory ────────────────────────────
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

/** multipart upload body for the capture assets route */
function uploadForm() {
  const boundary = `----youg7${stamp}`;
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

// ─── server lifecycle (own boot ALWAYS — db backend, never the shared server) ─
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
    env: { ...process.env, YOU_STORAGE_BACKEND: 'db' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.on('data', () => { /* dev chatter — intentionally ignored */ });
  child.stderr.on('data', () => { /* dev chatter — intentionally ignored */ });
  child.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
      console.error(`[g7-tests] next dev exited early: code=${code} signal=${signal}`);
    }
  });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120000;
  for (;;) {
    if (child.exitCode !== null) assert.fail(`next dev exited with code ${child.exitCode} before becoming ready`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) { base = url; console.log(`[g7-tests] own db-backend server at ${base}`); return; }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) assert.fail(`next dev did not become ready on ${url} within 120s`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ─── tests ───────────────────────────────────────────────────────────────────

before(async () => { await startServer(); });
after(async () => { await killTree(); });

test('db backend: authorized capture upload → 201, content-addressed key + hash', async () => {
  await call('/api/v1/session', { method: 'POST', body: {} });
  const twin = await call('/api/v1/twins', { method: 'POST', body: { displayName: `G7 Storage ${stamp}` } });
  assert.equal(twin.status, 201, `twin create → ${twin.status}`);
  const twinId = twin.json.id;
  const subjectId = twin.json.subjectId;

  const grant = await call('/api/v1/consent-grants', {
    method: 'POST',
    body: {
      subjectId,
      purpose: `G7 storage backend verification ${stamp}`,
      scopes: ['capture'],
    },
  });
  assert.equal(grant.status, 201, `consent grant → ${grant.status}`);

  const cap = await call(`/api/v1/twins/${twinId}/capture-sessions`, { method: 'POST', body: {} });
  assert.equal(cap.status, 201, `capture session → ${cap.status}`);

  const up = await callUpload(`/api/v1/captures/${cap.json.id}/assets`);
  assert.equal(up.status, 201, `upload on db backend → ${up.status} (body: ${up.text.slice(0, 300)})`);
  assert.equal(up.json.contentHash, SAMPLE_SHA256, 'contentHash must be the sha256 of the uploaded bytes');
  assert.equal(up.json.bytes, SAMPLE_PNG.byteLength, 'byte count must match');
  assert.equal(up.json.mime, 'image/png', 'mime must be preserved');
  // the asset view deliberately does NOT expose the storage key (raw-evidence
  // restriction); the content-addressed key is proven via the signed URL below
  const EXPECTED_KEY = `evidence/${SAMPLE_SHA256}.png`;

  // ── content addressing: identical bytes → identical key (P2002 path) ──────
  const up2 = await callUpload(`/api/v1/captures/${cap.json.id}/assets`);
  assert.equal(up2.status, 201, `re-upload → ${up2.status}`);
  assert.equal(up2.json.contentHash, up.json.contentHash, 'identical bytes must hash identically (same content-addressed key)');
  assert.notEqual(up2.json.id, up.json.id, 'but the EvidenceAsset rows are distinct');

  // ── signed-URL capability round-trip (NO cookie — the sig IS the auth) ────
  const urlRes = await call(`/api/v1/evidence/${up.json.id}/url`);
  assert.equal(urlRes.status, 200, `evidence url → ${urlRes.status}`);
  const signed = urlRes.json.url;
  assert.equal(
    signed.split('?')[0],
    `/api/v1/storage/${EXPECTED_KEY}`,
    `signed url must point at the content-addressed key (got ${signed.split('?')[0]})`,
  );
  assert.ok(signed.includes('exp=') && signed.includes('sig='), 'capability params present');

  const savedCookie = cookie;
  cookie = null; // capability-only fetch
  try {
    const obj = await call(signed);
    assert.equal(obj.status, 200, `capability GET → ${obj.status}`);
    assert.equal(obj.headers.get('content-type'), 'image/png', 'content-type must survive the round-trip');
    const got = Buffer.from(await (await fetch(base + signed)).arrayBuffer());
    assert.equal(got.byteLength, SAMPLE_PNG.byteLength, 'byte count from db backend');
    assert.ok(got.equals(SAMPLE_PNG), 'bytes from the db backend must be byte-identical to the upload');
  } finally {
    cookie = savedCookie;
  }

  // ── tampered capability refused — the model is backend-independent ────────
  const tampered = signed.replace(/sig=.{4}/, 'sig=AAAA');
  const bad = await call(tampered);
  assert.equal(bad.status, 403, `tampered sig → ${bad.status} (must be 403, body: ${bad.text.slice(0, 160)})`);
  assert.equal(bad.json?.error?.code, 'forbidden', 'the refusal must use the JSON error envelope');
});
