// ═══════════════════════════════════════════════════════════════════════════
// YOU recon OpenRouter provider tests (P6.C1, adapter vlm-recon-or-1) — node:test.
//
// Boots the app with YOU_RECON_PROVIDER=openrouter pointed at a LOCAL mock of
// the OpenRouter chat-completions API. The mock records every request and
// returns a canned, prompt-compliant quality JSON, so the FULL production
// path is exercised: upload evidence → POST /captures/:id/complete → durable
// capture.quality job → vlm-recon adapter → provider switch → hosted vision
// call → quality persisted on the asset.
//
// Verified:
//   1. the hosted path lands end-to-end — job succeeds, the asset carries
//      machine quality (score/coverage from the mock's analysis), and the
//      mock saw: Bearer auth, the configured model, the image as a data-URL
//      content part, and the quality-stage prompt;
//   2. provider failures are honest — a second server whose model the mock
//      rejects (401) fails the job with the verbatim provider error, never
//      a fabricated analysis.
//
// STANDALONE BY DESIGN — NOT imported by tests/index.mjs (own server boots
// with provider env overrides). Gate command:
//   node --test tests/contract/recon-openrouter.test.mjs
// Prerequisites: cd apps/web && bun install && cp .env.example .env && bun run db:push
// ═══════════════════════════════════════════════════════════════════════════
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const APP_DIR = path.join(REPO_ROOT, 'apps', 'web');

const stamp = `${Date.now()}-${process.pid}`;
const API_KEY = 'test-or-key-p6c1';
const GOOD_MODEL = 'test/vision-good';
const FAIL_MODEL = 'test/vision-unauthorized';

// ─── deterministic sample bytes (a real 8×8 PNG) ────────────────────────────
const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dwn4GBgYGJgQoAAF9vAgOZcDyHAAAAAElFTkSuQmCC',
  'base64',
);
const SAMPLE_B64 = SAMPLE_PNG.toString('base64');

// prompt-compliant canned analysis (see QUALITY_PROMPT in vlm-recon.ts)
const CANNED_QUALITY = JSON.stringify({
  usable: true,
  blur: 'none',
  lighting: 'good',
  issues: [],
  observedRegions: ['face.front'],
  score: 0.9,
});

// ─── the OpenRouter mock ─────────────────────────────────────────────────────
const mockCalls = []; // { auth, model, textPart, imagePart }
let mockServer = null;
let mockPort = 0;

function startMock() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (!req.url.includes('/chat/completions')) {
          res.writeHead(404); res.end(); return;
        }
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* */ }
        const content = body?.messages?.[0]?.content;
        const textPart = Array.isArray(content) ? content.find((p) => p?.type === 'text') : null;
        const imagePart = Array.isArray(content) ? content.find((p) => p?.type === 'image_url') : null;
        mockCalls.push({
          auth: req.headers.authorization || '',
          model: body?.model,
          text: textPart?.text ?? null,
          image: imagePart?.image_url?.url ?? null,
        });
        if (body?.model === FAIL_MODEL) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid API key (mock)' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: body?.model,
          choices: [{ message: { content: CANNED_QUALITY } }],
        }));
      });
    });
    mockServer.listen(0, '127.0.0.1', () => { mockPort = mockServer.address().port; resolve(); });
  });
}

// ─── app client with session-cookie memory ──────────────────────────────────
function makeClient() {
  let cookie = null;
  async function call(base, pathname, { method = 'GET', body, headers = {} } = {}) {
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
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, json, text };
  }
  call.upload = async (base, pathname, form) => {
    const h = { ...form.headers };
    if (cookie) h.cookie = cookie;
    const res = await fetch(base + pathname, { method: 'POST', headers: h, body: form.body });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, json, text };
  };
  return call;
}

function uploadForm() {
  const boundary = `----youp6c1${stamp}`;
  const head = `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="sample.png"\r\ncontent-type: image/png\r\n\r\n`;
  const tail = `\r\n--${boundary}\r\ncontent-disposition: form-data; name="regions"\r\n\r\n["face.front"]\r\n--${boundary}--\r\n`;
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat([Buffer.from(head, 'utf8'), SAMPLE_PNG, Buffer.from(tail, 'utf8')]),
  };
}

// ─── server lifecycle ────────────────────────────────────────────────────────
const servers = []; // { child, base }

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on('error', reject);
  });
}

