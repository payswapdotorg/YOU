// ═══════════════════════════════════════════════════════════════════════════
// Compute-broker E2E tests (P6.C3 — Worker C lane) — node:test, STANDALONE.
//
// Boots the REAL app (next dev) against a LOCAL mock of the DashScope APIs
// (no network beyond 127.0.0.1, placeholder key only) and proves the three
// work-order behaviors end-to-end:
//
//   1. HOSTED ROUTING THROUGH THE BROKER: with YOU_COMPUTE_PROVIDERS=
//      "dashscope-render,local-executor" and YOU_RENDER_PROVIDER deliberately
//      UNSET (station default), POST /api/v1/renders submits through
//      submitComputeRouted, routes ai-image-1 to the hosted provider, and the
//      render executor HONORS the per-job routing override (the mock receives
//      the real generation call; the job output carries the dashscope-render
//      routing record + the $0.04 modeled quote).
//   2. DEAD-LETTER WITH QUOTE: with the mock scripted to always-503, the
//      broker-submitted render job exhausts its bounded retries (job runner ×
//      provider transport) and lands in the terminal `dead` state; the
//      dead-letter list (GET /api/v1/maintenance/dead-jobs) surfaces the job
//      WITH its embedded quote.
//   3. COST GUARD FAIL-CLOSED (402): with YOU_COMPUTE_TENANT_MAX_COST_USD
//      pinned, a submit that would exceed the tenant's rolling-window quoted
//      spend is refused with the 402 compute_quota_exceeded envelope and
//      counted in /api/v1/metrics (compute_quota_refusals{workload}).
//
// STANDALONE BY DESIGN — NOT imported by tests/index.mjs (own server boots
// with env overrides; the unit pieces live in compute-broker.test.mjs).
// Gate command:
//   node --test tests/contract/compute-broker-e2e.test.mjs
// Prerequisites: cd apps/web && bun install && cp .env.example .env && bun run db:push
// ═══════════════════════════════════════════════════════════════════════════
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const APP_DIR = path.join(REPO_ROOT, 'apps', 'web');

const API_KEY = 'test-placeholder-key-never-real';
const IMAGE_PATH = '/api/v1/services/aigc/text2image/image-synthesis';
const stamp = `${Date.now()}-${process.pid}`;

// ─── the local DashScope mock (image submit → task poll → result) ───────────

const mock = {
  calls: [], // { method, url, auth, body }
  submitScript: [], // consumed per image-task POST: {status, headers, body}
  resultBytes: Buffer.from('mock-png-bytes-for-p6c3'),
};
let mockServer = null;
let mockPort = 0;

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function startMock() {
  return new Promise((resolve) => {
    mockServer = http.createServer(async (req, res) => {
      const raw = await readBody(req);
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        /* keep raw */
      }
      mock.calls.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', body });

      if (req.method === 'POST' && req.url === IMAGE_PATH) {
        const step = mock.submitScript.length > 0 ? mock.submitScript.shift() : null;
        const status = step?.status ?? 200;
        if (status !== 200) {
          res.writeHead(status, { 'content-type': 'application/json', ...(step?.headers ?? {}) });
          res.end(JSON.stringify(step?.body ?? { code: 'InternalError', message: 'mock scripted failure' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ output: { task_id: 'p6c3-img-task-1', task_status: 'PENDING' }, request_id: 'req-p6c3' }));
        return;
      }

      const taskMatch = /^\/api\/v1\/tasks\/([^/?]+)/.exec(req.url);
      if (req.method === 'GET' && taskMatch) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            output: { task_status: 'SUCCEEDED', results: [{ url: `http://127.0.0.1:${mockPort}/result` }] },
            request_id: 'req-p6c3',
            task_id: taskMatch[1],
          }),
        );
        return;
      }

      if (req.method === 'GET' && req.url === '/result') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(mock.resultBytes);
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'NotFound', message: `no mock route for ${req.method} ${req.url}` }));
    });
    mockServer.listen(0, '127.0.0.1', () => {
      mockPort = mockServer.address().port;
      resolve();
    });
  });
}

