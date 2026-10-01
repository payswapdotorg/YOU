// ═══════════════════════════════════════════════════════════════════════════
// YOU W4.A hardening integration tests (Worker A lane) — node:test, no deps.
//
// Covers the TL-adjudicated W3.C F8 findings:
//   F-01 — Idempotency-Key body-fingerprint binding: same key + same body
//          (any key order) replays to the original record/job; same key +
//          different body → 409 idempotency_conflict. Exercised on templates
//          create AND the job-submitting routes (analyze, compile).
//   F-02 — unmatched /api/v1/* paths return the JSON {error:{code:"not_found"}}
//          envelope (404, application/json) — never framework HTML.
//   F-03 — the session cookie gains `Secure` behind x-forwarded-proto: https
//          (HttpOnly; SameSite=Lax always; name unchanged).
//   F-04 — webhook deliveries carry X-You-Timestamp + X-You-Signature
//          (sha256=HMAC-SHA256(secret, timestamp + "." + rawBody)); the
//          signature verifies against the endpoint's stored secret and a
//          tampered body fails verification (local request-bin listener).
//
// Server lifecycle (NO top-level before() — see the collision note below):
// node:test runs top-level before() hooks from sibling files CONCURRENTLY, so
// two hook-driven `next dev` boots collide on the same apps/web dir. Instead
// each test lazily awaits ensureBase(), a singleton that:
//   - reuses YOU_TEST_BASE when the station exported it;
//   - in an aggregated run (tests/index.mjs sets __YOU_TEST_AGGREGATED__)
//     waits for the sibling suite's server URL on globalThis
//     (__YOU_TEST_BASE__, published by verification-flow.test.mjs) — exactly
//     ONE server per process, ever;
//   - boots its own `next dev` on a free port only for direct file runs /
//     auto-discovery (own process).
//
// Prerequisites = the documented app boot (apps/web/README):
//   cd apps/web && bun install && cp .env.example .env && bun run db:push
// The suite fails loudly when they are missing — no silent skips.
// ═══════════════════════════════════════════════════════════════════════════
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const APP_DIR = path.join(REPO_ROOT, 'apps', 'web');

const stamp = `${Date.now()}-${process.pid}`;
const uid = (p) => `${p}-w4a-${stamp}-${Math.random().toString(36).slice(2, 8)}`;

// ─── tiny HTTP client with session-cookie memory ────────────────────────────
let base = process.env.YOU_TEST_BASE ?? null;
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

/** Raw fetch without the cookie jar (for Set-Cookie inspection, F-03). */
async function raw(pathname, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(base + pathname, { method, headers, body });
  const text = await res.text();
  return { status: res.status, text, setCookie: res.headers.get('set-cookie') };
}

// ─── server lifecycle (lazy singleton boot-or-reuse) ─────────────────────────
let child = null;
let ownServer = false;
let basePromise = null;

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
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.on('data', () => { /* dev chatter — intentionally ignored */ });
  child.stderr.on('data', () => { /* dev chatter — intentionally ignored */ });
  child.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
      console.error(`[w4a-tests] next dev exited early: code=${code} signal=${signal}`);
    }
  });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120000;
  for (;;) {
    if (child.exitCode !== null) assert.fail(`next dev exited with code ${child.exitCode} before becoming ready`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) { base = url; globalThis.__YOU_TEST_BASE__ = url; return; }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) assert.fail(`next dev did not become ready on ${url} within 120s`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Singleton: reuse the sibling suite's server when aggregated, else boot one. */
function ensureBase() {
  if (!basePromise) {
    basePromise = (async () => {
      if (base) return base; // YOU_TEST_BASE (station-provided)
      const aggregated = !!globalThis.__YOU_TEST_AGGREGATED__;
      // aggregated: the sibling suite's before() has already published (or is
      // about to publish) its server URL; NEVER boot a second server in the
      // same process (two next dev instances collide on apps/web/.next).
      const deadline = Date.now() + (aggregated ? 150000 : 5000);
      while (Date.now() < deadline) {
        if (globalThis.__YOU_TEST_BASE__) {
          base = globalThis.__YOU_TEST_BASE__;
          console.log(`[w4a-tests] reusing suite server at ${base}`);
          return base;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(!aggregated, 'aggregated run: the sibling suite never published its server URL within 150s');
      console.log('[w4a-tests] booting apps/web (next dev) on a free port…');
      await startServer();
      ownServer = true;
      console.log(`[w4a-tests] server ready at ${base}`);
      return base;
    })().catch((err) => {
      basePromise = null; // allow a later retry with a fresh boot attempt
      throw err;
    });
  }
  return basePromise;
}

// ─── F-04 support: local request-bin listener + DB secret read ───────────────
let listenerServer = null;
let listenerRecords = null;
let listenerPort = 0;
let prismaClient = null;

function startListener() {
  return new Promise((resolve) => {
    const records = [];
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        records.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, records, port: server.address().port }));
  });
}

