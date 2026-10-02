// ═══════════════════════════════════════════════════════════════════════════
// YOU subject-export tests (P6.A4 export leg) — node:test.
//
// Boots its OWN server and proves the portable export:
//   1. GET /api/v1/subjects/:id/export returns the full bundle for a subject
//      with real data (twin, capture, asset, consent grant);
//   2. evidence download URLs are expiring capabilities — they resolve 200
//      with byte-identical content, cookieless;
//   3. scope honesty: a DIFFERENT subject's export contains none of the
//      first subject's rows; an unknown subject exports empty arrays (not
//      an error, not invented data).
//
// STANDALONE BY DESIGN — NOT imported by tests/index.mjs. Gate command:
//   node --test tests/contract/subject-export.test.mjs
// Prerequisites: cd apps/web && bun install && cp .env.example .env && bun run db:push
// ═══════════════════════════════════════════════════════════════════════════
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const APP_DIR = path.join(REPO_ROOT, 'apps', 'web');

const stamp = `${Date.now()}-${process.pid}`;
// unique bytes per run (content addressing — see storage-gc suite rationale)
const SAMPLE_PNG = Buffer.concat([
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dwn4GBgYGJgQoAAF9vAgOZcDyHAAAAAElFTkSuQmCC',
    'base64',
  ),
  randomBytes(16),
]);

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
  const boundary = `----youp6a4e${stamp}`;
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

before(async () => {
  const port = await freePort();
  const nextBin = path.join(APP_DIR, 'node_modules', '.bin', 'next');
  assert.ok(fs.existsSync(nextBin), 'apps/web/node_modules/.bin/next missing');
  child = spawn(process.execPath, [nextBin, 'dev', '-p', String(port)], {
    cwd: APP_DIR,
    env: { ...process.env },
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

test('export returns the full bundle; evidence URLs are live capabilities', async () => {
  await call('/api/v1/session', { method: 'POST', body: {} });
  const twin = await call('/api/v1/twins', { method: 'POST', body: { displayName: `P6A4E ${stamp}` } });
  assert.equal(twin.status, 201);
  const subjectId = twin.json.subjectId;
  const grant = await call('/api/v1/consent-grants', {
    method: 'POST',
    body: { subjectId, purpose: `p6a4e ${stamp}`, scopes: ['capture'], ttlHours: 2 },
  });
  assert.equal(grant.status, 201);
  const cap = await call(`/api/v1/twins/${twin.json.id}/capture-sessions`, { method: 'POST', body: {} });
  assert.equal(cap.status, 201);
  const up = await callUpload(`/api/v1/captures/${cap.json.id}/assets`);
  assert.equal(up.status, 201);

  const exp = await call(`/api/v1/subjects/${subjectId}/export`);
  assert.equal(exp.status, 200, `export → ${exp.status}`);
  const b = exp.json;
  assert.equal(b.subjectId, subjectId);
  assert.ok(b.exportedAt, 'export timestamp');
  assert.equal(b.twins.length, 1);
  assert.equal(b.twins[0].id, twin.json.id);
  assert.equal(b.consentGrants.length, 1);
  assert.equal(b.captureSessions.length, 1);
  assert.equal(b.evidenceAssets.length, 1);
  assert.equal(b.evidenceAssets[0].contentHash, createHash('sha256').update(SAMPLE_PNG).digest('hex'));

  // the download URL is a live capability: cookieless 200, byte-identical
  const dl = await fetch(base + b.evidenceAssets[0].downloadUrl);
  assert.equal(dl.status, 200, `download → ${dl.status}`);
  assert.equal(dl.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await dl.arrayBuffer());
  assert.ok(bytes.equals(SAMPLE_PNG), 'byte-identical evidence');

  // scope honesty: another subject's export has none of this data
  const other = await call('/api/v1/twins', { method: 'POST', body: { displayName: `P6A4E-other ${stamp}` } });
  const otherExp = await call(`/api/v1/subjects/${other.json.subjectId}/export`);
  assert.equal(otherExp.status, 200);
  assert.equal(otherExp.json.twins.length, 1);
  assert.notEqual(otherExp.json.twins[0].id, twin.json.id);
  assert.equal(otherExp.json.evidenceAssets.length, 0);
  assert.equal(otherExp.json.consentGrants.length, 0);

  // unknown subject: empty arrays, not an error, not invented data
  const unknown = await call('/api/v1/subjects/subj_doesnotexist/export');
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.json.twins, []);
  assert.deepEqual(unknown.json.evidenceAssets, []);
});
