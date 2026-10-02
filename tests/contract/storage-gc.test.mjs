// ═══════════════════════════════════════════════════════════════════════════
// YOU storage-GC tests (P6.A4) — node:test.
//
// Boots its OWN server (fs backend) and proves deletion completeness:
//   1. twin DELETE cascades rows but RETAINS bytes (documented decision —
//      content-addressed keys may be shared);
//   2. POST /api/v1/maintenance/gc-storage (operator session) → 202 durable
//      job → succeeds → output reports the orphan swept;
//   3. the swept bytes are GONE (capability URL now 404s) while REFERENCED
//      bytes survive (shared-key safety);
//   4. API keys cannot trigger maintenance (403 — operator-only action).
//
// STANDALONE BY DESIGN — NOT imported by tests/index.mjs. Gate command:
//   node --test tests/contract/storage-gc.test.mjs
// Prerequisites: cd apps/web && bun install && cp .env.example .env && bun run db:push
// ═══════════════════════════════════════════════════════════════════════════
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const APP_DIR = path.join(REPO_ROOT, 'apps', 'web');

const stamp = `${Date.now()}-${process.pid}`;
// UNIQUE bytes per run: the sample PNG + random padding. Content addressing
// means identical bytes across suites would share one key and stay
// "referenced" by older rows in the shared dev db — unique bytes isolate
// this suite's object. (The upload route checks the multipart mime, not the
// image structure; no quality analysis runs in this suite.)
const SAMPLE_PNG = Buffer.concat([
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dwn4GBgYGJgQoAAF9vAgOZcDyHAAAAAElFTkSuQmCC',
    'base64',
  ),
  randomBytes(16),
]);
const SAMPLE_SHA256 = createHash('sha256').update(SAMPLE_PNG).digest('hex');
const ORPHAN_KEY = `evidence/${SAMPLE_SHA256}.png`;

let child = null;
let base = null;
let cookie = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on('error', reject);
  });
}

function killTree() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* */ }
    child.once('exit', finish);
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* */ } setTimeout(finish, 500); }, 8000).unref();
  });
}

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
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json, text };
}

function uploadForm() {
  const boundary = `----youp6a4${stamp}`;
  const head = `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="sample.png"\r\ncontent-type: image/png\r\n\r\n`;
  const tail = `\r\n--${boundary}\r\ncontent-disposition: form-data; name="regions"\r\n\r\n["face.front"]\r\n--${boundary}--\r\n`;
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat([Buffer.from(head, 'utf8'), SAMPLE_PNG, Buffer.from(tail, 'utf8')]),
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
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json, text };
}

// capability minter (the app's documented HMAC scheme; secret fixed via env)
const STORAGE_SECRET = 'test-storage-secret-p6a4';
function signedUrl(key, ttlSeconds = 600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = createHmac('sha256', STORAGE_SECRET).update(`${key}.${exp}`, 'utf8').digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `/api/v1/storage/${key}?exp=${exp}&sig=${sig}`;
}