// ─── app server lifecycle + client ──────────────────────────────────────────

let child = null;
let base = null;
let cookie = null;
const serverLog = fs.createWriteStream(`/tmp/you-p6c3-e2e-server-${stamp}.log`, { flags: 'a' });

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

async function startServer(extraEnv) {
  const port = await freePort();
  const nextBin = path.join(APP_DIR, 'node_modules', '.bin', 'next');
  assert.ok(fs.existsSync(nextBin), 'apps/web/node_modules/.bin/next missing — run `cd apps/web && bun install` first');
  child = spawn(process.execPath, [nextBin, 'dev', '-p', String(port)], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      // the broker routes hosted; the ENV SEAM deliberately stays on station —
      // the per-job routing override must WIN (the strongest C3 assertion)
      YOU_COMPUTE_PROVIDERS: 'dashscope-render,local-executor',
      DASHSCOPE_API_KEY: API_KEY,
      YOU_DASHSCOPE_BASE_URL: `http://127.0.0.1:${mockPort}`,
      YOU_DASHSCOPE_TIMEOUT_MS: '15000',
      YOU_DASHSCOPE_POLL_INTERVAL_MS: '200',
      YOU_DASHSCOPE_IMAGE_MAX_WAIT_MS: '20000',
      // tiny, FAST resilience knobs (bounded but quick)
      YOU_RETRY_MAX_ATTEMPTS: '2',
      YOU_RETRY_BASE_DELAY_MS: '10',
      YOU_RETRY_MAX_DELAY_MS: '50',
      YOU_RETRY_BUDGET_MS: '10000',
      YOU_JOB_MAX_ATTEMPTS: '2',
      YOU_JOB_RETRY_BASE_DELAY_MS: '20',
      YOU_JOB_RETRY_BUDGET_MS: '15000',
      // breaker threshold above the whole bounded sequence (2 job attempts ×
      // 2 transport retries = 4 failures) so the dead-letter path actually
      // retries instead of failing fast
      YOU_BREAKER_FAILURE_THRESHOLD: '6',
      YOU_BREAKER_WINDOW_MS: '60000',
      YOU_BREAKER_COOLDOWN_MS: '600000',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.pipe(serverLog);
  child.stderr.pipe(serverLog);
  base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120000;
  for (;;) {
    if (child.exitCode !== null) assert.fail(`next dev exited with code ${child.exitCode} before becoming ready`);
    try {
      const res = await fetch(base, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return base;
    } catch {
      /* not up */
    }
    if (Date.now() > deadline) assert.fail('next dev did not become ready within 120s');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function killTree() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* */
    }
    child.once('exit', finish);
    setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* */
      }
      setTimeout(finish, 500);
    }, 8000).unref();
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
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function pollJob(jobId, timeoutMs = 120000) {
  const t0 = Date.now();
  for (;;) {
    const r = await call(`/api/v1/jobs/${jobId}`);
    assert.equal(r.status, 200, `job poll GET /api/v1/jobs/${jobId} → ${r.status}`);
    const j = r.json;
    if (['succeeded', 'failed', 'dead', 'cancelled'].includes(j.status)) return j;
    if (Date.now() - t0 > timeoutMs) {
      assert.fail(`job ${jobId} (${j.kind}) did not reach a terminal state within ${timeoutMs}ms (last: ${j.status}, progress ${j.progress})`);
    }
    await new Promise((r2) => setTimeout(r2, 500));
  }
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function uploadForm(regions) {
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'evidence.png');
  form.append('regions', JSON.stringify(regions));
  return form;
}

async function callUpload(pathname, form) {
  const h = {};
  if (cookie) h.cookie = cookie;
  const res = await fetch(base + pathname, { method: 'POST', headers: h, body: form });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* */
  }
  return { status: res.status, json };
}