/** Resolve the SAME database the app uses: ambient env wins, then apps/web/.env
 * (relative file: URLs resolve against prisma/schema.prisma, like Prisma). */
function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envText = fs.readFileSync(path.join(APP_DIR, '.env'), 'utf8');
  const m = envText.match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?\s*$/m);
  const rawUrl = m?.[1];
  assert.ok(rawUrl, 'apps/web/.env has no DATABASE_URL — run the documented boot first');
  if (rawUrl.startsWith('file:')) {
    const p = rawUrl.slice(5);
    if (!path.isAbsolute(p)) return `file:${path.resolve(APP_DIR, 'prisma', p)}`;
  }
  return rawUrl;
}

async function prisma() {
  if (prismaClient) return prismaClient;
  const requireFromApp = createRequire(path.join(APP_DIR, 'package.json'));
  const { PrismaClient } = requireFromApp('@prisma/client');
  prismaClient = new PrismaClient({ datasourceUrl: resolveDatabaseUrl() });
  return prismaClient;
}

after(async () => {
  if (prismaClient) await prismaClient.$disconnect().catch(() => undefined);
  if (listenerServer) await new Promise((r) => listenerServer.close(r));
  if (ownServer) {
    await killTree();
    if (child && child.pid) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    console.log('[w4a-tests] own server stopped');
  }
  console.log('[w4a-tests] cleanup done');
});

// ═══════════════════════════════════════════════════════════════════════════
// F-02 — API-surface envelope for unmatched /api/v1/* paths
// ═══════════════════════════════════════════════════════════════════════════
test('F-02: unmatched /api/v1/* paths return the JSON not_found envelope (any method)', async () => {
  await ensureBase();

  // establish the session cookie for this module's requests (auth is
  // orthogonal to routing, but the requests should be as realistic as any
  // other API call)
  const s = await call('/api/v1/session', { method: 'POST', body: {} });
  assert.equal(s.status, 200, `POST /session → ${s.status}`);

  for (const method of ['GET', 'POST', 'DELETE']) {
    const r = await call(`/api/v1/${uid('no-such-route')}`, { method, body: method === 'POST' ? {} : undefined });
    assert.equal(r.status, 404, `${method} unmatched → 404, got ${r.status}`);
    assert.match(r.headers.get('content-type') ?? '', /^application\/json/, `${method} content-type must be application/json`);
    assert.equal(r.json?.error?.code, 'not_found', `${method} error.code must be not_found`);
    assert.match(r.json?.error?.message ?? '', /no API route matches/, `${method} message must name the unmatched path`);
  }

  // deep unmatched path (multi-segment, still inside /api/v1)
  const deep = await call(`/api/v1/jobs/${uid('x')}/definitely/not/a/route`);
  assert.equal(deep.status, 404);
  assert.equal(deep.json?.error?.code, 'not_found');

  // control: MATCHED routes keep their own behavior (not hijacked by the catch-all)
  const matched = await raw('/api/v1/session', { method: 'GET' }); // no cookie sent (raw)
  assert.equal(matched.status, 401, 'matched route must still resolve normally (401 without cookie)');
});

