// ═══════════════════════════════════════════════════════════════════════════
// YOU P6.A6-FULL resilience end-to-end tests (Worker A lane) — node:test.
//
// One booted `next dev` (own port, own SQLite file, own env knobs set FAST)
// with the recon provider pointed at a LOCAL MOCK OpenRouter (no network,
// no real credentials — a placeholder key only) and a local webhook
// listener. Proves the wired behavior end-to-end:
//
//   1. admin gates: /api/v1/metrics is operator-session only (401 / 403);
//   2. bounded provider retries with Retry-After respect: a 429-then-200
//      provider recovers and the compile job SUCCEEDS;
//   3. dead-letter: an always-500 provider exhausts the bounded attempts →
//      the job lands terminal `dead` with the structured payload; the
//      job.dead webhook delivery retries (500,500,200) and succeeds;
//   4. circuit breaker: the breaker opens after the failure threshold →
//      POST /twins/:id/compile returns an HONEST 503 (provider-unavailable,
//      retry guidance) in <3s — no spin, no hang (the reconstruction
//      executor's graceful degraded state);
//   5. manual breaker reset → full recovery through the real executor;
//   6. dead-job replay: the SAME row re-queued and succeeded; replaying a
//      non-dead job is a 409, unknown is a 404;
//   7. metrics surface: retries, dead jobs, breaker states, rate-limit hits.
//
// STANDALONE BY DESIGN — NOT imported by tests/index.mjs (own env + own
// database). Gate command:
//   node --test tests/contract/resilience.test.mjs
// Prerequisites: cd apps/web && bun install (the suite pushes its own
// throwaway SQLite schema and boots its own server).
// ═══════════════════════════════════════════════════════════════════════════
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const APP_DIR = path.join(REPO_ROOT, 'apps', 'web');
const DB_DIR = fs.mkdtempSync('/tmp/you-a6-e2e-');
const DB_PATH = path.join(DB_DIR, 'custom.db');
const SERVER_LOG = path.join(DB_DIR, 'server.log');

const stamp = `${Date.now()}-${process.pid}`;
const uid = (p) => `${p}-a6-${stamp}-${Math.random().toString(36).slice(2, 8)}`;

// ─── mock OpenRouter (vision provider) ──────────────────────────────────────

const VISION_CONTENT = JSON.stringify({
  usable: true,
  blur: 'none',
  lighting: 'good',
  issues: [],
  observedRegions: ['face.front', 'face.profile', 'hands'],
  score: 0.82,
  descriptors: {
    build: 'average',
    ageEstimate: 'adult',
    presentation: null,
    hair: 'short',
    hairColorTone: 'dark brown',
    hairColorHex: '#3b2a20',
    skinToneTone: 'medium',
    skinToneHex: '#c8956c',
    eyeTone: 'brown',
    eyeToneHex: '#4a342a',
    clothingItems: ['t-shirt'],
    clothingStyle: 'casual',
    clothingColorHexes: ['#565a64'],
    distinguishing: [],
    facialHair: null,
    glasses: false,
  },
  geometryHints: { shoulderRatio: 0.23, headRatio: 0.14, faceShape: 'oval' },
  confidence: { overall: 0.75, morphology: 0.7, appearance: 0.75, geometry: 0.65 },
});
const SUCCESS_BODY = JSON.stringify({
  model: 'mock-vlm',
  choices: [{ message: { content: VISION_CONTENT } }],
});

/** scripted responses (queue) + a default mode when the queue is empty. */
const provider = {
  port: 0,
  requests: [], // { at, path, auth }
  script: [], // { status, retryAfter?, body? }
  mode: { status: 200 },
};

function startMockProvider() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        provider.requests.push({ at: Date.now(), method: req.method, url: req.url, auth: req.headers.authorization ?? null, body });
        const step = provider.script.length > 0 ? provider.script.shift() : provider.mode;
        if (step.status === 200) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(step.body ?? SUCCESS_BODY);
          return;
        }
        const headers = { 'content-type': 'application/json' };
        if (step.retryAfter !== undefined) headers['retry-after'] = String(step.retryAfter);
        res.writeHead(step.status, headers);
        res.end(JSON.stringify({ error: { message: `mock ${step.status}` } }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      provider.port = server.address().port;
      resolve(server);
    });
  });
}

// ─── webhook listener: fails twice per event, then accepts ──────────────────

const webhookListener = {
  port: 0,
  records: [], // { eventId, type, jobId, headers, n }
  hitsByEvent: new Map(),
};

