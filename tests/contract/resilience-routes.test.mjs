// ═══════════════════════════════════════════════════════════════════════════
// YOU resilience ROUTE tests (P6.A6-FULL, Worker A lane) — node:test.
//
// Boots the app with the openrouter recon provider pointed at a LOCAL mock
// that always answers 503 (retry-after: 0) and tiny resilience knobs, then
// proves the FULL production paths end-to-end:
//
//   1. dead-letter flow — upload evidence → complete → capture.quality job →
//      provider 503s → bounded provider retries (breaker-INSIDE-retry, so the
//      breaker observes EVERY failed attempt) → bounded JOB retries → terminal
//      `dead` with a structured payload; the breaker opens on the LAST failed
//      attempt of the sequence (threshold 4 = 2 job attempts × 2 fetch
//      attempts — all of them saw 503);
//   2. graceful degraded state — with the breaker open, POST /twins/:id/compile
//      returns an honest 503 (service_unavailable, Retry-After, guidance),
//      NOT a hang and NOT an enqueued doomed job;
//   3. breaker admin route — snapshot, manual reset (re-opens traffic),
//      invalid provider/action → 400;
//   4. metrics route — admin-gated (401 anonymous, 403 api key): counters
//      (provider retries, job retries, dead jobs, rate-limit hits), breaker
//      states, tenant dead-job count;
//   5. dead-jobs route — admin-gated list with parsed dead-letter payloads;
//      replay re-queues and re-dead-letters; purge respects retention;
//   6. rate-limit hits counter — a 5th session bootstrap inside the window
//      is refused 429 and counted.
//
// STANDALONE BY DESIGN — NOT imported by tests/index.mjs (own server boots
// with env overrides; the unit pieces live in resilience.test.mjs).
// Gate command:
//   node --test tests/contract/resilience-routes.test.mjs
// Prerequisites: cd apps/web && bun install && cp .env.example .env && bun run db:push
// ═══════════════════════════════════════════════════════════════════════════
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const APP_DIR = path.join(REPO_ROOT, 'apps', 'web');

const stamp = `${Date.now()}-${process.pid}`;
const API_KEY = 'test-or-key-p6a6full';
const FAIL_MODEL = 'test/vision-down';

// deterministic sample bytes (a real 8x8 PNG)
const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dwn4GBgYGJgQoAAF9vAgOZcDyHAAAAAElFTkSuQmCC',
);

// ─── the failing OpenRouter mock: always 503 + retry-after: 0 ───────────────
const mockCalls = [];
let mockServer = null;
let mockPort = 0;

function startMock() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        mockCalls.push({ url: req.url, auth: req.headers.authorization || '' });
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' });
        res.end(JSON.stringify({ error: { message: 'provider overwhelmed (mock)' } }));
      });
    });
    mockServer.listen(0, '127.0.0.1', () => { mockPort = mockServer.address().port; resolve(); });
  });
}

// ─── app client with session-cookie memory ──────────────────────────────────
// Every client carries a UNIQUE x-forwarded-for identity: the session-bootstrap
// rate-limit bucket keys on client IP (else 'unknown'), and tests must not
// eat each other's windows (the rate-limit test below deliberately uses raw
// fetches with NO x-forwarded-for — the shared 'unknown' identity — for its
// 4-pass + 429 sequence).
let clientSeq = 0;
function makeClient() {
  const ip = `10.42.${Math.floor(++clientSeq / 250)}.${(clientSeq % 250) + 1}`;
  let cookie = null;
  async function call(pathname, { method = 'GET', body, headers = {} } = {}) {
    const h = { 'x-forwarded-for': ip, ...headers };
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
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  call.upload = async (pathname, form) => {
    const h = { 'x-forwarded-for': ip, ...form.headers };
    if (cookie) h.cookie = cookie;
    const res = await fetch(base + pathname, { method: 'POST', headers: h, body: form.body });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  call.forget = () => { cookie = null; };
  return call;
}

function uploadForm() {
  const boundary = `----youp6a6${stamp}`;
  const head = `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="sample.png"\r\ncontent-type: image/png\r\n\r\n`;
  const tail = `\r\n--${boundary}\r\ncontent-disposition: form-data; name="regions"\r\n\r\n["face.front"]\r\n--${boundary}--\r\n`;
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat([Buffer.from(head, 'utf8'), SAMPLE_PNG, Buffer.from(tail, 'utf8')]),
  };
}

// ─── server lifecycle ────────────────────────────────────────────────────────
let child = null;
let base = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on('error', reject);
  });
}