// ═══════════════════════════════════════════════════════════════════════════
// F-01 — templates create: idempotency replays are body-fingerprint bound
// ═══════════════════════════════════════════════════════════════════════════
test('F-01 templates: same key + same body → 200 existing (any key order); different body → 409 idempotency_conflict', async () => {
  await ensureBase();
  const key = uid('tpl-f01');
  const name = `W4A F01 Template ${uid('n')}`;
  // same semantic body, deliberately different JSON key order on replay
  const body = {
    name,
    description: 'w4a hardening fingerprint fixture',
    status: 'draft',
    captureChecklist: [
      { item: 'Front face', capability: 'face', region: 'face.front', optional: false },
      { item: 'Hands', capability: 'hands', region: 'hands', optional: true },
    ],
    scenes: [{ name: 'studio-a', parameters: { angle: 'front', lighting: 'even' } }],
  };
  const bodyReordered = {
    scenes: [{ parameters: { lighting: 'even', angle: 'front' }, name: 'studio-a' }],
    captureChecklist: [
      { optional: false, region: 'face.front', capability: 'face', item: 'Front face' },
      { region: 'hands', optional: true, capability: 'hands', item: 'Hands' },
    ],
    status: 'draft',
    description: 'w4a hardening fingerprint fixture',
    name,
  };

  const create = await call('/api/v1/templates', { method: 'POST', body, headers: { 'x-idempotency-key': key } });
  assert.equal(create.status, 201, `create → ${create.status}`);
  const templateId = create.json.id;

  const replaySame = await call('/api/v1/templates', { method: 'POST', body: bodyReordered, headers: { 'x-idempotency-key': key } });
  assert.equal(replaySame.status, 200, `same-key same-body (reordered keys) replay must be 200, got ${replaySame.status}`);
  assert.equal(replaySame.json.id, templateId, 'canonical replay must return the SAME template');
  assert.equal(replaySame.json.createdAt, create.json.createdAt);

  const replayDifferent = await call('/api/v1/templates', {
    method: 'POST',
    body: { ...body, name: `${name}-CHANGED`, description: 'a different payload entirely' },
    headers: { 'x-idempotency-key': key },
  });
  assert.equal(replayDifferent.status, 409, `same-key different-body must be 409, got ${replayDifferent.status}`);
  assert.equal(replayDifferent.json?.error?.code, 'idempotency_conflict');
  assert.match(replayDifferent.json.error.message, new RegExp(key), 'message must name the idempotency key');
  assert.match(replayDifferent.json.error.message, /sha256:[0-9a-f]{64}/, 'message must name both fingerprints');

  // the stored record was neither returned for the different payload nor altered
  const stored = await call(`/api/v1/templates/${templateId}`);
  assert.equal(stored.status, 200);
  assert.equal(stored.json.name, name, 'the stored template must be unchanged by the conflicting replay');
});

// ═══════════════════════════════════════════════════════════════════════════
// F-01 — analyze job route: replay conflicts on a different derived input
// ═══════════════════════════════════════════════════════════════════════════
test('F-01 analyze: same key + same input → 202 same jobId; different template → 409 idempotency_conflict', async () => {
  await ensureBase();
  const mk = async (n) => {
    const t = await call('/api/v1/templates', { method: 'POST', body: { name: `W4A F01 Analyze ${n} ${uid('n')}` } });
    assert.equal(t.status, 201);
    return t.json.id;
  };
  const t1 = await mk('one');
  const t2 = await mk('two');
  const key = uid('analyze-f01');

  const first = await call(`/api/v1/templates/${t1}/analyze`, { method: 'POST', body: {}, headers: { 'x-idempotency-key': key } });
  assert.equal(first.status, 202, `analyze → ${first.status}`);
  const jobId = first.json.jobId;

  const replay = await call(`/api/v1/templates/${t1}/analyze`, { method: 'POST', body: {}, headers: { 'x-idempotency-key': key } });
  assert.equal(replay.status, 202);
  assert.equal(replay.json.jobId, jobId, 'same-key same-input replay must dedupe to the SAME durable job');

  const conflict = await call(`/api/v1/templates/${t2}/analyze`, { method: 'POST', body: {}, headers: { 'x-idempotency-key': key } });
  assert.equal(conflict.status, 409, `same key on a different template must be 409, got ${conflict.status}`);
  assert.equal(conflict.json?.error?.code, 'idempotency_conflict');
});