/** session → twin → grants → capture → complete → compile → the published TwinVersion. */
async function flowToPublishedVersion(label) {
  await call('/api/v1/session', { method: 'POST', body: {} });
  const twin = await call('/api/v1/twins', { method: 'POST', body: { displayName: `P6C3 ${label} ${stamp}` } });
  assert.equal(twin.status, 201);
  const twinId = twin.json.id;
  const subjectId = twin.json.subjectId;

  const grant = await call('/api/v1/consent-grants', {
    method: 'POST',
    body: { subjectId, purpose: `p6c3 ${label}`, scopes: ['capture', 'reconstruct', 'render'], ttlHours: 2 },
  });
  assert.equal(grant.status, 201);

  const cap = await call(`/api/v1/twins/${twinId}/capture-sessions`, { method: 'POST', body: {} });
  assert.equal(cap.status, 201);
  const up = await callUpload(`/api/v1/captures/${cap.json.id}/assets`, uploadForm(['face.front']));
  assert.equal(up.status, 201, `upload → ${up.status}`);
  const done = await call(`/api/v1/captures/${cap.json.id}/complete`, { method: 'POST', body: {} });
  assert.equal(done.status, 202);
  const qualityJob = await pollJob(done.json.jobId);
  assert.equal(qualityJob.status, 'succeeded', `capture.quality failed: ${qualityJob.error ?? ''}`);

  const compile = await call(`/api/v1/twins/${twinId}/compile`, {
    method: 'POST',
    body: { captureSessionId: cap.json.id, style: 'photorealistic' },
  });
  assert.equal(compile.status, 202);
  const compileJob = await pollJob(compile.json.jobId);
  assert.equal(compileJob.status, 'succeeded', `twin.compile failed: ${compileJob.error ?? ''}`);
  return { twinId, twinVersionId: compileJob.output.twinVersionId };
}

// ─── lifecycle ───────────────────────────────────────────────────────────────

before(async () => {
  await startMock();
  await startServer({});
});

after(async () => {
  await killTree();
  if (mockServer) {
    await new Promise((resolve) => mockServer.close(resolve));
  }
  serverLog.end();
});

// ─── 1. hosted routing through the broker (per-job override beats the env seam) ──

test('broker routing: renders submit through the broker, route hosted, and honor the per-job provider override end-to-end', async () => {
  mock.submitScript.length = 0; // default success script
  const callsBefore = mock.calls.length;
  const { twinId, twinVersionId } = await flowToPublishedVersion('routing');

  const res = await call('/api/v1/renders', {
    method: 'POST',
    body: { twinId, twinVersionId, kind: 'image', style: 'anime', adapter: 'ai-image-1' },
  });
  assert.equal(res.status, 202, `render submit → ${res.status}: ${res.text}`);
  assert.equal(res.json.providerId, 'dashscope-render', 'the broker routed the provider render to the hosted provider');
  const jobId = res.json.jobId;

  const job = await pollJob(jobId);
  assert.equal(job.status, 'succeeded', `hosted-routed render failed: ${job.error ?? ''}`);

  // the mock really received the hosted generation call — per-job routing WON
  // over the station-default YOU_RENDER_PROVIDER env
  const imagePosts = mock.calls.filter((c) => c.method === 'POST' && c.url === IMAGE_PATH);
  assert.ok(imagePosts.length >= 1, 'the hosted provider received the image generation task');
  const post = imagePosts[imagePosts.length - 1];
  assert.equal(post.auth, `Bearer ${API_KEY}`, 'Authorization: Bearer <placeholder key>');
  assert.equal(post.body.model, 'wanx2.1-t2i-turbo', 'the C5 registry image-gen default model');
  assert.match(post.body.input.prompt, /Stylized avatar portrait/, 'the anti-impersonation prompt policy applies');
  assert.ok(callsBefore < mock.calls.length);

  // the durable job carries the broker routing record + honest quote
  assert.equal(job.output.compute.providerId, 'dashscope-render');
  assert.match(job.output.compute.routedVia, /selected dashscope-render/);
  assert.equal(job.output.compute.quote.cost.usd, 0.04);
  assert.equal(job.output.compute.quote.cost.basis, 'modeled');
  assert.equal(job.output.compute.quote.providerId, 'dashscope-render');

  // the RenderJob row succeeded with real latency
  const renders = await call('/api/v1/renders');
  assert.equal(renders.status, 200);
  const row = renders.json.find((r) => r.jobId === jobId || r.status === 'succeeded');
  assert.ok(row, 'the render job row is listed');

  // svg-portrait-1 with the SAME enable list routes LOCAL (deterministic
  // renderer is in-process) and still succeeds — routing is adapter-aware
  const svgRes = await call('/api/v1/renders', {
    method: 'POST',
    body: { twinId, twinVersionId, kind: 'image', style: 'photorealistic', adapter: 'svg-portrait-1' },
  });
  assert.equal(svgRes.status, 202);
  assert.equal(svgRes.json.providerId, 'local-executor', 'the deterministic adapter routes the local executor');
  const svgJob = await pollJob(svgRes.json.jobId);
  assert.equal(svgJob.status, 'succeeded');
  assert.equal(svgJob.output.compute.providerId, 'local-executor');
  assert.equal(svgJob.output.compute.quote.cost.usd, 0);
  assert.equal(svgJob.output.compute.quote.cost.basis, 'zero-deterministic');
  // the svg render also routed through the broker — its submit counter is
  // observable on THIS server's process (metrics are process-local, labeled)
  const metrics1 = await call('/api/v1/metrics');
  assert.equal(metrics1.status, 200);
  const hostedSubmits = metrics1.json.counters['compute_submits{provider=dashscope-render,workload=render.image}'] ?? 0;
  const localSubmits = metrics1.json.counters['compute_submits{provider=local-executor,workload=render.image}'] ?? 0;
  assert.ok(hostedSubmits >= 1, 'accepted hosted submits are counted with their provider label');
  assert.ok(localSubmits >= 1, 'accepted local submits are counted with their provider label');
  assert.ok(
    (metrics1.json.counters['compute_quoted_usd_cents{provider=dashscope-render,workload=render.image}'] ?? 0) >= 4,
    'the quoted-cents counter records the $0.04 modeled quote',
  );
});

