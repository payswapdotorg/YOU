// ═══════════════════════════════════════════════════════════════════════════
// YOU W3.A integration tests (Worker A lane, A10) — node:test, no deps.
//
// Covers (per the W3.A work order):
//   1. session bootstrap (demo tenant + HUMAN-RECON-001 lab seed);
//   2. twin → capture → evidence → compile WITH consent fail-closed negatives
//      (upload 403 consent_required, compile 403 consent_required);
//   3. templates CRUD + durable analyze job (incl. idempotency replay);
//   4. verification-session flow incl. evaluate:
//      create → evidence → evaluate → 409 on re-evaluate, plus the pending
//      negative and the no-consent fail-closed negative.
//
// Server lifecycle: boots its own `next dev` on a free port (fresh-clone
// green). Set YOU_TEST_BASE (e.g. http://127.0.0.1:3210) to reuse an
// already-booted server instead.
//
// Prerequisites = the documented app boot (README / work order):
//   cd apps/web && bun install && cp .env.example .env && bun run db:push
// The suite fails LOUDLY with that hint when prerequisites are missing —
// no silent skips, no fake green.
//
// Honesty notes:
//   - the capture→complete and compile legs execute REAL provider compute
//     (capture.quality + twin.compile via the vlm-recon-1 adapter); the
//     assertions demand honest durable outcomes (job succeeded with real
//     output, or the job records its verbatim failure — which fails this
//     suite loudly rather than fabricating success);
//   - the verification evaluate leg is fully deterministic (no provider
//     dependency): coverage comes from declared regions and the anti-replay
//     window; ownershipConfidence is asserted null (no machine analysis on
//     the un-analyzed verification evidence — nothing invented);
//   - every create uses a unique stamp so repeated runs never collide.
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

// ─── tiny HTTP client with session-cookie memory ────────────────────────────
let base = process.env.YOU_TEST_BASE ?? null;
let cookie = null;

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

async function pollJob(jobId, timeoutMs = 180000) {
  const t0 = Date.now();
  for (;;) {
    const r = await call(`/api/v1/jobs/${jobId}`);
    assert.equal(r.status, 200, `job poll GET /api/v1/jobs/${jobId} → ${r.status}`);
    const j = r.json;
    assert.ok(['queued', 'provisioning', 'running', 'collecting', 'succeeded', 'failed', 'dead'].includes(j.status), `unknown job status ${j.status}`);
    // P6.A6: 'dead' is terminal (bounded retries exhausted) — returning it
    // lets the caller's status assertion fail with the honest deadLetter error.
    if (j.status === 'succeeded' || j.status === 'failed' || j.status === 'dead') return j;
    if (Date.now() - t0 > timeoutMs) {
      assert.fail(`job ${jobId} (${j.kind}) did not reach a terminal state within ${timeoutMs}ms (last: ${j.status}, progress ${j.progress})`);
    }
    await new Promise((r2) => setTimeout(r2, 1500));
  }
}

// minimal valid PNG (1×1) — bytes are content-addressed at rest; quality is
// honestly scored by the VLM when analyzed (this fixture is NOT analyzed in
// the verification leg)
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

const stamp = `${Date.now()}-${process.pid}`;
const uid = (p) => `${p}-${stamp}-${Math.random().toString(36).slice(2, 8)}`;

