// ═══════════════════════════════════════════════════════════════════════════
// YOU F1 operator capture flow tests (P6.B3, Worker B lane) — node:test.
//
// Covers the guided flow end-to-end at the API level (the acceptance chain of
// docs/F1_OPERATOR_CAPTURE.md, with real evidence):
//   1. CONSENT GATE (server-enforced): no grant → 403 consent_required
//      (machine-readable details); capture-scope grant WITHOUT the six F1
//      statements → 403 with the exact missingStatements list; full
//      statement-covered grant → 201. Advance gate: grant revoked mid-flow →
//      403 on submit; a fresh covering grant unblocks it.
//   2. PROTOCOL PERSISTENCE: 8 steps with non-empty PERSISTED instruction
//      text, initial state (step 1 current), per-step state machine
//      (pending → done via submit / skipped-with-reason via skip), and the
//      failed-checkpoint path (garbage bytes refused, report persisted,
//      step stays current).
//   3. QUALITY + LIVENESS CHECKPOINTS: per-step heuristic report persisted
//      (pass for real containers incl. mp4 video + wav audio; refusal code
//      evidence_undecodable for garbage).
//   4. MANIFEST CONTENT-ADDRESSING: complete builds the manifest with every
//      asset re-hashed (sha256 verified against the KNOWN uploaded bytes),
//      provenance + consent grant id + deletion policy recorded; required
//      steps pending → honest 400; skipped REQUIRED steps disclosed.
//   5. REVIEW PROMOTION: review before complete → 409; approve with no
//      TwinVersion → 409 with guidance; with a reconstructed version
//      (seeded as the f1.reconstruct terminal state — the reconstruction
//      leg itself is C-lane P6.C4, unit-tested in f1-recon.test.mjs; no
//      network here) → approve promotes the capture to the TwinVersion
//      linkage with the full acceptance chain persisted; re-review → 409;
//      reject path records the verdict without linkage.
//   6. DELETION/EXPORT: export bundle carries protocol + instructions +
//      manifest + statements + chain, with live byte-identical download
//      capabilities; deletion honors the consent retention policy (409 while
//      retained + grant active; withdrawal via grant revocation → delete
//      proceeds; mayBeRetained:false → immediate); deleted evidence is gone
//      (GET 404, download dead) while the TwinVersion remains (immutable).
//
// Server lifecycle: boots its own `next dev` on a free port, or reuses the
// sibling suite's server when aggregated (tests/index.mjs sets
// __YOU_TEST_AGGREGATED__ / publishes __YOU_TEST_BASE__) — same law as the
// W4.A hardening suite. Prerequisites: the documented app boot
// (cd apps/web && bun install && cp .env.example .env && bun run db:push).
// NO network beyond 127.0.0.1; the DB is seeded directly (Prisma) only for
// the reconstruction terminal state, mirroring the executor's row shape.
// ═══════════════════════════════════════════════════════════════════════════
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const APP_DIR = path.join(REPO_ROOT, 'apps', 'web');

const stamp = `${Date.now()}-${process.pid}`;

// ─── test evidence buffers (unique per run; content addressing) ──────────────
function pad(buf, minLen) {
  if (buf.length >= minLen) return buf;
  return Buffer.concat([buf, randomBytes(minLen - buf.length)]);
}
const PNG = pad(Buffer.concat([
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dwn4GBgYGJgQoAAF9vAgOZcDyHAAAAAElFTkSuQmCC',
    'base64',
  ),
  randomBytes(8),
]), 600); // 8×8 png + unique tail → ≥ image min size
const MP4 = pad(Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]), // box size
  Buffer.from('ftypisom\x00\x00\x02\x00isomiso2', 'latin1'),
  randomBytes(8),
]), 1400); // fyp/ftyp box at offset 4 → sniffs as mp4 video
const WAV = pad(Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x24, 0x08, 0x00, 0x00]),
  Buffer.from('WAVEfmt ', 'latin1'),
  randomBytes(8),
]), 700); // RIFF/WAVE → sniffs as wav audio
const GARBAGE = pad(randomBytes(24), 700); // matches NO container signature
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// ─── shared state across the sequential tests ────────────────────────────────
let base = process.env.YOU_TEST_BASE ?? null;
let cookie = null;
let child = null;
let ownServer = false;
let basePromise = null;
let prismaClient = null;