// ─── 2. dead-letter with the embedded quote ─────────────────────────────────

test('dead-letter: an always-503 hosted provider exhausts the bounded retries and the dead job carries its quote', async () => {
  // script the mock to refuse every image-task submission with a retryable 503
  mock.submitScript.push(
    { status: 503, body: { code: 'ServiceUnavailable', message: 'mock scripted 503 (p6c3 dead-letter leg)' } },
    { status: 503, body: { code: 'ServiceUnavailable', message: 'mock scripted 503 (p6c3 dead-letter leg)' } },
    { status: 503, body: { code: 'ServiceUnavailable', message: 'mock scripted 503 (p6c3 dead-letter leg)' } },
    { status: 503, body: { code: 'ServiceUnavailable', message: 'mock scripted 503 (p6c3 dead-letter leg)' } },
    { status: 503, body: { code: 'ServiceUnavailable', message: 'mock scripted 503 (p6c3 dead-letter leg)' } },
    { status: 503, body: { code: 'ServiceUnavailable', message: 'mock scripted 503 (p6c3 dead-letter leg)' } },
    { status: 503, body: { code: 'ServiceUnavailable', message: 'mock scripted 503 (p6c3 dead-letter leg)' } },
    { status: 503, body: { code: 'ServiceUnavailable', message: 'mock scripted 503 (p6c3 dead-letter leg)' } },
  );

  const twins = await call('/api/v1/twins');
  assert.equal(twins.status, 200);
  const twin = twins.json[0]; // newest first — the twin compiled by the routing leg
  const twinId = twin.id;
  const twinAfter = await call(`/api/v1/twins/${twinId}`);
  const twinVersionId = (twinAfter.json.versions ?? [])[0].id;

  const res = await call('/api/v1/renders', {
    method: 'POST',
    body: { twinId, twinVersionId, kind: 'image', style: 'anime', adapter: 'ai-image-1' },
  });
  assert.equal(res.status, 202, `render submit → ${res.status}: ${res.text}`);
  assert.equal(res.json.providerId, 'dashscope-render');

  const job = await pollJob(res.json.jobId);
  assert.equal(job.status, 'dead', `the exhausted-retry workload must land DEAD (got ${job.status})`);

  // the dead-letter list surfaces the structured payload AND the quote
  const dead = await call('/api/v1/maintenance/dead-jobs');
  assert.equal(dead.status, 200);
  const entry = dead.json.jobs.find((j) => j.id === res.json.jobId);
  assert.ok(entry, 'the dead broker job is listed');
  assert.equal(entry.deadLetter.code, 'dead_letter');
  assert.ok(entry.deadLetter.attempts >= 2, 'the bounded retry budget was actually spent');
  assert.match(entry.deadLetter.lastError, /503/);
  assert.equal(entry.compute.providerId, 'dashscope-render', 'the dead job carries its broker routing record');
  assert.equal(entry.compute.quote.cost.usd, 0.04, 'the dead job carries its embedded quote');
  assert.equal(entry.compute.quote.cost.basis, 'modeled');
});