async function startServer() {
  const port = await freePort();
  const nextBin = path.join(APP_DIR, 'node_modules', '.bin', 'next');
  assert.ok(fs.existsSync(nextBin), 'apps/web/node_modules/.bin/next missing — run `cd apps/web && bun install` first');
  child = spawn(process.execPath, [nextBin, 'dev', '-p', String(port)], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      // recon provider → local failing mock
      YOU_RECON_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: API_KEY,
      YOU_RECON_MODEL: FAIL_MODEL,
      YOU_RECON_BASE_URL: `http://127.0.0.1:${mockPort}`,
      YOU_RECON_TIMEOUT_MS: '15000',
      // tiny, FAST resilience knobs (bounded but quick)
      YOU_RETRY_MAX_ATTEMPTS: '2',        // 2 fetches per provider call
      YOU_RETRY_BASE_DELAY_MS: '10',
      YOU_RETRY_MAX_DELAY_MS: '50',
      YOU_RETRY_BUDGET_MS: '10000',
      YOU_JOB_MAX_ATTEMPTS: '2',          // job retried once, then dead
      YOU_JOB_RETRY_BASE_DELAY_MS: '20',
      YOU_JOB_RETRY_BUDGET_MS: '15000',
      // breaker: opens once the FULL bounded sequence (2 job attempts × 2
      // fetch attempts = 4) has failed — every failed attempt counts (the
      // breaker sits INSIDE the retry loop), and after opening it stays open
      // (cooldown 10min, longer than the whole suite)
      YOU_BREAKER_ENABLED: '1',
      YOU_BREAKER_FAILURE_THRESHOLD: '4',
      YOU_BREAKER_WINDOW_MS: '60000',
      YOU_BREAKER_COOLDOWN_MS: '600000',
      // rate limit: 4 session bootstraps/min per identity
      YOU_RATE_LIMIT_SESSION_PER_MIN: '4',
      // dead-job retention: default-ish, explicit for the purge assertion
      YOU_DEAD_JOB_RETENTION_DAYS: '30',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  // server output is kept as evidence (retry/warning lines from the
  // resilience paths land here) — not swallowed, never asserted on
  const serverLog = fs.createWriteStream(`/tmp/you-a6-e2e-server-${stamp}.log`, { flags: 'a' });
  child.stdout.pipe(serverLog);
  child.stderr.pipe(serverLog);
  base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120000;
  for (;;) {
    if (child.exitCode !== null) assert.fail(`next dev exited with code ${child.exitCode} before becoming ready`);
    try {
      const res = await fetch(base, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return base;
    } catch { /* not up */ }
    if (Date.now() > deadline) assert.fail('next dev did not become ready within 120s');
    await new Promise((r) => setTimeout(r, 1000));
  }
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

/** poll a durable job to a terminal state (dead included) */
async function pollJob(call, jobId, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await call(`/api/v1/jobs/${jobId}`);
    assert.equal(job.status, 200);
    if (['succeeded', 'failed', 'dead', 'cancelled'].includes(job.json.status)) return job.json;
    if (Date.now() > deadline) assert.fail(`job ${jobId} did not reach a terminal state within ${timeoutMs}ms (last: ${job.json.status})`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** upload → complete → the doomed capture.quality job */
async function runQualityFlow(call) {
  await call('/api/v1/session', { method: 'POST', body: {} });
  const twin = await call('/api/v1/twins', { method: 'POST', body: { displayName: `P6A6 ${stamp}` } });
  assert.equal(twin.status, 201);
  const { id: twinId, subjectId } = twin.json;
  const grant = await call('/api/v1/consent-grants', {
    method: 'POST',
    body: { subjectId, purpose: `p6a6 ${stamp}`, scopes: ['capture'], ttlHours: 2 },
  });
  assert.equal(grant.status, 201);
  const cap = await call(`/api/v1/twins/${twinId}/capture-sessions`, { method: 'POST', body: {} });
  assert.equal(cap.status, 201);
  const up = await call.upload(`/api/v1/captures/${cap.json.id}/assets`, uploadForm());
  assert.equal(up.status, 201, `upload → ${up.status}`);
  const done = await call(`/api/v1/captures/${cap.json.id}/complete`, { method: 'POST', body: {} });
  assert.equal(done.status, 202, `complete → ${done.status}`);
  return pollJob(call, done.json.jobId);
}

// ─── tests ───────────────────────────────────────────────────────────────────

before(async () => { await startMock(); await startServer(); });
after(async () => { await killTree(); await new Promise((r) => mockServer.close(r)); });

test('dead-letter flow: provider 503s exhaust bounded retries → terminal dead + structured payload + breaker opens', async () => {
  const callsBefore = mockCalls.length;
  const call = makeClient();
  const job = await runQualityFlow(call);

  assert.equal(job.status, 'dead', `expected dead, got ${job.status} (${job.error})`);
  // the structured dead-letter payload parses and tells the truth
  const dl = JSON.parse(job.error);
  assert.equal(dl.code, 'dead_letter');
  assert.equal(dl.attempts, 2, 'job retried once (YOU_JOB_MAX_ATTEMPTS=2)');
  assert.equal(dl.stoppedBy, 'exhausted-attempts');
  assert.match(dl.lastError, /503/);
  assert.ok(dl.firstAttemptAt && dl.lastErrorAt);

  // bounded: exactly 4 provider fetches (2 job attempts × 2 fetch attempts)
  // — never infinite, and the breaker opened on the 4th (final) failure
  assert.equal(mockCalls.length - callsBefore, 4, 'provider called exactly 2x2 times (bounded)');

  // the breaker opened — it observed every failed attempt (inside the loop)
  const brk = await call('/api/v1/maintenance/provider-breaker');
  assert.equal(brk.status, 200);
  assert.equal(brk.json.breakers.openrouter.state, 'open');
  assert.equal(brk.json.breakers.openrouter.failuresInWindow, 4);
  assert.match(brk.json.breakers.openrouter.openedReason, /failures within/);
});

test('degraded state: breaker open → POST compile answers honest 503 + Retry-After (no hang, no doomed enqueue)', async () => {
  const call = makeClient();
  await call('/api/v1/session', { method: 'POST', body: {} });
  const res = await call('/api/v1/twins/does-not-matter/compile', { method: 'POST', body: {} });
  assert.equal(res.status, 503, `expected 503, got ${res.status}`);
  assert.equal(res.json.error.code, 'service_unavailable');
  assert.match(res.json.error.message, /openrouter/);
  assert.match(res.json.error.message, /circuit breaker open/i);
  const details = res.json.error.details;
  assert.equal(details.provider, 'openrouter');
  assert.equal(details.breakerState, 'open');
  assert.ok(details.retryAfterSeconds >= 1, 'retry guidance present');
  assert.ok(details.guidance && details.guidance.length > 10);
  const retryAfter = Number(res.headers.get('retry-after'));
  assert.ok(Number.isFinite(retryAfter) && retryAfter >= 1, 'Retry-After header present');
});

test('breaker admin: manual reset re-opens traffic; invalid input is a 400', async () => {
  const call = makeClient();
  await call('/api/v1/session', { method: 'POST', body: {} });

  // invalid provider / action
  const badProvider = await call('/api/v1/maintenance/provider-breaker', {
    method: 'POST', body: { provider: 'bogus', action: 'reset' },
  });
  assert.equal(badProvider.status, 400);
  const badAction = await call('/api/v1/maintenance/provider-breaker', {
    method: 'POST', body: { provider: 'openrouter', action: 'explode' },
  });
  assert.equal(badAction.status, 400);

  // reset → the degraded gate lets traffic through again (twin lookup proceeds → 404)
  const reset = await call('/api/v1/maintenance/provider-breaker', {
    method: 'POST', body: { provider: 'openrouter', action: 'reset', reason: 'incident resolved' },
  });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.breakers.openrouter.state, 'closed');

  const compile = await call('/api/v1/twins/does-not-matter/compile', { method: 'POST', body: {} });
  assert.equal(compile.status, 404, 'gate passed — the 404 is the honest twin lookup');
});

test('metrics route: admin-gated (401 anonymous / 403 api key) and reports the resilience picture', async () => {
  // anonymous → 401
  const anon = await fetch(base + '/api/v1/metrics');
  assert.equal(anon.status, 401);
  // api key (even read scope) → 403 (operator session only, maintenance law)
  const owner = makeClient();
  await owner('/api/v1/session', { method: 'POST', body: {} });
  const keyRes = await owner('/api/v1/api-keys', { method: 'POST', body: { name: 'p6a6 metrics', scopes: ['read'] } });
  assert.equal(keyRes.status, 201);
  const withKey = await fetch(base + '/api/v1/metrics', {
    headers: { authorization: `Bearer ${keyRes.json.secret}` },
  });
  assert.equal(withKey.status, 403);

  // operator session → the honest picture
  const metrics = await owner('/api/v1/metrics');
  assert.equal(metrics.status, 200);
  const m = metrics.json;
  assert.equal(m.scope.countersAndBreakers.includes('process-local'), true, 'scope is labeled');
  assert.ok(m.counters['provider_retries{operation=vision,provider=openrouter}'] >= 2, 'provider retries counted');
  assert.ok(m.counters['job_retries{kind=capture.quality}'] >= 1, 'job retries counted');
  assert.ok(m.counters['dead_jobs{kind=capture.quality}'] >= 1, 'dead jobs counted');
  assert.ok(m.breakers.openrouter, 'breaker state exposed');
  assert.equal(m.breakers.openrouter.state, 'closed', 'state reflects the reset from the previous test');
  assert.ok(m.deadJobs.count >= 1, 'tenant dead-job count (db truth)');
  assert.equal(m.deadJobs.retentionDays, 30);
  assert.ok((m.jobs.dead ?? 0) >= 1, 'job status counts include dead');
});

test('rate-limit hits are counted for the metrics surface', async () => {
  // YOU_RATE_LIMIT_SESSION_PER_MIN=4 for identity 'unknown' (no x-forwarded-for)
  for (let i = 0; i < 4; i += 1) {
    const r = await fetch(base + '/api/v1/session', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(r.status, 200, `bootstrap ${i + 1} should pass (limit 4)`);
  }
  const fifth = await fetch(base + '/api/v1/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(fifth.status, 429, '5th bootstrap in the window is refused');

  const owner = makeClient();
  await owner('/api/v1/session', { method: 'POST', body: {} }); // own identity (own cookie jar)
  const metrics = await owner('/api/v1/metrics');
  assert.equal(metrics.status, 200);
  assert.ok(
    (metrics.json.counters['rate_limit_hits{bucket=session-bootstrap}'] ?? 0) >= 1,
    'rate-limit hits counted per bucket',
  );
});

test('dead-jobs route: admin-gated listing with parsed payloads; replay re-queues and re-dead-letters; purge respects retention', async () => {
  // gating
  const anon = await fetch(base + '/api/v1/maintenance/dead-jobs');
  assert.equal(anon.status, 401);

  const owner = makeClient();
  await owner('/api/v1/session', { method: 'POST', body: {} });
  const keyRes = await owner('/api/v1/api-keys', { method: 'POST', body: { name: 'p6a6 dj', scopes: ['read', 'write'] } });
  const withKey = await fetch(base + '/api/v1/maintenance/dead-jobs', {
    headers: { authorization: `Bearer ${keyRes.json.secret}` },
  });
  assert.equal(withKey.status, 403, 'api keys are not permitted (operator session only)');

  // listing carries the parsed dead-letter payload
  const list = await owner('/api/v1/maintenance/dead-jobs');
  assert.equal(list.status, 200);
  assert.ok(list.json.jobs.length >= 1, 'the dead job is listed');
  const dead = list.json.jobs[0]; // most recent first
  assert.equal(dead.status, 'dead');
  assert.equal(dead.deadLetter.code, 'dead_letter');
  assert.equal(dead.deadLetter.attempts, 2);
  assert.match(dead.deadLetter.lastError, /503/);
  assert.equal(list.json.retentionDays, 30);

  // replay validation
  const badAction = await owner('/api/v1/maintenance/dead-jobs', { method: 'POST', body: { action: 'nope' } });
  assert.equal(badAction.status, 400);
  const notDead = await owner('/api/v1/maintenance/dead-jobs', {
    method: 'POST', body: { action: 'replay', jobId: 'missing-id' },
  });
  assert.equal(notDead.status, 404);

  // replay: breaker is closed (reset earlier) → the replayed job trips it
  // again through the same bounded path and dead-letters AGAIN
  const replay = await owner('/api/v1/maintenance/dead-jobs', {
    method: 'POST', body: { action: 'replay', jobId: dead.id },
  });
  assert.equal(replay.status, 202);
  assert.equal(replay.json.replayed, true);
  const rerun = await pollJob(owner, dead.id);
  assert.equal(rerun.status, 'dead', `replayed job re-dead-letters (got ${rerun.status})`);
  const dl2 = JSON.parse(rerun.error);
  assert.equal(dl2.attempts, 2);

  // purge: fresh dead jobs are INSIDE the 30-day retention → nothing purged
  const purge = await owner('/api/v1/maintenance/dead-jobs', { method: 'POST', body: { action: 'purge' } });
  assert.equal(purge.status, 200);
  assert.equal(purge.json.purged, 0, 'retention policy holds fresh dead jobs');
  assert.equal(purge.json.retentionDays, 30);

  // the replayed job is still listed
  const list2 = await owner('/api/v1/maintenance/dead-jobs');
  assert.ok(list2.json.jobs.some((j) => j.id === dead.id), 'the replayed+re-dead job remains inspectable');
});