function startWebhookListener() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch {
          /* */
        }
        const eventId = parsed?.id ?? 'unknown';
        const n = (webhookListener.hitsByEvent.get(eventId) ?? 0) + 1;
        webhookListener.hitsByEvent.set(eventId, n);
        webhookListener.records.push({
          eventId,
          type: parsed?.type ?? null,
          jobId: parsed?.payload?.jobId ?? null,
          headers: req.headers,
          n,
        });
        // per-event: first two deliveries fail 500, the third succeeds
        if (n <= 2) {
          res.writeHead(500);
          res.end('mock receiver error');
        } else {
          res.writeHead(200);
          res.end('ok');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      webhookListener.port = server.address().port;
      resolve(server);
    });
  });
}

// ─── app server lifecycle ────────────────────────────────────────────────────

let child = null;
let base = null;
let cookie = null;
let apiKeySecret = null;
let mockServers = [];

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

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
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    child.once('exit', finish);
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* */
      }
      setTimeout(finish, 500);
    }, 8000).unref();
  });
}

async function call(pathname, { method = 'GET', body, form, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
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

/** Same as call() but WITHOUT the session cookie (raw auth negatives). */
async function raw(pathname, { method = 'GET', body, headers = {} } = {}) {
  let payload;
  const h = { ...headers };
  if (body !== undefined) {
    h['content-type'] = h['content-type'] ?? 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + pathname, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* */
  }
  return { status: res.status, json, text, headers: res.headers };
}

const TERMINAL = ['succeeded', 'failed', 'dead'];
async function pollJob(jobId, timeoutMs = 90_000) {
  const t0 = Date.now();
  for (;;) {
    const r = await call(`/api/v1/jobs/${jobId}`);
    assert.equal(r.status, 200, `job poll GET /api/v1/jobs/${jobId} → ${r.status}`);
    const j = r.json;
    assert.ok(
      ['queued', 'provisioning', 'running', 'collecting', ...TERMINAL].includes(j.status),
      `unknown job status ${j.status}`,
    );
    if (TERMINAL.includes(j.status)) return j;
    if (Date.now() - t0 > timeoutMs) {
      assert.fail(`job ${jobId} (${j.kind}) did not reach a terminal state within ${timeoutMs}ms (last: ${j.status}, progress ${j.progress})`);
    }
    await new Promise((r2) => setTimeout(r2, 500));
  }
}

// minimal valid PNG (1×1) — the same fixture the W3.A suite uses
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

before(async () => {
  // 1) throwaway database for THIS suite (hermetic; the ambient station DB
  //    stays untouched — ambient DATABASE_URL would otherwise win)
  const push = spawnSync('bun', ['run', 'db:push'], {
    cwd: APP_DIR,
    env: { ...process.env, DATABASE_URL: `file:${DB_PATH}` },
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(push.status, 0, `prisma db push for the throwaway DB failed:\n${push.stdout}\n${push.stderr}`);

  // 2) local mocks (provider + webhook receiver)
  mockServers.push(await startMockProvider());
  mockServers.push(await startWebhookListener());

  // 3) boot the app with the resilience knobs set FAST and the recon seam
  //    pointed at the mock provider
  const port = await freePort();
  const nextBin = path.join(APP_DIR, 'node_modules', '.bin', 'next');
  assert.ok(fs.existsSync(nextBin), 'apps/web/node_modules/.bin/next missing — run `cd apps/web && bun install` first');
  const logStream = fs.createWriteStream(SERVER_LOG, { flags: 'a' });
  child = spawn(process.execPath, [nextBin, 'dev', '-p', String(port)], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      DATABASE_URL: `file:${DB_PATH}`,
      YOU_RECON_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'test-key-placeholder-not-a-real-credential',
      YOU_RECON_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
      YOU_RECON_TIMEOUT_MS: '5000',
      YOU_PROVIDER_MAX_ATTEMPTS: '2',
      YOU_PROVIDER_RETRY_BASE_DELAY_MS: '60',
      YOU_PROVIDER_RETRY_MAX_DELAY_MS: '300',
      YOU_PROVIDER_BREAKER_FAILURES: '5',
      YOU_PROVIDER_BREAKER_WINDOW_MS: '600000',
      YOU_PROVIDER_BREAKER_COOLDOWN_MS: '600000', // stays open until the manual reset
      YOU_JOB_MAX_ATTEMPTS: '2',
      YOU_JOB_RETRY_BASE_DELAY_MS: '80',
      YOU_JOB_RETRY_MAX_DELAY_MS: '300',
      YOU_WEBHOOK_MAX_ATTEMPTS: '4',
      YOU_WEBHOOK_RETRY_BASE_DELAY_MS: '40',
      YOU_WEBHOOK_RETRY_MAX_DELAY_MS: '200',
      YOU_RATE_LIMIT_SESSION_PER_MIN: '5',
      YOU_DEAD_JOB_RETENTION_DAYS: '30',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  base = `http://127.0.0.1:${port}`;

  const deadline = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) assert.fail('next dev exited before ready (see ' + SERVER_LOG + ')');
    try {
      const res = await fetch(base, { signal: AbortSignal.timeout(5000) });
      if (res.ok) break;
    } catch {
      /* not ready yet */
    }
    if (Date.now() > deadline) assert.fail('next dev did not become ready within 120s');
    await new Promise((r) => setTimeout(r, 1000));
  }

  // 4) operator session + webhook endpoint (job.dead only — quiet otherwise)
  const session = await raw('/api/v1/session', { method: 'POST', body: {} });
  assert.ok(session.status === 200 || session.status === 201, `session bootstrap → ${session.status}`);
  cookie = session.headers.get('set-cookie').split(';')[0];
  const key = await call('/api/v1/api-keys', { method: 'POST', body: { name: uid('a6-metrics'), scopes: ['read'] } });
  assert.equal(key.status, 201, `api key create → ${key.status}`);
  apiKeySecret = key.json.secret;
  const hook = await call('/api/v1/webhooks', {
    method: 'POST',
    body: { url: `http://127.0.0.1:${webhookListener.port}/hook`, events: ['job.dead'] },
  });
  assert.equal(hook.status, 201, `webhook create → ${hook.status}`);
});

after(async () => {
  await killTree();
  // the local mocks are part of THIS process — close them so the runner
  // exits instead of hanging on open server handles
  for (const server of mockServers) await closeServer(server);
  mockServers = [];
});

// ─── shared state across the sequenced scenarios ────────────────────────────
let twinId = null;
let captureId = null;
let deadJobId = null;

// ═══════════════════════════════════════════════════════════════════════════
// 1 — admin gates + metrics shape
// ═══════════════════════════════════════════════════════════════════════════
test('metrics surface is admin-gated and honestly shaped', async () => {
  const anon = await raw('/api/v1/metrics');
  assert.equal(anon.status, 401, `no auth → ${anon.status}`);
  assert.equal(anon.json.error.code, 'unauthenticated');

  const viaKey = await raw('/api/v1/metrics', { headers: { authorization: `Bearer ${apiKeySecret}` } });
  assert.equal(viaKey.status, 403, `api key (read scope) must be refused → ${viaKey.status}`);
  assert.match(viaKey.json.error.message, /operator session/);

  const viaSession = await call('/api/v1/metrics');
  assert.equal(viaSession.status, 200, `operator session → ${viaSession.status}`);
  const m = viaSession.json;
  assert.ok(m.counters && typeof m.counters === 'object', 'counters object present');
  assert.ok(m.breakers && m.breakers.zai && m.breakers.openrouter, 'per-provider breaker snapshots present');
  assert.equal(m.breakers.zai.state, 'closed', 'zai breaker untouched so far');
  assert.equal(m.breakers.openrouter.state, 'closed', 'openrouter breaker starts closed');
  assert.ok(m.jobs && typeof m.jobs.dead === 'number' && m.jobs.deadRetentionDays === 30, 'jobs section present');
  assert.ok(typeof m.rateLimit.hits === 'number', 'rate-limit hits present');
  assert.ok(m.generatedAt, 'generatedAt present');

  // dead-letter list route: same gate
  const deadAnon = await raw('/api/v1/jobs/dead');
  assert.equal(deadAnon.status, 401);
  const deadKey = await raw('/api/v1/jobs/dead', { headers: { authorization: `Bearer ${apiKeySecret}` } });
  assert.equal(deadKey.status, 403);
  const deadOk = await call('/api/v1/jobs/dead');
  assert.equal(deadOk.status, 200);
  assert.ok(Array.isArray(deadOk.json.jobs), 'dead jobs list');
  assert.equal(deadOk.json.retentionDays, 30, 'retention policy documented in the response');

  // breaker reset route: same gate + unknown provider is a 400
  const resetAnon = await raw('/api/v1/breakers/openrouter/reset', { method: 'POST' });
  assert.equal(resetAnon.status, 401);
  const resetKey = await raw('/api/v1/breakers/openrouter/reset', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKeySecret}` },
  });
  assert.equal(resetKey.status, 403);
  const resetUnknown = await call('/api/v1/breakers/not-a-provider/reset', { method: 'POST' });
  assert.equal(resetUnknown.status, 400, `unknown provider → ${resetUnknown.status}`);
  assert.match(resetUnknown.json.error.message, /unknown provider/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 — fixture: twin + consent + capture + evidence (mock provider healthy)
// ═══════════════════════════════════════════════════════════════════════════
test('fixture: capture.quality succeeds through the mocked provider', async () => {
  provider.mode = { status: 200 };

  const twin = await call('/api/v1/twins', { method: 'POST', body: { displayName: `A6 Twin ${uid('flow')}` } });
  assert.equal(twin.status, 201);
  twinId = twin.json.id;
  const subjectId = twin.json.subjectId;

  const grant = await call('/api/v1/consent-grants', {
    method: 'POST',
    body: { subjectId, purpose: 'a6 resilience flow', scopes: ['capture', 'reconstruct'], ttlHours: 2 },
  });
  assert.equal(grant.status, 201);

  const cap = await call(`/api/v1/twins/${twinId}/capture-sessions`, { method: 'POST', body: {} });
  assert.equal(cap.status, 201);
  captureId = cap.json.id;

  const up = await call(`/api/v1/captures/${captureId}/assets`, {
    method: 'POST',
    form: uploadForm(['face.front', 'face.profile', 'hands']),
  });
  assert.equal(up.status, 201, `upload → ${up.status}`);

  const done = await call(`/api/v1/captures/${captureId}/complete`, { method: 'POST', body: {} });
  assert.equal(done.status, 202);
  const job = await pollJob(done.json.jobId);
  assert.equal(job.status, 'succeeded', `capture.quality failed honestly: ${job.error ?? ''}`);

  const capAfter = await call(`/api/v1/captures/${captureId}`);
  assert.equal(capAfter.json.status, 'complete', 'capture session complete — the compile path is unblocked');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 — bounded provider retries with Retry-After respect (recovery)
// ═══════════════════════════════════════════════════════════════════════════
test('provider retries: a 429 (with Retry-After) then 200 recovers — job succeeds, retry counted', async () => {
  provider.script = [{ status: 429, retryAfter: 1 }];
  provider.mode = { status: 200 };
  const requestsBefore = provider.requests.length;
  const retriesBefore = (await call('/api/v1/metrics')).json.counters['retries'] ?? 0;

  const t0 = Date.now();
  const compile = await call(`/api/v1/twins/${twinId}/compile`, {
    method: 'POST',
    body: { captureSessionId: captureId, style: 'photorealistic' },
  });
  assert.equal(compile.status, 202, `compile → ${compile.status}`);
  const job = await pollJob(compile.json.jobId);
  const waited = Date.now() - t0;

  assert.equal(job.status, 'succeeded', `twin.compile failed honestly: ${job.error ?? ''}`);
  // exactly two provider requests: the 429 + the retry that succeeded
  assert.equal(provider.requests.length - requestsBefore, 2, 'one 429, one retry');
  // Retry-After: 1 (second) must be honored — the retry waited ≥ ~1000ms
  const gap = provider.requests[provider.requests.length - 1].at - provider.requests[provider.requests.length - 2].at;
  assert.ok(gap >= 900, `retry-after not respected: inter-request gap ${gap}ms < 900ms`);
  assert.ok(waited >= 900, `overall wait ${waited}ms — the server's demand was honored without hanging`);
  const retriesAfter = (await call('/api/v1/metrics')).json.counters['retries'] ?? 0;
  assert.ok(retriesAfter > retriesBefore, 'the retry was counted on the metrics surface');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 — dead-letter: bounded attempts exhausted → terminal dead + payload
// ═══════════════════════════════════════════════════════════════════════════
test('dead-letter: an always-500 provider exhausts the bounded attempts → dead with a structured payload', async () => {
  provider.script = [];
  provider.mode = { status: 500 };
  const requestsBefore = provider.requests.length;

  const compile = await call(`/api/v1/twins/${twinId}/compile`, {
    method: 'POST',
    body: { captureSessionId: captureId, style: 'anime' },
  });
  assert.equal(compile.status, 202);
  deadJobId = compile.json.jobId;
  const job = await pollJob(deadJobId);

  assert.equal(job.status, 'dead', `expected dead, got ${job.status} (${job.error ?? ''})`);
  // bounded, never infinite: provider attempts (2) × job attempts (2) = 4 calls
  assert.equal(provider.requests.length - requestsBefore, 4, 'exactly the bounded attempts — the loop STOPS');
  assert.match(job.error, /openrouter provider error during vision\.http: HTTP 500/, 'verbatim provider error kept');

  // dead-letter inspection: structured payload + retention policy
  const list = await call('/api/v1/jobs/dead');
  assert.equal(list.status, 200);
  const entry = list.json.jobs.find((j) => j.id === deadJobId);
  assert.ok(entry, 'the dead job is listed');
  assert.equal(entry.status, 'dead');
  assert.equal(entry.attempts, 2, 'attempts recorded on the row');
  const dl = entry.deadLetter;
  assert.equal(dl.attempts, 2);
  assert.match(dl.lastError, /HTTP 500/);
  assert.ok(dl.firstAttemptAt && dl.deadAt, 'first-attempt and death timestamps present');
  assert.equal(dl.kind, 'twin.compile');
  assert.equal(dl.stoppedBy, 'attempts');
  assert.ok(Array.isArray(dl.replays), 'replay history array present (empty)');

  // the job.dead event was delivered to the webhook listener AFTER bounded
  // retries of its own: 500, 500, then 200 — signed every time
  const deadline = Date.now() + 30_000;
  let hits = [];
  for (;;) {
    hits = webhookListener.records.filter((r) => r.type === 'job.dead' && r.jobId === deadJobId);
    if (hits.length >= 3) break;
    if (Date.now() > deadline) {
      assert.fail(`webhook delivery did not retry to success within 30s (saw ${hits.length} hit(s))`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(hits.length, 3, 'receiver failed twice, third delivery accepted');
  for (const hit of hits) {
    assert.match(hit.headers['x-you-signature'] ?? '', /^sha256=[0-9a-f]{64}$/, 'every retry is HMAC-signed');
    assert.match(hit.headers['x-you-timestamp'] ?? '', /^\d+$/, 'timestamp header present');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 — circuit breaker opens → the reconstruction path degrades to an honest 503
// ═══════════════════════════════════════════════════════════════════════════
test('breaker opens after the failure threshold → compile returns a fast, honest 503 (no hang, no spin)', async () => {
  provider.mode = { status: 500 };

  // drive failures until the breaker opens (dead jobs add 2 failures each;
  // a refused job adds none). Bounded loop — the breaker law itself.
  let degraded = null;
  for (let i = 0; i < 8 && !degraded; i += 1) {
    const t0 = Date.now();
    const compile = await call(`/api/v1/twins/${twinId}/compile`, {
      method: 'POST',
      body: { captureSessionId: captureId, style: 'cartoon' },
    });
    if (compile.status === 503) {
      degraded = { res: compile, elapsed: Date.now() - t0 };
      break;
    }
    assert.equal(compile.status, 202, `interim compile → ${compile.status}`);
    const job = await pollJob(compile.json.jobId);
    assert.ok(['dead', 'failed'].includes(job.status), `interim job terminal state ${job.status}`);
  }
  assert.ok(degraded, 'the breaker never opened within the bounded loop');

  // the metrics surface confirms WHY (open breaker, not a mystery)
  const metrics = await call('/api/v1/metrics');
  assert.equal(metrics.json.breakers.openrouter.state, 'open', 'metrics show the open breaker');
  assert.ok(metrics.json.breakers.openrouter.retryAfterMs > 0, 'retry guidance in the snapshot');

  // the degraded response: honest 503 + machine-readable guidance, FAST
  assert.equal(degraded.res.status, 503);
  const err = degraded.res.json.error;
  assert.equal(err.code, 'service_unavailable');
  assert.equal(err.details.kind, 'provider-unavailable');
  assert.equal(err.details.provider, 'openrouter');
  assert.equal(err.details.breakerState, 'open');
  assert.ok(err.details.retryAfterSeconds >= 1, 'retry-after guidance present');
  assert.match(err.message, /refused fast instead of hanging/, 'honest wording');
  assert.ok(degraded.elapsed < 3000, `degraded response took ${degraded.elapsed}ms — must be fast`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 — manual breaker reset → full recovery through the real executor
// ═══════════════════════════════════════════════════════════════════════════
test('manual breaker reset: the provider recovers and the reconstruction path works again', async () => {
  provider.mode = { status: 200 };

  const reset = await call('/api/v1/breakers/openrouter/reset', { method: 'POST' });
  assert.equal(reset.status, 200, `reset → ${reset.status}`);
  assert.deepEqual(reset.json, { provider: 'openrouter', state: 'closed' });

  const metrics = await call('/api/v1/metrics');
  assert.equal(metrics.json.breakers.openrouter.state, 'closed', 'metrics reflect the manual reset');

  const compile = await call(`/api/v1/twins/${twinId}/compile`, {
    method: 'POST',
    body: { captureSessionId: captureId, style: 'illustration' },
  });
  assert.equal(compile.status, 202, `compile after reset → ${compile.status}`);
  const job = await pollJob(compile.json.jobId);
  assert.equal(job.status, 'succeeded', `recovery compile failed honestly: ${job.error ?? ''}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 — dead-job replay (operator action)
// ═══════════════════════════════════════════════════════════════════════════
test('replay: the SAME dead job row re-queued and succeeded; honest negatives', async () => {
  provider.mode = { status: 200 };

  const replay = await call(`/api/v1/jobs/dead/${deadJobId}/replay`, { method: 'POST' });
  assert.equal(replay.status, 202, `replay → ${replay.status}`);
  assert.equal(replay.json.jobId, deadJobId, 'the same durable row is replayed');
  const job = await pollJob(deadJobId);
  assert.equal(job.status, 'succeeded', `replayed job failed honestly: ${job.error ?? ''}`);

  // replaying a non-dead job is an honest 409
  const again = await call(`/api/v1/jobs/dead/${deadJobId}/replay`, { method: 'POST' });
  assert.equal(again.status, 409, `replay of a succeeded job → ${again.status}`);
  assert.match(again.json.error.message, /only dead jobs/);

  // unknown id: 404
  const unknown = await call(`/api/v1/jobs/dead/${uid('missing')}/replay`, { method: 'POST' });
  assert.equal(unknown.status, 404);

  // the replayed job left the dead list; the remaining dead entries still
  // carry their structured payloads + the replay history on the replayed one
  const list = await call('/api/v1/jobs/dead');
  assert.equal(list.status, 200);
  assert.ok(!list.json.jobs.some((j) => j.id === deadJobId), 'the replayed job is no longer dead');
  for (const j of list.json.jobs) {
    assert.equal(j.status, 'dead');
    assert.ok(j.deadLetter && typeof j.deadLetter.attempts === 'number', 'structured payload on every dead entry');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 8 — the metrics surface tells the whole story
// ═══════════════════════════════════════════════════════════════════════════
test('metrics: retries, dead jobs, breaker states and rate-limit hits are all observable', async () => {
  // drive a rate-limit hit: 6 unauthenticated session posts from one fake IP
  // (the boot env caps the session bucket at 5/min)
  let saw429 = null;
  for (let i = 0; i < 6; i += 1) {
    const r = await raw('/api/v1/session', {
      method: 'POST',
      body: {},
      headers: { 'x-forwarded-for': '203.0.113.99' },
    });
    if (r.status === 429) {
      saw429 = r;
      break;
    }
  }
  assert.ok(saw429, 'the limiter fired');
  assert.equal(saw429.json.error.code, 'rate_limited');

  const m = (await call('/api/v1/metrics')).json;
  assert.ok(m.counters['retries'] >= 3, `retries counted (${m.counters['retries']}), not just the happy path`);
  assert.ok(m.counters['retry.recon-vision'] >= 1, 'per-label retry counter present');
  assert.ok(m.counters['jobs.dead'] >= 1, 'dead jobs counted');
  assert.ok(m.counters['ratelimit.hits'] >= 1, 'rate-limit hits counted');
  assert.ok(m.counters['ratelimit.hits.session-bootstrap'] >= 1, 'per-bucket rate-limit hits counted');
  assert.ok(m.counters['breaker.failure.openrouter'] >= 1, 'breaker failures counted');
  assert.ok(m.counters['webhook.delivered'] >= 1, 'webhook delivery outcome counted');
  assert.equal(m.breakers.zai.state, 'closed', 'the untouched provider breaker stayed closed');
  assert.equal(m.breakers.openrouter.state, 'closed', 'post-reset state is closed');
  assert.ok(m.jobs.dead >= 1, 'dead-letter inventory visible');
  assert.equal(m.jobs.deadRetentionDays, 30, 'retention policy visible');
});
