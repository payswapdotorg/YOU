// ═══════════════════════════════════════════════════════════════════════════
// YOU api-key lifecycle tests (P6.A3) — node:test.
//
// Covers the full key lifecycle through the public API:
//   1. create → secret shape (you_sk_ prefix, url-safe, one-time return),
//      list never leaks secrets;
//   2. the key AUTHENTICATES (Bearer) with correct scope enforcement;
//   3. ROTATE in place → new secret returned once, same key id/name/scopes,
//      OLD secret dies IMMEDIATELY (401), new secret works;
//   4. revocation is terminal → revoked key 401s; rotating a revoked key
//      → 409; revocation keeps the row (audit trail).
//
// STANDALONE BY DESIGN — NOT imported by tests/index.mjs (fresh db state
// per boot keeps key-count assertions exact). Gate command:
//   node --test tests/contract/api-key-lifecycle.test.mjs
// Prerequisites: cd apps/web && bun install && cp .env.example .env && bun run db:push
// ═══════════════════════════════════════════════════════════════════════════
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const APP_DIR = path.join(REPO_ROOT, 'apps', 'web');

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

before(async () => {
  const port = await freePort();
  const nextBin = path.join(APP_DIR, 'node_modules', '.bin', 'next');
  assert.ok(fs.existsSync(nextBin), 'apps/web/node_modules/.bin/next missing — run `cd apps/web && bun install` first');
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
    if (child.exitCode !== null) assert.fail(`next dev exited with code ${child.exitCode} before becoming ready`);
    try {
      const res = await fetch(base, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return;
    } catch { /* */ }
    if (Date.now() > deadline) assert.fail('next dev did not become ready within 120s');
    await new Promise((r) => setTimeout(r, 1000));
  }
});
after(async () => { await killTree(); });

test('create → one-time secret with the documented shape; list never leaks', async () => {
  await call('/api/v1/session', { method: 'POST', body: {} });
  const created = await call('/api/v1/api-keys', {
    method: 'POST',
    body: { name: 'p6a3 lifecycle', scopes: ['read', 'write'] },
  });
  assert.equal(created.status, 201, `create → ${created.status}`);
  const secret = created.json.secret;
  assert.match(secret, /^you_sk_[A-Za-z0-9_-]{43}$/, 'you_sk_ + 43 url-safe chars');
  assert.equal(created.json.key.name, 'p6a3 lifecycle');
  assert.ok(!created.json.key.hash && !created.json.key.secret, 'view carries no secret material');

  const listed = await call('/api/v1/api-keys');
  assert.equal(listed.status, 200);
  const entry = listed.json.find((k) => k.id === created.json.key.id);
  assert.ok(entry, 'key listed');
  assert.ok(!('secret' in entry) && !('hash' in entry), 'list never leaks secrets');
  assert.ok(entry.prefix.startsWith('you_sk_'), 'prefix visible for identification');
});

test('the key authenticates with scope enforcement', async () => {
  const ro = await call('/api/v1/api-keys', { method: 'POST', body: { name: 'p6a3 ro', scopes: ['read'] } });
  assert.equal(ro.status, 201);
  const roSecret = ro.json.secret;

  const ok = await fetch(base + '/api/v1/twins', { headers: { authorization: `Bearer ${roSecret}` } });
  assert.equal(ok.status, 200, 'read scope allows GET');

  const denied = await fetch(base + '/api/v1/twins', {
    method: 'POST',
    headers: { authorization: `Bearer ${roSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'nope' }),
  });
  assert.equal(denied.status, 403, `read scope must refuse POST (got ${denied.status})`);
});

test('rotate in place: old secret dies immediately, new one works, identity kept', async () => {
  const created = await call('/api/v1/api-keys', {
    method: 'POST',
    body: { name: 'p6a3 rotate-me', scopes: ['read', 'write'] },
  });
  const keyId = created.json.key.id;
  const oldSecret = created.json.secret;

  // old secret works pre-rotation
  const pre = await fetch(base + '/api/v1/twins', { headers: { authorization: `Bearer ${oldSecret}` } });
  assert.equal(pre.status, 200);

  const rotated = await call(`/api/v1/api-keys/${keyId}/rotate`, { method: 'POST', body: {} });
  assert.equal(rotated.status, 201, `rotate → ${rotated.status}`);
  const newSecret = rotated.json.secret;
  assert.match(newSecret, /^you_sk_[A-Za-z0-9_-]{43}$/, 'rotated secret has the same shape');
  assert.notEqual(newSecret, oldSecret, 'rotation actually changed the secret');
  assert.equal(rotated.json.key.id, keyId, 'same key id (in place)');
  assert.equal(rotated.json.key.name, 'p6a3 rotate-me', 'name kept');
  assert.ok(!('secret' in rotated.json.key), 'view carries no secret');

  // old secret is DEAD at once — no overlap window
  const dead = await fetch(base + '/api/v1/twins', { headers: { authorization: `Bearer ${oldSecret}` } });
  assert.equal(dead.status, 401, `old secret must 401 immediately (got ${dead.status})`);

  // new secret works
  const alive = await fetch(base + '/api/v1/twins', { headers: { authorization: `Bearer ${newSecret}` } });
  assert.equal(alive.status, 200, 'new secret authenticates');
});

test('revocation is terminal: revoked key 401s; rotate → 409; row kept for audit', async () => {
  const created = await call('/api/v1/api-keys', {
    method: 'POST',
    body: { name: 'p6a3 doom', scopes: ['read'] },
  });
  const keyId = created.json.key.id;
  const secret = created.json.secret;

  const revoked = await call(`/api/v1/api-keys/${keyId}`, { method: 'DELETE' });
  assert.equal(revoked.status, 200, `revoke → ${revoked.status}`);
  assert.ok(revoked.json.revokedAt, 'revokedAt set');

  const dead = await fetch(base + '/api/v1/twins', { headers: { authorization: `Bearer ${secret}` } });
  assert.equal(dead.status, 401, 'revoked key no longer authenticates');

  const rotateRefused = await call(`/api/v1/api-keys/${keyId}/rotate`, { method: 'POST', body: {} });
  assert.equal(rotateRefused.status, 409, `rotating a revoked key must 409 (got ${rotateRefused.status})`);

  const listed = await call('/api/v1/api-keys');
  assert.ok(listed.json.find((k) => k.id === keyId), 'revoked row kept (audit trail)');
});