// ─── server lifecycle ────────────────────────────────────────────────────────
let child = null;

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
  // DB config: the app resolves DATABASE_URL from apps/web/.env OR the ambient
  // environment (a station may export its own DATABASE_URL, which wins over
  // .env). Either is acceptable; connectivity is proven by the session
  // bootstrap test failing loudly if the schema was never pushed.
  assert.ok(
    fs.existsSync(path.join(APP_DIR, '.env')) || process.env.DATABASE_URL,
    'no database config: run `cd apps/web && cp .env.example .env && bun run db:push` first',
  );
  child = spawn(process.execPath, [nextBin, 'dev', '-p', String(port)], {
    cwd: APP_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group → killTree() can take the whole tree down
  });
  child.stdout.on('data', () => { /* dev chatter — intentionally ignored */ });
  child.stderr.on('data', () => { /* dev chatter — intentionally ignored */ });
  child.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
      console.error(`[w3a-tests] next dev exited early: code=${code} signal=${signal}`);
    }
  });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120000;
  for (;;) {
    if (child.exitCode !== null) assert.fail(`next dev exited with code ${child.exitCode} before becoming ready`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) { base = url; globalThis.__YOU_TEST_BASE__ = url; return; } // shared with sibling suites (w4a hardening tests)
    } catch { /* not up yet */ }
    if (Date.now() > deadline) assert.fail(`next dev did not become ready on ${url} within 120s`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

before(async () => {
  if (base) {
    console.log(`[w3a-tests] reusing booted server at ${base} (YOU_TEST_BASE)`);
    globalThis.__YOU_TEST_BASE__ = base; // share with sibling suites in this process (w4a hardening tests)
    return;
  }
  console.log('[w3a-tests] booting apps/web (next dev) on a free port…');
  await startServer();
  console.log(`[w3a-tests] server ready at ${base}`);
});

after(async () => {
  await killTree();
  if (child && child.pid) {
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  console.log('[w3a-tests] server stopped');
});

// ═══════════════════════════════════════════════════════════════════════════
// 1 — session bootstrap (demo tenant + HUMAN-RECON-001 lab seed)
// ═══════════════════════════════════════════════════════════════════════════
test('session bootstrap: demo tenant, cookie auth, overview, HUMAN-RECON-001 seed', async () => {
  const unauth = await call('/api/v1/overview');
  assert.equal(unauth.status, 401, 'overview without a session must be 401 (auth wall)');

  const s = await call('/api/v1/session', { method: 'POST', body: {} });
  assert.equal(s.status, 200, `POST /session → ${s.status}`);
  assert.equal(s.json.user.email, 'founder@you.dev');
  assert.equal(s.json.tenant.slug, 'demo');
  assert.ok(cookie?.startsWith('you_session='), 'session cookie must be captured');

  const ov = await call('/api/v1/overview');
  assert.equal(ov.status, 200, `GET /overview with cookie → ${ov.status}`);
  assert.equal(typeof ov.json.twins, 'number');
  assert.ok(Array.isArray(ov.json.recentEvents));

  const objs = await call('/api/v1/lab/objectives');
  assert.equal(objs.status, 200);
  assert.ok(
    (objs.json ?? []).some((o) => o.code === 'HUMAN-RECON-001'),
    'the HUMAN-RECON-001 lab objective must be seeded on first session bootstrap',
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 — consent is server-enforced FAIL-CLOSED (negatives)
// ═══════════════════════════════════════════════════════════════════════════
test('consent fail-closed: evidence upload and twin compile refuse without an active grant', async () => {
  const twin = await call('/api/v1/twins', { method: 'POST', body: { displayName: `W3A Twin ${uid('neg')}` } });
  assert.equal(twin.status, 201);
  const twinId = twin.json.id;

  const cap = await call(`/api/v1/twins/${twinId}/capture-sessions`, { method: 'POST', body: {} });
  assert.equal(cap.status, 201);

  const up = await call(`/api/v1/captures/${cap.json.id}/assets`, { method: 'POST', form: uploadForm(['face.front']) });
  assert.equal(up.status, 403, `upload without consent must be 403, got ${up.status}`);
  assert.equal(up.json.error.code, 'consent_required');
  assert.match(up.json.error.message, /scope "capture"/);

  const compile = await call(`/api/v1/twins/${twinId}/compile`, { method: 'POST', body: {} });
  assert.equal(compile.status, 403, `compile without consent must be 403, got ${compile.status}`);
  assert.equal(compile.json.error.code, 'consent_required');
  assert.match(compile.json.error.message, /scope "reconstruct"/);

  const vs = await call('/api/v1/verification-sessions', {
    method: 'POST',
    body: { subjectId: uid('unconsented-subject'), purpose: 'must be refused' },
  });
  assert.equal(vs.status, 403, `verification-session without consent must be 403, got ${vs.status}`);
  assert.equal(vs.json.error.code, 'consent_required');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 — twin → capture → evidence → complete → compile (real durable jobs)
// ═══════════════════════════════════════════════════════════════════════════
test('twin → capture → evidence → compile: durable capture.quality + twin.compile jobs, published TwinVersion', async () => {
  const twin = await call('/api/v1/twins', { method: 'POST', body: { displayName: `W3A Twin ${uid('flow')}`, personName: 'W3A Person' } });
  assert.equal(twin.status, 201);
  const twinId = twin.json.id;
  const subjectId = twin.json.subjectId;

  const grant = await call('/api/v1/consent-grants', {
    method: 'POST',
    body: { subjectId, purpose: 'w3a integration flow', scopes: ['capture', 'reconstruct'], ttlHours: 2 },
  });
  assert.equal(grant.status, 201);
  assert.deepEqual(grant.json.scopes, ['capture', 'reconstruct']);

  const cap = await call(`/api/v1/twins/${twinId}/capture-sessions`, { method: 'POST', body: {} });
  assert.equal(cap.status, 201);
  assert.equal(cap.json.status, 'pending');
  const captureId = cap.json.id;

  const regions = ['face.front', 'face.profile', 'face.hairline', 'teeth', 'hands', 'silhouette.front', 'silhouette.side'];
  const up = await call(`/api/v1/captures/${captureId}/assets`, { method: 'POST', form: uploadForm(regions) });
  assert.equal(up.status, 201, `upload → ${up.status}`);
  assert.deepEqual(up.json.regions, regions);
  assert.match(up.json.contentHash, /^[0-9a-f]{64}$/);
  const assetId = up.json.id;

  const done = await call(`/api/v1/captures/${captureId}/complete`, { method: 'POST', body: {} });
  assert.equal(done.status, 202, `complete → ${done.status}`);
  assert.ok(done.json.jobId, 'async work must return a durable job id immediately');

  const qualityJob = await pollJob(done.json.jobId);
  assert.equal(qualityJob.status, 'succeeded', `capture.quality failed honestly: ${qualityJob.error ?? ''}`);
  assert.equal(qualityJob.progress, 1);
  assert.ok(qualityJob.output.assetsAnalyzed >= 1, 'the VLM analysis must really have run');

  const capAfter = await call(`/api/v1/captures/${captureId}`);
  assert.equal(capAfter.status, 200);
  assert.equal(capAfter.json.status, 'complete');

  const compile = await call(`/api/v1/twins/${twinId}/compile`, {
    method: 'POST',
    body: { captureSessionId: captureId, style: 'photorealistic' },
  });
  assert.equal(compile.status, 202);
  assert.ok(compile.json.jobId);

  const compileJob = await pollJob(compile.json.jobId);
  assert.equal(compileJob.status, 'succeeded', `twin.compile failed honestly: ${compileJob.error ?? ''}`);
  assert.ok(compileJob.output.twinVersionId, 'compile output must reference the published TwinVersion');

  const twinAfter = await call(`/api/v1/twins/${twinId}`);
  assert.equal(twinAfter.status, 200);
  assert.equal(twinAfter.json.currentVersion, 1);
  assert.equal(twinAfter.json.status, 'reconstructed');
  const version = (twinAfter.json.versions ?? [])[0];
  assert.ok(version, 'a TwinVersion must exist after compile');
  assert.equal(version.status, 'published', 'published TwinVersions are immutable');
  assert.ok(version.htir, 'the canonical HTIR document must be attached');
  assert.equal(version.htir.provenance.subjectId, subjectId);
  assert.ok(version.htir.provenance.evidenceAssetIds.includes(assetId), 'provenance must cite the real evidence');
  assert.ok(version.htir.provenance.consentGrantIds.includes(grant.json.id), 'provenance must cite the consent grant');

  // the analysis artifact from capture.quality is honest (never fabricated):
  const assetView = (capAfter.json.assets ?? []).find((a) => a.id === assetId);
  assert.ok(assetView?.quality, 'the uploaded asset must carry machine quality analysis after capture.quality');
  assert.ok(typeof assetView.quality.score === 'number' && assetView.quality.score >= 0 && assetView.quality.score <= 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 — templates CRUD + analyze durable job (incl. idempotency replays)
// ═══════════════════════════════════════════════════════════════════════════
test('templates: create, idempotent replay, read, durable analyze job with persisted analysis', async () => {
  const idem = uid('tpl-idem');
  const body = {
    name: `W3A Template ${uid('name')}`,
    description: 'w3a integration template',
    captureChecklist: [
      { item: 'Front face', capability: 'face', region: 'face.front' },
      { item: 'Profile', capability: 'face', region: 'face.profile', optional: true },
    ],
    scenes: [{ name: 'studio-a', parameters: { lighting: 'even' } }],
    stylePresets: [{ name: 'natural', style: 'photorealistic' }],
  };

  const t1 = await call('/api/v1/templates', { method: 'POST', body, headers: { 'x-idempotency-key': idem } });
  assert.equal(t1.status, 201, `create → ${t1.status}`);
  assert.equal(t1.json.version, 1);
  assert.equal(t1.json.status, 'draft');
  assert.equal(t1.json.manifest.captureChecklist.length, 2);
  assert.equal(t1.json.scenes.length, 1);

  const t2 = await call('/api/v1/templates', { method: 'POST', body, headers: { 'x-idempotency-key': idem } });
  assert.equal(t2.status, 200, `replay must return 200 with the existing record, got ${t2.status}`);
  assert.equal(t2.json.id, t1.json.id, 'idempotency replay must return the SAME template');
  assert.equal(t2.json.createdAt, t1.json.createdAt);

  const got = await call(`/api/v1/templates/${t1.json.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.json.id, t1.json.id);
  assert.equal(got.json.analysis, null, 'no analysis before the analyze job runs');

  const listed = await call('/api/v1/templates');
  assert.equal(listed.status, 200);
  assert.ok(listed.json.some((t) => t.id === t1.json.id), 'list must contain the created template');

  const anaIdem = `${idem}-analyze`;
  const ana = await call(`/api/v1/templates/${t1.json.id}/analyze`, { method: 'POST', body: {}, headers: { 'x-idempotency-key': anaIdem } });
  assert.equal(ana.status, 202);
  assert.ok(ana.json.jobId);

  const job = await pollJob(ana.json.jobId);
  assert.equal(job.status, 'succeeded', `template.analyze failed honestly: ${job.error ?? ''}`);

  const anaReplay = await call(`/api/v1/templates/${t1.json.id}/analyze`, { method: 'POST', body: {}, headers: { 'x-idempotency-key': anaIdem } });
  assert.equal(anaReplay.status, 202);
  assert.equal(anaReplay.json.jobId, ana.json.jobId, 'analyze replay must dedupe to the SAME durable job');

  const analyzed = await call(`/api/v1/templates/${t1.json.id}`);
  assert.equal(analyzed.status, 200);
  assert.ok(analyzed.json.analysis, 'the analysis must be persisted on the template');
  assert.ok(analyzed.json.analyzedAt, 'analyzedAt must be set');
  assert.deepEqual(analyzed.json.analysis.capabilities.covered, ['face'], 'declared regions imply their capability family');
  assert.ok(analyzed.json.analysis.evidenceGaps.length > 0, 'uncovered important regions are reported honestly as evidence gaps');
  assert.equal(analyzed.json.analysis.checklist.items, 2);
  assert.equal(analyzed.json.analysis.checklist.required, 1);
  assert.equal(analyzed.json.analysis.checklist.optional, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 — verification-session flow incl. evaluate (deterministic, §Trust)
// ═══════════════════════════════════════════════════════════════════════════
test('verification-sessions: create → evidence → evaluate → 409 on re-evaluate (immutable result)', async () => {
  // dedicated twin + evidence asset (NOT machine-analyzed: ownership confidence
  // must then be honestly null — nothing invented)
  const twin = await call('/api/v1/twins', { method: 'POST', body: { displayName: `W3A Verify Twin ${uid('v')}` } });
  assert.equal(twin.status, 201);
  const twinId = twin.json.id;
  const subjectId = twin.json.subjectId;

  const grant = await call('/api/v1/consent-grants', {
    method: 'POST',
    body: { subjectId, purpose: 'w3a verification flow', scopes: ['capture'], ttlHours: 2 },
  });
  assert.equal(grant.status, 201);

  const cap = await call(`/api/v1/twins/${twinId}/capture-sessions`, { method: 'POST', body: {} });
  assert.equal(cap.status, 201);
  // cover EVERY challenge variant's required regions in one declared asset
  const allRegions = ['face.front', 'face.profile', 'face.hairline', 'teeth', 'hands', 'silhouette.front', 'silhouette.side'];
  const up = await call(`/api/v1/captures/${cap.json.id}/assets`, { method: 'POST', form: uploadForm(allRegions) });
  assert.equal(up.status, 201);
  const assetId = up.json.id;

  const vs = await call('/api/v1/verification-sessions', {
    method: 'POST',
    body: { subjectId, purpose: 'w3a liveness verification', twinId },
  });
  assert.equal(vs.status, 201, `create → ${vs.status}`);
  const view = vs.json;
  assert.equal(view.status, 'pending');
  assert.equal(view.method, 'liveness-challenge');
  assert.equal(view.subjectId, subjectId);
  assert.equal(view.twinId, twinId);
  assert.equal(view.consentGrantId, grant.json.id, 'the covering grant is recorded for the audit trail');
  assert.ok(view.challenge, 'an ACTIVE liveness challenge must be issued (SECURITY_PRIVACY control 1)');
  assert.ok(view.challenge.requiredRegions.length > 0);
  assert.ok(new Date(view.challenge.expiresAt).getTime() > Date.now(), 'the anti-replay window must be in the future');
  for (const r of view.challenge.requiredRegions) assert.ok(allRegions.includes(r), `challenge region ${r} is covered by the fixture asset`);
  const vsId = view.id;

  // evaluate while still pending → 409
  const tooEarly = await call(`/api/v1/verification-sessions/${vsId}/evaluate`, { method: 'POST', body: {} });
  assert.equal(tooEarly.status, 409, `evaluate on pending must be 409, got ${tooEarly.status}`);
  assert.equal(tooEarly.json.error.code, 'conflict');
  assert.match(tooEarly.json.error.message, /pending/);

  // submit evidence → in_review, challenge consumed
  const ev = await call(`/api/v1/verification-sessions/${vsId}/evidence`, { method: 'POST', body: { evidenceAssetIds: [assetId] } });
  assert.equal(ev.status, 200, `evidence → ${ev.status}`);
  assert.equal(ev.json.status, 'in_review');
  assert.deepEqual(ev.json.evidenceAssetIds, [assetId]);
  assert.ok(ev.json.challenge.consumedAt, 'the challenge must be marked consumed');
  assert.ok(ev.json.submittedAt);

  // evaluate → 200, deterministic honest result
  const evaluated = await call(`/api/v1/verification-sessions/${vsId}/evaluate`, { method: 'POST', body: {} });
  assert.equal(evaluated.status, 200, `evaluate → ${evaluated.status}`);
  assert.equal(evaluated.json.status, 'evaluated');
  assert.ok(evaluated.json.evaluatedAt);
  const result = evaluated.json.result;
  assert.ok(result, 'the immutable VerificationResult must be present');
  assert.equal(result.outcome, 'liveness-verified');
  assert.equal(result.liveness.status, 'passed');
  assert.equal(result.liveness.onTime, true, 'evidence was submitted inside the anti-replay window');
  assert.deepEqual(result.liveness.missingRegions, []);
  assert.deepEqual(result.evidenceAssetIds, [assetId]);
  // SECURITY_PRIVACY controls 2–3 — NEVER claim identity or visual similarity
  assert.equal(result.identityMatch, null, 'identityMatch must ALWAYS be null on this surface');
  assert.equal(result.visualSimilarity, null, 'visualSimilarity must ALWAYS be null on this surface');
  assert.equal(result.ownershipConfidence, null, 'unanalyzed evidence → ownershipConfidence must be null (nothing invented)');
  assert.ok(result.notes.some((n) => /ownershipConfidence is null/.test(n)), 'the honest null-confidence note must be present');
  assert.ok(result.notes.some((n) => /visualSimilarity is null/.test(n)));
  assert.ok(result.notes.some((n) => /identityMatch is null/.test(n)));

  // re-evaluate → 409 (the result is immutable, never recomputed)
  const again = await call(`/api/v1/verification-sessions/${vsId}/evaluate`, { method: 'POST', body: {} });
  assert.equal(again.status, 409, `re-evaluate must be 409, got ${again.status}`);
  assert.match(again.json.error.message, /immutable/);

  // GET persists the evaluated state + identical result (durability)
  const persisted = await call(`/api/v1/verification-sessions/${vsId}`);
  assert.equal(persisted.status, 200);
  assert.equal(persisted.json.status, 'evaluated');
  assert.deepEqual(persisted.json.result, result, 'the persisted result must be byte-identical');

  // the evaluation event was emitted (durable event record)
  const events = await call('/api/v1/events?type=verification.session.evaluated&limit=10');
  assert.equal(events.status, 200);
  assert.ok(
    (events.json ?? []).some((e) => e.entityId === vsId),
    'a verification.session.evaluated event must exist for this session',
  );
});
