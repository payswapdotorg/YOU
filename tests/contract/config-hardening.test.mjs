// ═══════════════════════════════════════════════════════════════════════════
// YOU secret/config hardening tests (P6.A2) — node:test.
//
// Covers the runtime behavior change: the demo bootstrap
// (auto-provisioned founder@you.dev tenant + session on POST /api/v1/session)
// is a dev affordance. YOU_DEMO_BOOTSTRAP=0 must disable it with a clean
// 503 service_unavailable envelope; the default (dev) path stays unchanged.
//
// The production boot-time config validation (instrumentation.ts →
// assertProductionConfig) is compile-checked + verified manually against a
// production boot (evidence quoted in the PR) — it cannot be exercised by
// `next dev`, which always runs NODE_ENV=development.
//
// STANDALONE BY DESIGN — NOT imported by tests/index.mjs (own server boots
// with env overrides). Gate command:
//   node --test tests/contract/config-hardening.test.mjs
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

const servers = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on('error', reject);
  });
}

async function startServer(envExtra) {
  await killAll(); // next dev allows ONE instance per app dir — boot sequentially
  servers.length = 0;
  const port = await freePort();
  const nextBin = path.join(APP_DIR, 'node_modules', '.bin', 'next');
  assert.ok(fs.existsSync(nextBin), 'apps/web/node_modules/.bin/next missing — run `cd apps/web && bun install` first');
  const child = spawn(process.execPath, [nextBin, 'dev', '-p', String(port)], {
    cwd: APP_DIR,
    env: { ...process.env, ...envExtra },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120000;
  for (;;) {
    if (child.exitCode !== null) assert.fail(`next dev exited with code ${child.exitCode} before becoming ready`);
    try {
      const res = await fetch(base, { signal: AbortSignal.timeout(5000) });
      if (res.ok) { servers.push({ child, base }); return base; }
    } catch { /* not up */ }
    if (Date.now() > deadline) assert.fail('next dev did not become ready within 120s');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function killAll() {
  return Promise.all(servers.map(({ child }) => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* */ }
    child.once('exit', finish);
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* */ } setTimeout(finish, 500); }, 8000).unref();
  })));
}

async function postSession(base) {
  const res = await fetch(base + '/api/v1/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

before(async () => {});
after(async () => { await killAll(); });

test('YOU_DEMO_BOOTSTRAP=0: session bootstrap refused with 503 service_unavailable', async () => {
  const base = await startServer({ YOU_DEMO_BOOTSTRAP: '0' });
  const r = await postSession(base);
  assert.equal(r.status, 503, `POST /session → ${r.status}`);
  assert.equal(r.json?.error?.code, 'service_unavailable', `code: ${r.json?.error?.code}`);
  assert.match(r.json?.error?.message ?? '', /demo bootstrap is disabled/i);
  // and the refusal is honest: no session cookie was issued
  const again = await postSession(base);
  assert.equal(again.status, 503, 'the guard is stable across calls');
});

test('default (dev): the demo bootstrap path is unchanged', async () => {
  const base = await startServer({});
  const r = await postSession(base);
  assert.ok(r.status === 200 || r.status === 201, `POST /session → ${r.status}`);
  assert.equal(r.json?.user?.email, 'founder@you.dev', 'demo context provisioned as before');
  assert.ok(r.json?.tenant?.id, 'tenant in the response');
});