// ═══════════════════════════════════════════════════════════════════════════
// F-01 — compile job route: replay conflicts on a different body
// ═══════════════════════════════════════════════════════════════════════════
test('F-01 compile: same key + same body → 202 same jobId; different style → 409 idempotency_conflict', async () => {
  await ensureBase();
  const twin = await call('/api/v1/twins', { method: 'POST', body: { displayName: `W4A F01 Twin ${uid('t')}` } });
  assert.equal(twin.status, 201);
  const grant = await call('/api/v1/consent-grants', {
    method: 'POST',
    body: { subjectId: twin.json.subjectId, purpose: 'w4a f01 compile conflict', scopes: ['reconstruct'], ttlHours: 2 },
  });
  assert.equal(grant.status, 201);
  const key = uid('compile-f01');

  const first = await call(`/api/v1/twins/${twin.json.id}/compile`, {
    method: 'POST',
    body: { style: 'anime' },
    headers: { 'x-idempotency-key': key },
  });
  assert.equal(first.status, 202, `compile → ${first.status}`);
  const jobId = first.json.jobId;

  const replay = await call(`/api/v1/twins/${twin.json.id}/compile`, {
    method: 'POST',
    body: { style: 'anime' },
    headers: { 'x-idempotency-key': key },
  });
  assert.equal(replay.status, 202);
  assert.equal(replay.json.jobId, jobId, 'same-key same-body compile replay must dedupe to the SAME durable job');

  const conflict = await call(`/api/v1/twins/${twin.json.id}/compile`, {
    method: 'POST',
    body: { style: 'photorealistic' },
    headers: { 'x-idempotency-key': key },
  });
  assert.equal(conflict.status, 409, `same-key different-style compile must be 409, got ${conflict.status}`);
  assert.equal(conflict.json?.error?.code, 'idempotency_conflict');
});

// ═══════════════════════════════════════════════════════════════════════════
// F-03 — session cookie hardening (Secure behind x-forwarded-proto: https)
// ═══════════════════════════════════════════════════════════════════════════
test('F-03: session cookie adds Secure only when the request is HTTPS (x-forwarded-proto)', async () => {
  await ensureBase();
  const plain = await raw('/api/v1/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(plain.status, 200, `POST /session → ${plain.status}`);
  assert.ok(plain.setCookie?.startsWith('you_session='), 'cookie name must be unchanged (you_session)');
  assert.match(plain.setCookie, /HttpOnly/, 'HttpOnly must always hold');
  assert.match(plain.setCookie, /SameSite=Lax/, 'SameSite=Lax must always hold');
  assert.doesNotMatch(plain.setCookie, /Secure/, 'local HTTP dev must NOT set Secure (the cookie could never be sent back)');

  const https = await raw('/api/v1/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
    body: '{}',
  });
  assert.equal(https.status, 200);
  assert.match(https.setCookie, /Secure/, 'behind x-forwarded-proto: https the cookie MUST carry Secure');
  assert.match(https.setCookie, /HttpOnly/);
  assert.match(https.setCookie, /SameSite=Lax/);

  const explicitHttp = await raw('/api/v1/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'http' },
    body: '{}',
  });
  assert.equal(explicitHttp.status, 200);
  assert.doesNotMatch(explicitHttp.setCookie, /Secure/, 'explicit x-forwarded-proto: http must NOT set Secure');
});

