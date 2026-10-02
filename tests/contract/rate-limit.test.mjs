// ═══════════════════════════════════════════════════════════════════════════
// YOU rate-limit tests (P6.A6 interim) — node:test.
//
// Boots its OWN server with a low session limit (YOU_RATE_LIMIT_SESSION_
// PER_MIN=5) and proves:
//   1. the 6th unauthenticated POST /api/v1/session within the window → 429
//      rate_limited with a Retry-After and honest details;
//   2. enforcement is per-identity: a different x-forwarded-for keeps
//      working (the limiter does not lock the world out);
//   3. the window heals — after the (shortened) window passes, the same
//      identity is accepted again (uses YOU_RATE_LIMIT_UPLOAD_PER_MIN on
//      uploads with the default 60s window for the heal test would be slow;
//      the session bucket with a tiny custom window is exercised instead
//      via env: YOU_RATE_LIMIT_SESSION_PER_MIN=5 and the test sleeps past
//      the 60s window once — total runtime ~65s, acceptable for a gate);
//   4. api-key mutations hit their own (default 10/min) bucket without
//      affecting the session bucket.
//
// STANDALONE BY DESIGN — NOT imported by tests/index.mjs. Gate command:
//   node --test tests/contract/rate-limit.test.mjs
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

async function postSession(ip) {
  const res = await fetch(base + '/api/v1/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}) },
    body: '{}',
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

before(async () => {
  const port = await freePort();
  const nextBin = path.join(APP_DIR, 'node_modules', '.bin', 'next');
  assert.ok(fs.existsSync(nextBin), 'apps/web/node_modules/.bin/next missing');
  child = spawn(process.execPath, [nextBin, 'dev', '-p', String(port)], {
    cwd: APP_DIR,
    env: { ...process.env, YOU_RATE_LIMIT_SESSION_PER_MIN: '5' },
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

test('session bootstrap: 429 after the limit, with Retry-After + honest details', async () => {
  const ip = '203.0.113.7';
  let last;
  for (let i = 0; i < 6; i++) last = await postSession(ip);
  assert.equal(last.status, 429, `6th call → ${last.status}`);
  assert.equal(last.json?.error?.code, 'rate_limited');
  const details = last.json?.error?.details ?? {};
  assert.equal(details.bucket, 'session-bootstrap');
  assert.equal(details.limit, 5);
  assert.ok(details.retryAfterSeconds >= 1, 'retry-after present');
  // the very same instant, a DIFFERENT identity is unaffected
  const other = await postSession('198.51.100.9');
  assert.ok(other.status === 200 || other.status === 201, `other identity → ${other.status}`);
});

test('the window heals: after reset, the same identity is accepted again', async () => {
  const ip = '203.0.113.21';
  for (let i = 0; i < 6; i++) await postSession(ip);
  const blocked = await postSession(ip);
  assert.equal(blocked.status, 429);
  // wait past the 60s window (plus slack)
  await new Promise((r) => setTimeout(r, 62_000));
  const healed = await postSession(ip);
  assert.ok(healed.status === 200 || healed.status === 201, `after window → ${healed.status}`);
});

test('api-key mutations have their own bucket (10/min default)', async () => {
  const cookie = (await postSession('203.0.113.44')).json && null; // just warm
  void cookie;
  // bootstrap a session for auth
  const s = await postSession('203.0.113.45');
  const setCookie = s.json ? null : null;
  void setCookie;
  const res = await fetch(base + '/api/v1/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const cookie2 = res.headers.get('set-cookie').split(';')[0];
  let last;
  for (let i = 0; i < 11; i++) {
    last = await fetch(base + '/api/v1/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie2 },
      body: JSON.stringify({ name: `rl-${i}`, scopes: ['read'] }),
    });
  }
  assert.equal(last.status, 429, `11th key create → ${last.status}`);
  const j = await last.json().catch(() => null);
  assert.equal(j?.error?.code, 'rate_limited');
  assert.equal(j?.error?.details?.bucket, 'api-key-mutation');
  // session bucket untouched by key-bucket exhaustion
  const sess = await postSession('203.0.113.46');
  assert.ok(sess.status === 200 || sess.status === 201, `session still fine → ${sess.status}`);
});