before(async () => {
  const port = await freePort();
  const nextBin = path.join(APP_DIR, 'node_modules', '.bin', 'next');
  assert.ok(fs.existsSync(nextBin), 'apps/web/node_modules/.bin/next missing');
  child = spawn(process.execPath, [nextBin, 'dev', '-p', String(port)], {
    cwd: APP_DIR,
    env: { ...process.env, YOU_STORAGE_SECRET: STORAGE_SECRET },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120000;
  for (;;) {
    if (child.exitCode !== null) assert.fail('next dev exited before ready');
    try {
      const res = await fetch(base, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return;
    } catch { /* */ }
    if (Date.now() > deadline) assert.fail('next dev did not become ready within 120s');
    await new Promise((r) => setTimeout(r, 1000));
  }
});
after(async () => { await killTree(); });

test('twin delete retains bytes; GC sweeps the orphan; referenced bytes survive', async () => {
  await call('/api/v1/session', { method: 'POST', body: {} });

  // twin A: upload our sample bytes
  const twinA = await call('/api/v1/twins', { method: 'POST', body: { displayName: `P6A4 A ${stamp}` } });
  assert.equal(twinA.status, 201);
  const grantA = await call('/api/v1/consent-grants', {
    method: 'POST',
    body: { subjectId: twinA.json.subjectId, purpose: `p6a4 ${stamp}`, scopes: ['capture'], ttlHours: 2 },
  });
  assert.equal(grantA.status, 201);
  const capA = await call(`/api/v1/twins/${twinA.json.id}/capture-sessions`, { method: 'POST', body: {} });
  assert.equal(capA.status, 201);
  const upA = await callUpload(`/api/v1/captures/${capA.json.id}/assets`);
  assert.equal(upA.status, 201);

  // twin B: SAME bytes (content-addressed → SAME key, shared)
  const twinB = await call('/api/v1/twins', { method: 'POST', body: { displayName: `P6A4 B ${stamp}` } });
  assert.equal(twinB.status, 201);
  const grantB = await call('/api/v1/consent-grants', {
    method: 'POST',
    body: { subjectId: twinB.json.subjectId, purpose: `p6a4 ${stamp}`, scopes: ['capture'], ttlHours: 2 },
  });
  assert.equal(grantB.status, 201);
  const capB = await call(`/api/v1/twins/${twinB.json.id}/capture-sessions`, { method: 'POST', body: {} });
  assert.equal(capB.status, 201);
  const upB = await callUpload(`/api/v1/captures/${capB.json.id}/assets`);
  assert.equal(upB.status, 201);
  assert.equal(upB.json.contentHash, SAMPLE_SHA256, 'same bytes → same content-addressed key');

  // bytes reachable pre-delete (both twins share the object)
  const pre = await fetch(base + signedUrl(ORPHAN_KEY));
  assert.equal(pre.status, 200, 'bytes present pre-delete');

  // delete twin A → rows cascade, bytes RETAINED (documented)
  const del = await call(`/api/v1/twins/${twinA.json.id}`, { method: 'DELETE' });
  assert.equal(del.status, 204);
  const retained = await fetch(base + signedUrl(ORPHAN_KEY));
  assert.equal(retained.status, 200, 'bytes retained after twin delete (twin B still references them)');

  // GC now: nothing is orphaned (twin B references the key) → sweep must KEEP it
  const gc1 = await call('/api/v1/maintenance/gc-storage', { method: 'POST', body: {} });
  assert.equal(gc1.status, 202, `gc → ${gc1.status}`);
  const job1 = await pollJob(gc1.json.jobId);
  assert.equal(job1.status, 'succeeded', `gc job failed: ${job1.error}`);
  assert.equal(job1.output.sweptUnreferenced, 0, 'shared-key safety: nothing swept while referenced');
  const kept = await fetch(base + signedUrl(ORPHAN_KEY));
  assert.equal(kept.status, 200, 'referenced bytes survive the sweep');

  // delete twin B too → the object is now fully orphaned
  const delB = await call(`/api/v1/twins/${twinB.json.id}`, { method: 'DELETE' });
  assert.equal(delB.status, 204);
  const still = await fetch(base + signedUrl(ORPHAN_KEY));
  assert.equal(still.status, 200, 'bytes still retained (deletion is lazy by design)');

  // GC again → the orphan is swept
  const gc2 = await call('/api/v1/maintenance/gc-storage', { method: 'POST', body: {} });
  assert.equal(gc2.status, 202);
  const job2 = await pollJob(gc2.json.jobId);
  assert.equal(job2.status, 'succeeded');
  assert.ok(job2.output.sweptUnreferenced >= 1, `the orphan was swept (output: ${JSON.stringify(job2.output)})`);
  const gone = await fetch(base + signedUrl(ORPHAN_KEY));
  assert.equal(gone.status, 404, 'swept bytes are gone for good');
});

test('maintenance is operator-only: API keys are refused', async () => {
  const key = await call('/api/v1/api-keys', {
    method: 'POST',
    body: { name: 'p6a4 no-maintenance', scopes: ['read', 'write'] },
  });
  assert.equal(key.status, 201);
  const res = await fetch(base + '/api/v1/maintenance/gc-storage', {
    method: 'POST',
    headers: { authorization: `Bearer ${key.json.secret}` },
  });
  assert.equal(res.status, 403, `api key must not trigger maintenance (got ${res.status})`);
  const j = await res.json().catch(() => null);
  assert.match(j?.error?.message ?? '', /operator session/i);
});

async function pollJob(jobId) {
  const deadline = Date.now() + 60000;
  for (;;) {
    const job = await call(`/api/v1/jobs/${jobId}`);
    assert.equal(job.status, 200);
    if (job.json.status === 'succeeded' || job.json.status === 'failed') {
      return { status: job.json.status, error: job.json.error, output: typeof job.json.output === 'string' ? JSON.parse(job.json.output) : job.json.output };
    }
    if (Date.now() > deadline) assert.fail(`job ${jobId} did not finish within 60s`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