// ═══════════════════════════════════════════════════════════════════════════
// F-04 — signed webhook deliveries (X-You-Signature / X-You-Timestamp)
// ═══════════════════════════════════════════════════════════════════════════
test('F-04: webhook delivery carries a verifiable HMAC signature over timestamp + raw body', async () => {
  await ensureBase();

  // 1) local request-bin listener (tests/audit/listener.mjs pattern, extended
  //    to record headers so the signature can be verified)
  ({ server: listenerServer, records: listenerRecords, port: listenerPort } = await startListener());

  // 2) register a webhook endpoint for consent.granted
  const hook = await call('/api/v1/webhooks', {
    method: 'POST',
    body: { url: `http://127.0.0.1:${listenerPort}/hook`, events: ['consent.granted'] },
  });
  assert.equal(hook.status, 201, `webhook create → ${hook.status}`);
  const webhookId = hook.json.id;
  assert.equal(hook.json.secret, undefined, 'the endpoint view must not expose the signing secret');

  try {
    // 3) read the stored secret directly (the API never exposes it — the same
    //    test-scaffolding pattern as tests/audit/db-probe.mjs)
    const db = await prisma();
    const endpoint = await db.webhookEndpoint.findUnique({ where: { id: webhookId } });
    assert.ok(endpoint?.secret, 'endpoint must have a stored secret');

    // 4) trigger a consent.granted event → background delivery to the listener
    const trigger = await call('/api/v1/consent-grants', {
      method: 'POST',
      body: { subjectId: uid('f04-subject'), purpose: 'w4a signature verification', scopes: ['render'], ttlHours: 1 },
    });
    assert.equal(trigger.status, 201, `grant create → ${trigger.status}`);

    // 5) wait for the delivery (single attempt, 5s timeout — no retry scheduler)
    const deadline = Date.now() + 15000;
    let record = null;
    while (Date.now() < deadline) {
      record = listenerRecords.find((r) => r.method === 'POST' && r.url === '/hook') ?? null;
      if (record) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(record, 'the listener must receive the delivery within 15s');

    // 6) both signature headers present, timestamp is unix seconds
    const tsHeader = record.headers['x-you-timestamp'];
    const sigHeader = record.headers['x-you-signature'];
    assert.ok(tsHeader, 'X-You-Timestamp header must be present');
    assert.match(tsHeader, /^\d{10}$/, 'X-You-Timestamp must be unix seconds');
    assert.ok(Math.abs(Date.now() / 1000 - Number(tsHeader)) < 300, 'timestamp must be close to now');
    assert.match(sigHeader ?? '', /^sha256=[0-9a-f]{64}$/, 'X-You-Signature must be sha256=<64 hex>');

    // 7) the signature verifies: HMAC-SHA256(secret, timestamp + "." + rawBody)
    const expected = createHmac('sha256', endpoint.secret).update(`${tsHeader}.${record.body}`, 'utf8').digest('hex');
    assert.equal(sigHeader, `sha256=${expected}`, 'signature must verify against the stored secret over the EXACT raw body');

    // 8) the body is the documented event envelope (not just any payload)
    const delivered = JSON.parse(record.body);
    assert.equal(delivered.type, 'consent.granted');
    assert.equal(typeof delivered.id, 'string');

    // 9) tampering fails verification (a modified body does not match the signature)
    const tampered = JSON.stringify({ ...delivered, type: 'consent.revoked' });
    const tamperedSig = createHmac('sha256', endpoint.secret).update(`${tsHeader}.${tampered}`, 'utf8').digest('hex');
    assert.notEqual(tamperedSig, expected, 'a tampered body must NOT verify against the delivered signature');
  } finally {
    // cleanup: release the listener + prisma handle NOW (idempotent), and
    // remove the endpoint so later runs fan out to nothing dead
    if (listenerServer) { await new Promise((r) => listenerServer.close(r)); listenerServer = null; }
    if (prismaClient) { await prismaClient.$disconnect().catch(() => undefined); prismaClient = null; }
    const del = await call(`/api/v1/webhooks/${webhookId}`, { method: 'DELETE' });
    assert.equal(del.status, 204, `webhook delete → ${del.status}`);
  }
});