async function startServer(model) {
  await killAll(); // next dev allows ONE instance per app dir — boot sequentially
  servers.length = 0;
  const port = await freePort();
  const nextBin = path.join(APP_DIR, 'node_modules', '.bin', 'next');
  assert.ok(fs.existsSync(nextBin), 'apps/web/node_modules/.bin/next missing — run `cd apps/web && bun install` first');
  const child = spawn(process.execPath, [nextBin, 'dev', '-p', String(port)], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      YOU_RECON_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: API_KEY,
      YOU_RECON_MODEL: model,
      YOU_RECON_BASE_URL: `http://127.0.0.1:${mockPort}`,
      YOU_RECON_TIMEOUT_MS: '15000',
    },
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

/** upload → complete → poll the durable job to a terminal state */
async function runQualityFlow(call, base) {
  await call(base, '/api/v1/session', { method: 'POST', body: {} });
  const twin = await call(base, '/api/v1/twins', { method: 'POST', body: { displayName: `P6C1 ${stamp}` } });
  assert.equal(twin.status, 201);
  const { id: twinId, subjectId } = twin.json;
  const grant = await call(base, '/api/v1/consent-grants', {
    method: 'POST',
    body: { subjectId, purpose: `p6c1 ${stamp}`, scopes: ['capture'], ttlHours: 2 },
  });
  assert.equal(grant.status, 201);
  const cap = await call(base, `/api/v1/twins/${twinId}/capture-sessions`, { method: 'POST', body: {} });
  assert.equal(cap.status, 201);

  const up = await call.upload(base, `/api/v1/captures/${cap.json.id}/assets`, uploadForm());
  assert.equal(up.status, 201, `upload → ${up.status}`);
  const assetId = up.json.id;

  const done = await call(base, `/api/v1/captures/${cap.json.id}/complete`, { method: 'POST', body: {} });
  assert.equal(done.status, 202, `complete → ${done.status}`);
  const jobId = done.json.jobId;

  const deadline = Date.now() + 60000;
  for (;;) {
    const job = await call(base, `/api/v1/jobs/${jobId}`);
    assert.equal(job.status, 200);
    if (job.json.status === 'succeeded' || job.json.status === 'failed') return { job: job.json, assetId, captureId: cap.json.id };
    if (Date.now() > deadline) assert.fail(`job ${jobId} did not reach a terminal state within 60s (last: ${job.json.status})`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ─── tests ───────────────────────────────────────────────────────────────────

before(async () => { await startMock(); });
after(async () => { await killAll(); await new Promise((r) => mockServer.close(r)); });

test('openrouter provider: capture.quality job succeeds with hosted vision + request shape verified', async () => {
  const call = makeClient();
  const base = await startServer(GOOD_MODEL);
  const { job, assetId, captureId } = await runQualityFlow(call, base);

  assert.equal(job.status, 'succeeded', `job failed: ${job.error}`);
  assert.ok(mockCalls.length >= 1, 'the hosted provider was called');
  const req = mockCalls[mockCalls.length - 1];
  assert.equal(req.auth, `Bearer ${API_KEY}`, 'Authorization: Bearer <key>');
  assert.equal(req.model, GOOD_MODEL, 'model passthrough (YOU_RECON_MODEL)');
  assert.ok(req.text && req.text.includes('capture quality stage'), 'quality-stage prompt reached the provider');
  assert.ok(req.image && req.image.startsWith(`data:image/png;base64,${SAMPLE_B64.slice(0, 16)}`), 'image passed as a data-URL content part');

  // quality persisted on the asset (machine analysis, honestly attributed)
  const detail = await call(base, `/api/v1/captures/${captureId}`);
  assert.equal(detail.status, 200, `capture detail → ${detail.status}`);
  const asset = (detail.json.assets ?? []).find((a) => a.id === assetId);
  assert.ok(asset, 'the uploaded asset is on the capture');
  assert.ok(asset.quality, 'quality landed on the asset');
  assert.equal(asset.quality.usable, true);
  assert.equal(asset.quality.score, 0.9);
  assert.ok(asset.quality.coverage.includes('face.front'));
});

test('openrouter provider: provider failure fails the job honestly (verbatim error, no fabrication)', async () => {
  const call = makeClient();
  const base = await startServer(FAIL_MODEL);
  const { job } = await runQualityFlow(call, base);

  assert.equal(job.status, 'failed', 'the job must fail when the provider rejects the call');
  assert.ok(
    /openrouter provider error/i.test(String(job.error)),
    `error names the provider (got: ${job.error})`,
  );
  assert.ok(
    /401/.test(String(job.error)) && /Invalid API key \(mock\)/.test(String(job.error)),
    `provider message surfaces verbatim (got: ${job.error})`,
  );
});