let twinA = null; // main flow twin
let sessionA = null; // main guided session
let fullGrantA = null; // statement-covered grant for twin A
let secondGrantA = null; // re-grant after revocation (advance-gate leg)
let twinB = null; // reject-path twin
let sessionB = null;

// ─── tiny HTTP client with session-cookie memory ─────────────────────────────
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
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, json, text };
}

function multipart(pathname, file, mime, extra = {}) {
  const boundary = `----f1b3${stamp}${Math.floor(Math.random() * 1e6)}`;
  const head = `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="evidence"\r\ncontent-type: ${mime}\r\n\r\n`;
  const tail = Object.entries(extra)
    .map(([name, value]) => `\r\n--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}`)
    .join('') + `\r\n--${boundary}--\r\n`;
  return call(pathname, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    form: Buffer.concat([Buffer.from(head, 'utf8'), file, Buffer.from(tail, 'utf8')]),
  });
}

// ─── server lifecycle (aggregated-aware singleton) ───────────────────────────
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
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    child.once('exit', finish);
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* */ } setTimeout(finish, 500); }, 8000).unref();
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

function ensureBase() {
  if (!basePromise) {
    basePromise = (async () => {
      if (base) return base; // YOU_TEST_BASE (station-provided)
      const aggregated = !!globalThis.__YOU_TEST_AGGREGATED__;
      const deadline = Date.now() + (aggregated ? 150000 : 5000);
      while (Date.now() < deadline) {
        if (globalThis.__YOU_TEST_BASE__) {
          base = globalThis.__YOU_TEST_BASE__;
          console.log(`[f1b3-tests] reusing suite server at ${base}`);
          return base;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(!aggregated, 'aggregated run: the sibling suite never published its server URL within 150s');
      console.log('[f1b3-tests] booting apps/web (next dev) on a free port…');
      await startServer();
      ownServer = true;
      console.log(`[f1b3-tests] server ready at ${base}`);
      return base;
    })().catch((err) => {
      basePromise = null;
      throw err;
    });
  }
  return basePromise;
}

// ─── direct DB seeding (the f1.reconstruct terminal state; hardening law) ────
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

// ─── the six F1 statements ───────────────────────────────────────────────────
function f1Statements(overrides = {}) {
  return {
    what: `Photos and short clips for the F1 acceptance run ${stamp}`,
    why: 'Build and verify the operator capture → twin pipeline for the product tests below.',
    tests: [`F1 operator-capture acceptance ${stamp}`, 'Twin reconstruction quality benchmark'],
    retention: {
      mayBeRetained: true,
      retainUntil: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      policy: 'retained for the listed tests until the window elapses or consent is withdrawn',
    },
    training: { permitted: false, note: 'not granted — training is default-denied' },
    deletion: 'Subject withdraws by revoking the consent grant; evidence is then deleted (TwinVersions stay immutable).',
    ...overrides,
  };
}

const F1_SIX = ['what', 'why', 'tests', 'retention', 'training', 'deletion'];

async function grantConsent(subjectId, statements, ttlHours = 6) {
  return call('/api/v1/consent-grants', {
    method: 'POST',
    body: { subjectId, purpose: `P6.B3 F1 flow ${stamp}`, scopes: ['capture', 'reconstruct'], ttlHours, ...(statements ? { statements } : {}) },
  });
}

async function createTwin(name) {
  const r = await call('/api/v1/twins', { method: 'POST', body: { displayName: name } });
  assert.equal(r.status, 201, `twin create → ${r.status}`);
  return r.json;
}

async function startF1(twinId) {
  return call(`/api/v1/twins/${twinId}/capture-sessions/f1`, { method: 'POST', body: {} });
}

async function submitStep(sessionId, stepId, file, mime) {
  return multipart(`/api/v1/captures/${sessionId}/f1/steps/${stepId}/submit`, file, mime);
}

// ─── lifecycle ───────────────────────────────────────────────────────────────
// NO before() hook: in the aggregated run the root's async before-hooks
// overlap (empirically: two next dev instances collide on apps/web/.next).
// Each test lazily awaits ensureBase() — the W4.A hardening-suite law — so
// by the time this suite's tests run, the shared server URL is published.
after(async () => {
  if (prismaClient) await prismaClient.$disconnect().catch(() => undefined);
  if (ownServer) {
    await killTree();
    if (child && child.pid) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    console.log('[f1b3-tests] own server stopped');
  }
});

// ─── 1. consent gate enforcement at the API level ────────────────────────────
test('f1 flow: consent gate — no grant, statement-less grant, covered grant', async () => {
  await ensureBase();
  await call('/api/v1/session', { method: 'POST', body: {} });
  twinA = await createTwin(`F1-B3 main ${stamp}`);
  sessionA = null;

  // no grant at all → machine-readable 403
  let r = await startF1(twinA.id);
  assert.equal(r.status, 403, `start without grant → ${r.status}`);
  assert.equal(r.json.error.code, 'consent_required');
  assert.equal(r.json.error.details.scope, 'capture');
  assert.equal(r.json.error.details.f1, true);
  assert.equal(r.json.error.details.reason, 'no_active_grant');
  assert.deepEqual(r.json.error.details.requiredStatements.sort(), [...F1_SIX].sort());

  // capture-scope grant WITHOUT the six statements → still refused, precisely
  r = await grantConsent(twinA.subjectId, null);
  assert.equal(r.status, 201);
  r = await startF1(twinA.id);
  assert.equal(r.status, 403, `start with statement-less grant → ${r.status}`);
  assert.equal(r.json.error.code, 'consent_required');
  assert.equal(r.json.error.details.reason, 'statements_incomplete');
  assert.deepEqual(r.json.error.details.missingStatements.sort(), [...F1_SIX].sort());

  // full statement-covered grant → the flow opens
  r = await grantConsent(twinA.subjectId, f1Statements());
  assert.equal(r.status, 201);
  fullGrantA = r.json;
  assert.equal(fullGrantA.statements.training.permitted, false); // default-DENIED is explicit on the view
  r = await startF1(twinA.id);
  assert.equal(r.status, 201, `start with covered grant → ${r.status}`);
  sessionA = r.json;
  assert.equal(sessionA.protocol.steps.length, 8);
  assert.equal(sessionA.consentGrantId, fullGrantA.id);
  assert.ok(sessionA.retention.policy.includes('retained'));
});

// ─── 2. protocol persistence + per-step state machine ────────────────────────
test('f1 flow: protocol persistence, persisted instructions, step state machine', async () => {
  await ensureBase();
  const r = await call(`/api/v1/captures/${sessionA.id}`);
  assert.equal(r.status, 200);
  const p = r.json.protocol;
  assert.equal(p.version, 'f1-operator-capture/v1');
  assert.equal(p.source, 'docs/F1_OPERATOR_CAPTURE.md');
  assert.equal(p.steps.length, 8);
  // THE LAW: the actual instruction text is persisted with the capture
  for (const s of p.steps) {
    assert.ok(typeof s.instruction === 'string' && s.instruction.length >= 40, `step ${s.id} instruction not persisted`);
    assert.ok(Array.isArray(s.regions) && s.regions.length > 0, `step ${s.id} regions`);
  }
  assert.equal(p.steps[0].state, 'current');
  assert.equal(p.currentStepId, 'face-front');
  for (const s of p.steps.slice(1)) assert.equal(s.state, 'pending');
  assert.equal(p.steps[7].required, false); // speech/performance is optional
  for (const s of p.steps.slice(0, 7)) assert.equal(s.required, true);

  // garbage bytes fail the liveness checkpoint honestly: 400 with the report,
  // the step STAYS current and the refusal is persisted on the protocol
  let g = await submitStep(sessionA.id, 'face-front', GARBAGE, 'image/png');
  assert.equal(g.status, 400, `garbage submit → ${g.status}`);
  assert.equal(g.json.error.details.checkpoint.passed, false);
  assert.equal(g.json.error.details.checkpoint.refusal.code, 'evidence_undecodable');
  let cur = await call(`/api/v1/captures/${sessionA.id}`);
  let step = cur.json.protocol.steps.find((s) => s.id === 'face-front');
  assert.equal(step.state, 'current');
  assert.equal(step.checkpoint.refusal.code, 'evidence_undecodable');
  assert.equal(cur.json.protocol.currentStepId, 'face-front');

  // a real PNG passes and advances
  g = await submitStep(sessionA.id, 'face-front', PNG, 'image/png');
  assert.equal(g.status, 201, `png submit → ${g.status}`);
  assert.equal(g.json.submitted.checkpoint.passed, true);
  assert.equal(g.json.submitted.checkpoint.sniffed.container, 'png');
  assert.equal(g.json.submitted.contentHash, sha256(PNG));
  cur = await call(`/api/v1/captures/${sessionA.id}`);
  step = cur.json.protocol.steps.find((s) => s.id === 'face-front');
  assert.equal(step.state, 'done');
  assert.equal(step.checkpoint.passed, true);
  assert.equal(cur.json.protocol.currentStepId, 'face-turn');
});

// ─── 3. advance gate: revoked grant blocks, fresh covering grant unblocks ────
test('f1 flow: advance gate is server-enforced on every step', async () => {
  await ensureBase();
  // withdraw: revoke the covering grant
  let r = await call(`/api/v1/consent-grants/${fullGrantA.id}`, { method: 'DELETE' });
  assert.equal(r.status, 200, `revoke → ${r.status}`);
  assert.ok(r.json.revokedAt, 'revoke stamps revokedAt');

  r = await submitStep(sessionA.id, 'face-turn', PNG, 'image/png');
  assert.equal(r.status, 403, `submit after withdrawal → ${r.status}`);
  assert.equal(r.json.error.code, 'consent_required');

  // a fresh statement-covered grant unblocks the advance (provenance moves to it)
  r = await grantConsent(twinA.subjectId, f1Statements());
  assert.equal(r.status, 201);
  secondGrantA = r.json;
  r = await submitStep(sessionA.id, 'face-turn', PNG, 'image/png');
  assert.equal(r.status, 201, `submit after re-grant → ${r.status}`);
  const cur = await call(`/api/v1/captures/${sessionA.id}`);
  assert.equal(cur.json.consentGrantId, secondGrantA.id);

  // skip-with-reason on a REQUIRED step is recorded, never silent
  r = await call(`/api/v1/captures/${sessionA.id}/f1/steps/upper-body/skip`, {
    method: 'POST',
    body: { reason: `subject unavailable for upper body ${stamp}` },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.skipped.required, true);
  const p = (await call(`/api/v1/captures/${sessionA.id}`)).json.protocol;
  const skipped = p.steps.find((s) => s.id === 'upper-body');
  assert.equal(skipped.state, 'skipped');
  assert.ok(skipped.skipReason.includes('upper body'));
  assert.equal(p.currentStepId, 'full-body');
});

// ─── 4. remaining steps, honest 400 on early complete, manifest ──────────────
test('f1 flow: complete builds the content-addressed manifest (sha256 verified)', async () => {
  await ensureBase();
  // walk the remaining steps: full-body, hands, turn-around (png), walking (mp4), speech (wav)
  for (const [stepId, file, mime] of [
    ['full-body', PNG, 'image/png'],
    ['hands', PNG, 'image/png'],
    ['turn-around', PNG, 'image/png'],
    ['walking', MP4, 'video/mp4'],
    ['speech', WAV, 'audio/wav'],
  ]) {
    const r = await submitStep(sessionA.id, stepId, file, mime);
    assert.equal(r.status, 201, `${stepId} submit → ${r.status}: ${r.text?.slice(0, 200)}`);
    assert.equal(r.json.submitted.checkpoint.passed, true, `${stepId} checkpoint`);
  }

  // early complete refusal on a FRESH session with pending required steps
  const early = await startF1(twinA.id);
  assert.equal(early.status, 201);
  let r = await call(`/api/v1/captures/${early.json.id}/f1/complete`, { method: 'POST' });
  assert.equal(r.status, 400, `early complete → ${r.status}`);
  assert.ok(r.json.error.details.pendingRequired.includes('face-front'));

  // the real completion: manifest over ALL assets (the garbage asset included)
  r = await call(`/api/v1/captures/${sessionA.id}/f1/complete`, { method: 'POST' });
  assert.equal(r.status, 200, `complete → ${r.status}`);
  const manifest = r.json.manifest;
  // 8 submissions total: 7 passing (incl. the face-front retry) + 1 refused-but-recorded garbage
  assert.equal(manifest.totals.assets, 8);
  assert.equal(manifest.totals.verified, 8); // every stored byte re-hashes to its recorded hash
  assert.equal(manifest.algorithm, 'sha256');
  assert.equal(manifest.provenance.consentGrantId, secondGrantA.id);
  assert.equal(manifest.provenance.twinId, twinA.id);
  assert.equal(manifest.provenance.subjectId, twinA.subjectId);
  assert.equal(manifest.deletionPolicy.mayBeRetained, true);
  assert.equal(manifest.deletionPolicy.deletionProcess, f1Statements().deletion);
  // content addressing: the face-front asset hashes to the KNOWN PNG bytes
  const faceFront = manifest.assets.find((a) => a.stepId === 'face-front');
  assert.equal(faceFront.contentHash, sha256(PNG));
  assert.equal(faceFront.verified, true);
  const garbageAsset = manifest.assets.find((a) => a.checkpointPassed === false);
  assert.ok(garbageAsset, 'the refused submission stays recorded in the manifest (never dropped)');
  // the skipped REQUIRED step is disclosed in the summary
  assert.deepEqual(r.json.summary.skippedRequired, ['upper-body']);
  assert.equal(r.json.summary.stepsChecked, 7);
  assert.equal(r.json.summary.checkpointsFailed.length, 1); // the garbage submission, disclosed
  const cur = await call(`/api/v1/captures/${sessionA.id}`);
  assert.equal(cur.json.status, 'complete');
  assert.equal(cur.json.manifest.totals.assets, 8);
});

// ─── 5. review → TwinVersion linkage with the acceptance chain ───────────────
test('f1 flow: review promotes the capture to the TwinVersion linkage', async () => {
  await ensureBase();
  // review before complete → honest 409
  const early = await call(`/api/v1/captures/${sessionA.id}`);
  void early;
  const fresh = await startF1(twinA.id); // pending session
  let r = await call(`/api/v1/captures/${fresh.json.id}/f1/review`, {
    method: 'POST', body: { verdict: 'approve' },
  });
  assert.equal(r.status, 409, `review before complete → ${r.status}`);

  // approve with no reconstructed TwinVersion → 409 with guidance
  r = await call(`/api/v1/captures/${sessionA.id}/f1/review`, {
    method: 'POST', body: { verdict: 'approve' },
  });
  assert.equal(r.status, 409, `approve without TwinVersion → ${r.status}`);
  assert.ok(r.json.error.message.includes('reconstruction'));

  // seed the f1.reconstruct terminal state: a DRAFT TwinVersion whose
  // evidenceAssetIds reference this capture (exactly the row the C-lane
  // executor persists; the reconstruction leg is unit-tested in
  // f1-recon.test.mjs — no network here)
  const db = await prisma();
  const assets = await db.evidenceAsset.findMany({
    where: { captureSessionId: sessionA.id },
    orderBy: { createdAt: 'asc' },
  });
  assert.ok(assets.length >= 8);
  const twinRow = await db.twin.findUnique({ where: { id: twinA.id } });
  const versionNo = (twinRow.currentVersion ?? 0) + 1;
  const htir = {
    twinId: twinA.id,
    version: versionNo,
    morphology: { descriptors: [] },
    geometry: { skeleton: 'you-generic-v1', measurements: {}, face: {}, hands: { detail: 'low' } },
    appearance: { palette: {}, hair: { coverage: 'low' }, clothing: { items: [] }, distinguishing: [] },
    styleProfiles: [],
    confidence: { overall: 0.5, byDomain: {}, deficiencies: [] },
    provenance: {
      subjectId: twinA.subjectId,
      consentGrantIds: [secondGrantA.id],
      evidenceAssetIds: assets.map((a) => a.id),
      evidenceHashes: assets.map((a) => a.contentHash),
      pipeline: { pipelineId: 'seed-pipeline', components: [] },
      compiledAt: new Date().toISOString(),
      compiledBy: 'f1.reconstruct',
    },
  };
  const seeded = await db.twinVersion.create({
    data: {
      twinId: twinA.id,
      version: versionNo,
      status: 'draft',
      htir: JSON.stringify(htir),
      inputVersionIds: '[]',
      evidenceAssetIds: JSON.stringify(assets.map((a) => a.id)),
    },
  });
  await db.twin.update({ where: { id: twinA.id }, data: { currentVersion: versionNo } });

  // approve → promoted with the full acceptance chain
  r = await call(`/api/v1/captures/${sessionA.id}/f1/review`, {
    method: 'POST',
    body: { verdict: 'approve', note: `acceptance review ${stamp}` },
  });
  assert.equal(r.status, 200, `approve → ${r.status}`);
  assert.equal(r.json.review.status, 'promoted');
  assert.equal(r.json.review.twinVersionId, seeded.id);
  assert.equal(r.json.review.twinVersionNumber, versionNo);
  const chain = r.json.review.chain;
  assert.equal(chain.consent.grantId, secondGrantA.id);
  assert.equal(chain.consent.statements.training.permitted, false);
  assert.deepEqual(chain.quality.skippedRequired, ['upper-body']);
  assert.equal(chain.quality.stepsDone, 7);
  assert.equal(chain.quality.stepsSkipped, 1);
  assert.equal(chain.reconstruction.twinVersionId, seeded.id);
  assert.equal(chain.reconstruction.compiledBy, 'f1.reconstruct');
  assert.equal(chain.review.verdict, 'approve');
  assert.equal(chain.liveness.stepsChecked, 8); // every submitted evidence file
  assert.equal(chain.liveness.refusals, 1); // the garbage submission, disclosed

  // the DRAFT version was published by the promotion (draft → published)
  const versionRow = await db.twinVersion.findUnique({ where: { id: seeded.id } });
  assert.equal(versionRow.status, 'published');

  // the review is immutable: re-review → 409
  r = await call(`/api/v1/captures/${sessionA.id}/f1/review`, {
    method: 'POST', body: { verdict: 'reject' },
  });
  assert.equal(r.status, 409);

  // the persisted session view carries the promoted review
  const cur = await call(`/api/v1/captures/${sessionA.id}`);
  assert.equal(cur.json.review.status, 'promoted');
  assert.equal(cur.json.review.chain.reconstruction.version, versionNo);
});

// ─── 6. export path (documented + tested) ────────────────────────────────────
test('f1 flow: export bundle — protocol, manifest, statements, chain, live URLs', async () => {
  await ensureBase();
  const r = await call(`/api/v1/captures/${sessionA.id}/f1/export`);
  assert.equal(r.status, 200, `export → ${r.status}`);
  const b = r.json;
  assert.equal(b.export, 'f1-capture-export/v1');
  assert.equal(b.captureSession.id, sessionA.id);
  assert.equal(b.captureSession.subjectId, twinA.subjectId);
  // persisted instructions travel in the export
  for (const s of b.protocol.steps) {
    assert.ok(s.instruction && s.instruction.length >= 40, `export step ${s.id} instruction`);
  }
  assert.equal(b.protocol.steps.find((s) => s.id === 'upper-body').state, 'skipped');
  assert.equal(b.manifest.totals.assets, 8);
  assert.equal(b.consent.statements.what, f1Statements().what);
  assert.equal(b.review.status, 'promoted');
  assert.equal(b.twinVersions.length, 1);
  assert.equal(b.twinVersions[0].id, b.review.twinVersionId);
  // live byte-identical download capability
  const dl = await fetch(base + b.evidenceAssets.find((a) => a.contentHash === sha256(PNG)).downloadUrl);
  assert.equal(dl.status, 200);
  const bytes = Buffer.from(await dl.arrayBuffer());
  assert.ok(bytes.equals(PNG), 'export download URL returns byte-identical evidence');
});

// ─── 7. deletion honors the consent retention policy ─────────────────────────
test('f1 flow: deletion — retention window blocks, withdrawal proceeds, versions stay immutable', async () => {
  await ensureBase();
  // retention is active (mayBeRetained + future retainUntil + active grant) → refused
  let r = await call(`/api/v1/captures/${sessionA.id}/f1`, { method: 'DELETE' });
  assert.equal(r.status, 409, `delete while retained → ${r.status}`);
  assert.equal(r.json.error.code, 'conflict');
  assert.equal(r.json.error.details.policy, f1Statements().retention.policy);
  assert.ok(r.json.error.details.retainUntil);
  assert.ok(r.json.error.details.withdrawal.includes('revoking'), `withdrawal guidance: ${r.json.error.details.withdrawal}`);

  // withdrawal: revoke the covering grant → deletion proceeds
  r = await call(`/api/v1/consent-grants/${secondGrantA.id}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.ok(r.json.revokedAt, 'revoke stamps revokedAt');
  r = await call(`/api/v1/captures/${sessionA.id}/f1`, { method: 'DELETE' });
  assert.equal(r.status, 200, `delete after withdrawal → ${r.status}`);
  assert.equal(r.json.deleted, true);
  assert.equal(r.json.assetsDeleted, 8);
  // unique content-addressed objects: png (shared by 5 steps), mp4, wav, garbage
  assert.equal(r.json.objectsDeleted, 4);
  assert.equal(r.json.objectsRetained, 0);
  // the TwinVersion remains — immutable by law, disclosed
  assert.equal(r.json.twinVersionsRemain.length, 1);
  assert.ok(r.json.disclosure.includes('immutable'));

  // the capture and its evidence are GONE
  r = await call(`/api/v1/captures/${sessionA.id}`);
  assert.equal(r.status, 404);
  r = await call(`/api/v1/captures/${sessionA.id}/f1/export`);
  assert.equal(r.status, 404);

  // the immutable version still exists with the hash-only provenance record
  const db = await prisma();
  const remaining = await db.twinVersion.findMany({ where: { twinId: twinA.id } });
  assert.equal(remaining.length, 1);
  const prov = JSON.parse(remaining[0].htir).provenance;
  assert.ok(prov.evidenceHashes.includes(sha256(PNG)), 'hash-only provenance record survives deletion');
});

// ─── 8. reject path + immediate deletion when retention is not granted ───────
test('f1 flow: reject verdict records without linkage; mayBeRetained:false deletes immediately', async () => {
  await ensureBase();
  twinB = await createTwin(`F1-B3 reject ${stamp}`);
  let r = await grantConsent(twinB.subjectId, f1Statements({
    retention: { mayBeRetained: false, policy: 'no retention — delete after the session' },
  }));
  assert.equal(r.status, 201);
  r = await startF1(twinB.id);
  assert.equal(r.status, 201);
  sessionB = r.json;

  // walk a minimal honest flow: one passing step, skip the rest with reasons
  r = await submitStep(sessionB.id, 'face-front', PNG, 'image/png');
  assert.equal(r.status, 201);
  for (const stepId of ['face-turn', 'upper-body', 'full-body', 'hands', 'turn-around', 'walking']) {
    const s = await call(`/api/v1/captures/${sessionB.id}/f1/steps/${stepId}/skip`, {
      method: 'POST', body: { reason: `reject-flow skip ${stepId}` },
    });
    assert.equal(s.status, 200, `skip ${stepId} → ${s.status}`);
  }
  // speech (optional) stays pending — completion must not require it
  r = await call(`/api/v1/captures/${sessionB.id}/f1/complete`, { method: 'POST' });
  assert.equal(r.status, 200, `complete with optional step pending → ${r.status}`);
  assert.equal(r.json.summary.stepsDone, 1);

  // reject: recorded verdict, no TwinVersion linkage
  r = await call(`/api/v1/captures/${sessionB.id}/f1/review`, {
    method: 'POST', body: { verdict: 'reject', note: `quality concerns ${stamp}` },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.review.status, 'rejected');
  assert.equal(r.json.review.twinVersionId, undefined);
  assert.ok(r.json.review.note.includes('quality concerns'));

  // export still works for a rejected capture (honest state)
  r = await call(`/api/v1/captures/${sessionB.id}/f1/export`);
  assert.equal(r.status, 200);
  assert.equal(r.json.review.status, 'rejected');

  // mayBeRetained:false → deletion available immediately, no withdrawal needed
  r = await call(`/api/v1/captures/${sessionB.id}/f1`, { method: 'DELETE' });
  assert.equal(r.status, 200, `immediate delete → ${r.status}`);
  assert.equal(r.json.deleted, true);
  assert.ok(r.json.disclosure.includes('immutable'));
});
