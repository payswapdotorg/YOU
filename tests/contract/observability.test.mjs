// ═══════════════════════════════════════════════════════════════════════════
// YOU observability tests (P6.A7) — node:test.
//
// Boots its OWN server and proves:
//   1. GET /api/v1/health — unauthenticated 200 with the honest shape
//      (status/db/uptimeSeconds/version), no-store cache control;
//   2. every /api/v1/* response carries an x-request-id (uuid), and an
//      INBOUND valid id is honored + echoed (trace stitching);
//   3. garbage inbound ids are replaced (header-smuggling guard);
//   4. the request id is VISIBLE to handlers (audit correlation): the
//      session route echoes nothing secret, so the proof is the middleware
//      contract itself — the id is on the request the handler saw (asserted
//      indirectly: the response id equals the generated/echoed one, and a
//      handler-side consumption path exists via request.headers).
//
// STANDALONE BY DESIGN — NOT imported by tests/index.mjs. Gate command:
//   node --test tests/contract/observability.test.mjs
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('health: unauthenticated honest probe (200, shape, no-store)', async () => {
  const res = await fetch(base + '/api/v1/health'); // NO auth of any kind
  assert.equal(res.status, 200, `health → ${res.status}`);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const j = await res.json();
  assert.equal(j.status, 'ok');
  assert.equal(j.db, 'ok');
  assert.ok(Number.isFinite(j.uptimeSeconds) && j.uptimeSeconds >= 0);
  assert.ok(j.version && j.checkedAt, 'version + timestamp present');
});

test('request-id: every /api/v1 response carries one (uuid)', async () => {
  const res = await fetch(base + '/api/v1/health');
  const id = res.headers.get('x-request-id');
  assert.match(id ?? '', UUID_RE, `expected a uuid, got ${id}`);
  // a second request gets a DIFFERENT id (per-request correlation)
  const res2 = await fetch(base + '/api/v1/health');
  assert.notEqual(res2.headers.get('x-request-id'), id);
});

test('request-id: valid inbound id honored + echoed (trace stitching)', async () => {
  const inbound = 'trace-abc123XYZ.2026-10-02_001';
  const res = await fetch(base + '/api/v1/health', { headers: { 'x-request-id': inbound } });
  assert.equal(res.headers.get('x-request-id'), inbound, 'inbound id echoed for stitching');
});

test('request-id: garbage inbound ids are replaced (smuggling guard)', async () => {
  for (const bad of ['short', 'x'.repeat(65), 'has spaces and $ymbols', '']) {
    const res = await fetch(base + '/api/v1/health', { headers: { 'x-request-id': bad } });
    const id = res.headers.get('x-request-id') ?? '';
    assert.match(id, UUID_RE, `garbage ${JSON.stringify(bad)} must be replaced with a uuid`);
  }
});

test('request-id: applies across the API surface (session route too)', async () => {
  const res = await fetch(base + '/api/v1/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-request-id': 'trace-sess-99887766' },
    body: '{}',
  });
  assert.equal(res.headers.get('x-request-id'), 'trace-sess-99887766');
  assert.ok(res.ok, `session create → ${res.status}`);
});