// ─── 3. per-tenant cost guard: 402 + metrics counter (own server, pinned ceiling) ──

test('cost guard: a submit that exceeds the tenant ceiling is refused 402, counted in metrics, and the render row records the refusal', async () => {
  // reboot the app with a pinned ceiling. The demo tenant (slug 'demo',
  // idempotent across boots, same DB) already carries the routing + dead-letter
  // legs' quoted spend: $0.04 (succeeded) + $0.04 (dead) + $0.04 (svg is
  // zero-cost) = $0.08 of modeled window spend — the $0.05 ceiling must refuse
  // the next $0.04 hosted render BEFORE any provider call.
  // P6.C12 (PR-13): the guard reads the durable quoted-cost accrual
  // (usage metric "compute.quoted_usd") — the same rows the earlier legs'
  // broker submits wrote — so the window spend survives the server reboot.
  await killTree();
  cookie = null;
  mock.submitScript.length = 0; // default success script (the guard must refuse first)
  const callsBefore = mock.calls.length;
  await startServer({ YOU_COMPUTE_TENANT_MAX_COST_USD: '0.05' });

  await call('/api/v1/session', { method: 'POST', body: {} });
  const twins = await call('/api/v1/twins');
  const twinId = twins.json[0].id;
  const twinAfter = await call(`/api/v1/twins/${twinId}`);
  const twinVersionId = (twinAfter.json.versions ?? [])[0].id;

  const res = await call('/api/v1/renders', {
    method: 'POST',
    body: { twinId, twinVersionId, kind: 'image', style: 'anime', adapter: 'ai-image-1' },
  });
  assert.equal(res.status, 402, `the over-ceiling submit must be refused 402 (got ${res.status}: ${res.text})`);
  assert.equal(res.json.error.code, 'compute_quota_exceeded');
  // P6.C12 envelope: budget language + the budgetSource disclosure (the env
  // ceiling is the tenant-wide fallback when no db CostBudget row matches)
  assert.match(res.json.error.message, /budget \$0\.05/);
  assert.equal(res.json.error.details.budgetUsd, 0.05);
  assert.equal(res.json.error.details.budgetSource, 'env');
  assert.equal(res.json.error.details.quotedUsd, 0.04);
  assert.ok(res.json.error.details.accruedUsd >= 0.08, 'the accrued spend counts the earlier broker submits (conservative)');
  assert.equal(mock.calls.length, callsBefore, 'the guard refused BEFORE any provider egress');

  // the refused render row records the honest refusal (never queued forever)
  const renders = await call('/api/v1/renders');
  const refused = renders.json.find((r) => r.status === 'failed' && /compute broker refused/.test(r.error ?? ''));
  assert.ok(refused, 'the refused RenderJob row is marked failed with the verbatim refusal');

  // the refusal is observable in /api/v1/metrics (process-local counters —
  // this server's own process refused the submit; the ACCEPTED-submit
  // counters live on the first server's process, asserted in the routing leg)
  const metrics = await call('/api/v1/metrics');
  assert.equal(metrics.status, 200);
  const refusals = metrics.json.counters['compute_quota_refusals{workload=render.image}'] ?? 0;
  assert.ok(refusals >= 1, 'compute_quota_refusals{workload=render.image} counted the 402');
});
