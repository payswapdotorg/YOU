// ═══════════════════════════════════════════════════════════════════════════
// YOU targeted EvidenceRequest UX tests (P6.B5, Worker B lane) — node:test.
//
// Covers the closed feedback loop at the API level with real evidence:
//   1. FULFILLMENT LINKAGE: guided fulfill → prefilled 8-step protocol with
//      the capability focused (out-of-scope steps pre-skipped WITH reasons —
//      never silent) → request LINKED (captureSessionId) but honestly OPEN
//      until the capture COMPLETES → complete flips it fulfilled and emits
//      evidence.request.fulfilled. Legacy (non-guided) fulfill keeps its
//      immediate-fulfilled contract (backwards compatibility).
//   2. CONSENT GATE (server-enforced, B3 reuse): no grant → 403
//      consent_required (machine-readable); statement-less grant → 403 with
//      the exact missingStatements; covered grant → 201; grant revoked
//      mid-flow → complete refuses 403; a fresh covering grant unblocks it.
//      In-progress guard: re-fulfilling an open request with an ACTIVE linked
//      session → 409 with the session id.
//   3. EXPIRY: maintenance sweep expires open requests past the TTL
//      (default 30d, seeded via createdAt), honest transition (row stays,
//      event emitted); requests with an ACTIVE fulfillment capture are
//      skipped, never expired mid-flight. Operator-session law: an API key
//      is refused 403.
//   4. LIST FILTERING: ?status= / ?capability= exact-match filters; invalid
//      status → 400.
//   5. TENANT ISOLATION: a second tenant (seeded directly) sees none of the
//      first tenant's requests and cannot fulfill them (404).
//
// Server lifecycle: boots its own `next dev` on a free port, or reuses the
// sibling suite's server when aggregated — same law as the P6.B3 suite.
// Prerequisites: the documented app boot (cd apps/web && bun install &&
// cp .env.example .env && bun run db:push). NO network beyond 127.0.0.1;
// the DB is touched directly (Prisma) only for timestamps + the isolation
// tenant, mirroring the B3 suite's seeding precedent.
// ═══════════════════════════════════════════════════════════════════════════
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
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

// ─── shared state across the sequential tests ────────────────────────────────
let base = process.env.YOU_TEST_BASE ?? null;
let cookie = null;
let child = null;
let ownServer = false;
let basePromise = null;
let prismaClient = null;

let twinA = null;
let grantA = null; // statement-covered grant
let req1 = null; // hands request — the guided closed loop
let session1 = null; // its linked guided capture
let req2 = null; // face request — stays open for filtering
let req3 = null; // hands request — legacy fulfill
let req4 = null; // expiry candidate (unlinked)
let req5 = null; // expiry candidate (active fulfillment → grace)
let tenantBToken = null; // seeded second tenant's session token

// ─── tiny HTTP client with session-cookie memory ─────────────────────────────
async function call(pathname, { method = 'GET', body, form, headers = {}, noCookie = false, cookieOverride } = {}) {
  const h = { ...headers };
  if (cookieOverride) h.cookie = cookieOverride;
  else if (cookie && !noCookie) h.cookie = cookie;
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
  const boundary = `----b5ux${stamp}${Math.floor(Math.random() * 1e6)}`;
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
          console.log(`[b5-tests] reusing suite server at ${base}`);
          return base;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(!aggregated, 'aggregated run: the sibling suite never published its server URL within 150s');
      console.log('[b5-tests] booting apps/web (next dev) on a free port…');
      await startServer();
      ownServer = true;
      console.log(`[b5-tests] server ready at ${base}`);
      return base;
    })().catch((err) => {
      basePromise = null;
      throw err;
    });
  }
  return basePromise;
}

// ─── direct DB access (timestamps + the isolation tenant; B3-suite precedent)
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

// ─── the six F1 statements (B3-suite shape) ─────────────────────────────────
function f1Statements() {
  return {
    what: `Photos for the P6.B5 fulfillment loop ${stamp}`,
    why: 'Fulfill a targeted evidence request through the guided capture flow for the product tests below.',
    tests: [`P6.B5 closed-loop acceptance ${stamp}`],
    retention: {
      mayBeRetained: true,
      retainUntil: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      policy: 'retained for the listed tests until the window elapses or consent is withdrawn',
    },
    training: { permitted: false, note: 'not granted — training is default-denied' },
    deletion: 'Subject withdraws by revoking the consent grant; evidence is then deleted (TwinVersions stay immutable).',
  };
}

const F1_SIX = ['what', 'why', 'tests', 'retention', 'training', 'deletion'];

async function grantConsent(subjectId, statements, ttlHours = 6) {
  return call('/api/v1/consent-grants', {
    method: 'POST',
    body: { subjectId, purpose: `P6.B5 fulfillment ${stamp}`, scopes: ['capture', 'reconstruct'], ttlHours, ...(statements ? { statements } : {}) },
  });
}

async function createRequest(capability, reason) {
  return call('/api/v1/evidence-requests', {
    method: 'POST',
    body: {
      reason,
      capability,
      instructions: `Capture the ${capability} evidence exactly as requested (${stamp}).`,
      expectedSignal: `${capability} signal for the recorded deficiency`,
    },
  });
}

async function listRequests(qs2 = '') {
  return call(`/api/v1/evidence-requests${qs2}`);
}

async function getRequest(id) {
  // the list route is the read surface — scoped find keeps old runs' rows out
  const r = await listRequests();
  if (r.status !== 200) return r;
  const mine = (r.json ?? []).find((x) => x.id === id);
  return { status: mine ? 200 : 404, json: mine ?? null };
}

// ─── lifecycle ───────────────────────────────────────────────────────────────
after(async () => {
  if (prismaClient) await prismaClient.$disconnect().catch(() => undefined);
  if (ownServer) {
    await killTree();
    if (child && child.pid) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    console.log('[b5-tests] own server stopped');
  }
});

// ─── 1. consent gate at guided fulfillment creation ──────────────────────────
test('b5: consent gate on the fulfillment capture — no grant, statement-less grant, covered grant', async () => {
  await ensureBase();
  await call('/api/v1/session', { method: 'POST', body: {} });
  const t = await call('/api/v1/twins', { method: 'POST', body: { displayName: `B5 main ${stamp}` } });
  assert.equal(t.status, 201, `twin create → ${t.status}`);
  twinA = t.json;

  const created = await createRequest('hands', `Hands deficiency ${stamp}`);
  assert.equal(created.status, 201, `request create → ${created.status}`);
  req1 = created.json;
  assert.equal(req1.status, 'open');
  assert.equal(req1.captureSessionId, null);

  // no grant at all → machine-readable 403, and NOTHING was created
  let r = await call(`/api/v1/evidence-requests/${req1.id}/fulfill`, { method: 'POST', body: { twinId: twinA.id, guided: true } });
  assert.equal(r.status, 403, `guided fulfill without grant → ${r.status}`);
  assert.equal(r.json.error.code, 'consent_required');
  assert.equal(r.json.error.details.scope, 'capture');
  assert.equal(r.json.error.details.f1, true);
  assert.equal(r.json.error.details.reason, 'no_active_grant');
  assert.deepEqual(r.json.error.details.requiredStatements.sort(), [...F1_SIX].sort());
  let fresh = await getRequest(req1.id);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.json.status, 'open', 'the request must stay open after a refused gate');
  assert.equal(fresh.json.captureSessionId, null, 'no session may be linked by a refused gate');

  // capture-scope grant WITHOUT the six statements → still refused, precisely
  r = await grantConsent(twinA.subjectId, null);
  assert.equal(r.status, 201);
  r = await call(`/api/v1/evidence-requests/${req1.id}/fulfill`, { method: 'POST', body: { twinId: twinA.id, guided: true } });
  assert.equal(r.status, 403, `guided fulfill with statement-less grant → ${r.status}`);
  assert.equal(r.json.error.code, 'consent_required');
  assert.equal(r.json.error.details.reason, 'statements_incomplete');
  assert.deepEqual(r.json.error.details.missingStatements.sort(), [...F1_SIX].sort());

  // full statement-covered grant → the prefilled guided session opens
  r = await grantConsent(twinA.subjectId, f1Statements());
  assert.equal(r.status, 201);
  grantA = r.json;
  r = await call(`/api/v1/evidence-requests/${req1.id}/fulfill`, { method: 'POST', body: { twinId: twinA.id, guided: true } });
  assert.equal(r.status, 201, `guided fulfill with covered grant → ${r.status}`);
  session1 = r.json.captureSession;
  assert.ok(session1.protocol, 'the fulfillment capture is a GUIDED session (protocol persisted)');
  assert.equal(session1.consentGrantId, grantA.id);
  assert.equal(session1.status, 'pending');

  // capability → protocol mapping: hands focused, everything else pre-skipped
  const steps = session1.protocol.steps;
  assert.equal(steps.length, 8);
  const hands = steps.find((s) => s.id === 'hands');
  assert.equal(hands.state, 'current', 'the focused step is the current one');
  assert.equal(hands.required, true, 'the request target is required');
  assert.ok(hands.instruction.includes('TARGETED EVIDENCE REQUEST'), 'the focused instruction carries the request text');
  assert.ok(hands.instruction.includes('hands signal'), 'the focused instruction carries the expected signal');
  for (const s of steps.filter((x) => x.id !== 'hands')) {
    assert.equal(s.state, 'skipped', `out-of-scope step ${s.id} is pre-skipped`);
    assert.ok(s.skipReason && s.skipReason.includes('out of scope'), `step ${s.id} skip reason is honest`);
    assert.equal(s.required, false, `pre-skipped step ${s.id} is not required`);
  }
  // the fulfillment context block rides the protocol
  assert.equal(session1.protocol.fulfillment.requestId, req1.id);
  assert.equal(session1.protocol.fulfillment.capability, 'hands');
  assert.deepEqual(session1.protocol.fulfillment.focusedStepIds, ['hands']);

  // the request is LINKED but honestly OPEN (no fake progress)
  fresh = await getRequest(req1.id);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.json.status, 'open', 'the request stays open until the capture completes');
  assert.equal(fresh.json.captureSessionId, session1.id, 'the fulfillment capture is linked');
});

// ─── 2. in-progress guard + advance gate + completion linkage ────────────────
test('b5: in-progress guard, advance-gate re-verification, completion flips fulfilled + event', async () => {
  await ensureBase();

  // re-fulfilling while the linked capture is ACTIVE → honest 409 with the id
  let r = await call(`/api/v1/evidence-requests/${req1.id}/fulfill`, { method: 'POST', body: { twinId: twinA.id, guided: true } });
  assert.equal(r.status, 409, `re-fulfill in progress → ${r.status}`);
  assert.equal(r.json.error.code, 'conflict');
  assert.equal(r.json.error.details.reason, 'fulfillment_in_progress');
  assert.equal(r.json.error.details.captureSessionId, session1.id);

  // advance: submit the focused hands step with real evidence (grant active)
  r = await multipart(`/api/v1/captures/${session1.id}/f1/steps/hands/submit`, PNG, 'image/png');
  assert.equal(r.status, 201, `focused step submit → ${r.status}`);
  assert.equal(r.json.submitted.checkpoint.passed, true);

  // revoke the grant → the completion gate (advance-class) refuses honestly
  r = await call(`/api/v1/consent-grants/${grantA.id}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  r = await call(`/api/v1/captures/${session1.id}/f1/complete`, { method: 'POST' });
  assert.equal(r.status, 403, `complete with revoked grant → ${r.status}`);
  assert.equal(r.json.error.code, 'consent_required');
  let fresh = await getRequest(req1.id);
  assert.equal(fresh.json.status, 'open', 'a refused completion never flips the request');

  // a fresh covering grant unblocks completion → the closed loop lands
  r = await grantConsent(twinA.subjectId, f1Statements());
  assert.equal(r.status, 201);
  r = await call(`/api/v1/captures/${session1.id}/f1/complete`, { method: 'POST' });
  assert.equal(r.status, 200, `complete with re-grant → ${r.status}`);
  assert.equal(r.json.status, 'complete');
  assert.equal(r.json.manifest.totals.verified, r.json.manifest.totals.assets, 'the manifest re-hash verified every asset');

  fresh = await getRequest(req1.id);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.json.status, 'fulfilled', 'completion flips the request fulfilled');
  assert.equal(fresh.json.captureSessionId, session1.id, 'the linkage survives');

  // the event rode the emitEvent seam
  r = await call('/api/v1/events?type=evidence.request.fulfilled&limit=200');
  assert.equal(r.status, 200);
  const hit = (r.json ?? []).find((e) => e.entityId === req1.id);
  assert.ok(hit, 'evidence.request.fulfilled emitted for the request');
  assert.equal(hit.payload.captureSessionId, session1.id);
  assert.equal(hit.payload.capability, 'hands');

  // fulfilled requests cannot be fulfilled again
  r = await call(`/api/v1/evidence-requests/${req1.id}/fulfill`, { method: 'POST', body: { twinId: twinA.id, guided: true } });
  assert.equal(r.status, 409, `re-fulfill a fulfilled request → ${r.status}`);
});

// ─── 3. legacy fulfill stays backwards compatible + list filtering ───────────
test('b5: legacy fulfill contract + list filtering by status/capability', async () => {
  await ensureBase();

  // a second, deliberately OPEN request (capability face) for the filter legs
  let r = await createRequest('face', `Face profile gap ${stamp}`);
  assert.equal(r.status, 201);
  req2 = r.json;

  // the LEGACY fulfill (no guided flag): immediate fulfilled, { captureSession }
  r = await createRequest('hands', `Second hands gap ${stamp}`);
  assert.equal(r.status, 201);
  req3 = r.json;
  r = await call(`/api/v1/evidence-requests/${req3.id}/fulfill`, { method: 'POST', body: { twinId: twinA.id } });
  assert.equal(r.status, 201, `legacy fulfill → ${r.status}`);
  assert.ok(r.json.captureSession.checklist.length > 0, 'legacy path still builds the focused checklist');
  assert.equal(r.json.captureSession.protocol, null, 'legacy path is NOT a guided session');
  assert.equal('evidenceRequest' in r.json, false, 'legacy response shape preserved');
  let fresh = await getRequest(req3.id);
  assert.equal(fresh.json.status, 'fulfilled', 'legacy semantics: fulfilled at creation');
  assert.equal(fresh.json.captureSessionId, r.json.captureSession.id);

  // status filter
  r = await listRequests('?status=open');
  assert.equal(r.status, 200);
  const openIds = (r.json ?? []).map((x) => x.id);
  assert.ok(openIds.includes(req2.id), 'the open request shows under ?status=open');
  assert.ok(!openIds.includes(req1.id) && !openIds.includes(req3.id), 'fulfilled requests are filtered out');

  r = await listRequests('?status=fulfilled');
  const fulfilledIds = (r.json ?? []).map((x) => x.id);
  assert.ok(fulfilledIds.includes(req1.id) && fulfilledIds.includes(req3.id), 'fulfilled requests show under ?status=fulfilled');
  assert.ok(!fulfilledIds.includes(req2.id), 'the open request is filtered out');

  // capability filter + combination
  r = await listRequests('?capability=face&status=open');
  const faceOpenIds = (r.json ?? []).map((x) => x.id);
  assert.ok(faceOpenIds.includes(req2.id), '?capability=face&status=open finds the face request');
  assert.ok(!faceOpenIds.includes(req1.id) && !faceOpenIds.includes(req3.id), 'hands requests are excluded');

  r = await listRequests('?capability=hands');
  const handsIds = (r.json ?? []).map((x) => x.id);
  assert.ok(handsIds.includes(req1.id) && handsIds.includes(req3.id), '?capability=hands finds both hands requests');
  assert.ok(!handsIds.includes(req2.id), 'the face request is excluded');

  // invalid status → honest 400
  r = await listRequests('?status=bogus');
  assert.equal(r.status, 400, `invalid status filter → ${r.status}`);
});

// ─── 4. expiry transition (maintenance sweep, honest, no silent deletion) ─────
test('b5: expiry sweep — TTL transition, event, mid-fulfillment grace, operator-session law', async () => {
  await ensureBase();
  const pr = await prisma();

  // an unlinked request 40 days old → expires
  let r = await createRequest('silhouette', `Old unlinked request ${stamp}`);
  assert.equal(r.status, 201);
  req4 = r.json;
  await pr.evidenceRequest.update({
    where: { id: req4.id },
    data: { createdAt: new Date(Date.now() - 40 * 24 * 3600 * 1000) },
  });

  // an open request with an ACTIVE fulfillment capture 40 days old → grace
  r = await createRequest('hair', `Old in-flight request ${stamp}`);
  assert.equal(r.status, 201);
  req5 = r.json;
  r = await call(`/api/v1/evidence-requests/${req5.id}/fulfill`, { method: 'POST', body: { twinId: twinA.id, guided: true } });
  assert.equal(r.status, 201, `guided fulfill for the grace leg → ${r.status}`);
  await pr.evidenceRequest.update({
    where: { id: req5.id },
    data: { createdAt: new Date(Date.now() - 40 * 24 * 3600 * 1000) },
  });

  r = await call('/api/v1/maintenance/expire-evidence-requests', { method: 'POST', body: {} });
  assert.equal(r.status, 200, `expiry sweep → ${r.status}`);
  assert.equal(r.json.ttlDays, 30, 'documented default TTL');
  assert.ok(r.json.expired >= 1, 'the unlinked stale request expired');
  assert.ok(r.json.skippedActiveFulfillments >= 1, 'the in-flight request was skipped, not expired');

  // honest transition: the row STAYS with status expired
  r = await getRequest(req4.id);
  assert.equal(r.status, 200, 'the expired request is still listed (no silent deletion)');
  assert.equal(r.json.status, 'expired');

  // the grace request stays open with its link intact
  r = await getRequest(req5.id);
  assert.equal(r.json.status, 'open', 'an active fulfillment is never expired mid-flight');
  assert.ok(r.json.captureSessionId, 'the grace request keeps its linked session');

  // fulfilled/expired requests are never re-touched
  r = await getRequest(req1.id);
  assert.equal(r.json.status, 'fulfilled');

  // the expiry event rode the emitEvent seam
  r = await call('/api/v1/events?type=evidence.request.expired&limit=200');
  assert.equal(r.status, 200);
  const hit = (r.json ?? []).find((e) => e.entityId === req4.id);
  assert.ok(hit, 'evidence.request.expired emitted for the expired request');
  assert.equal(hit.payload.ttlDays, 30);

  // operator-session law: even a WRITE api key is refused (maintenance pattern)
  r = await call('/api/v1/api-keys', { method: 'POST', body: { name: `b5-gate ${stamp}`, scopes: ['write'] } });
  assert.equal(r.status, 201, `api key create → ${r.status}`);
  const secret = r.json.secret;
  assert.ok(typeof secret === 'string' && secret.startsWith('you_sk_'));
  r = await call('/api/v1/maintenance/expire-evidence-requests', {
    method: 'POST',
    body: {},
    headers: { authorization: `Bearer ${secret}` },
    noCookie: true, // the cookie must not shadow the bearer leg
  });
  assert.equal(r.status, 403, `maintenance with an api key → ${r.status}`);
});

// ─── 5. tenant isolation ─────────────────────────────────────────────────────
test('b5: tenant isolation — a second tenant sees and fulfills nothing of the first', async () => {
  await ensureBase();
  const pr = await prisma();

  // seed a second tenant + user + session directly (the B3 seeding precedent)
  const tenantB = await pr.tenant.create({
    data: { slug: `b5-iso-${stamp}`, name: `B5 Isolation ${stamp}` },
  });
  const userB = await pr.user.create({
    data: { tenantId: tenantB.id, email: `b5-${stamp}@example.test`, name: 'B5 Isolation User' },
  });
  const sessionB = await pr.session.create({
    data: {
      userId: userB.id,
      token: `b5-tok-${stamp}-${randomBytes(8).toString('hex')}`,
      expiresAt: new Date(Date.now() + 3600 * 1000),
    },
  });
  tenantBToken = sessionB.token;
  const bCookie = `you_session=${tenantBToken}`;

  // tenant B's list contains none of tenant A's requests
  let r = await call('/api/v1/evidence-requests', { cookieOverride: bCookie });
  assert.equal(r.status, 200, `tenant B list → ${r.status}`);
  const bIds = (r.json ?? []).map((x) => x.id);
  for (const id of [req1.id, req2.id, req3.id, req4.id, req5.id]) {
    assert.ok(!bIds.includes(id), `tenant B must not see request ${id}`);
  }

  // tenant B cannot fulfill tenant A's request (404, not 403 — no existence leak)
  r = await call(`/api/v1/evidence-requests/${req2.id}/fulfill`, {
    method: 'POST',
    body: { twinId: twinA.id, guided: true },
    cookieOverride: bCookie,
  });
  assert.equal(r.status, 404, `cross-tenant fulfill → ${r.status}`);
  assert.equal(r.json.error.code, 'not_found');

  // the cross-tenant attempt left the request untouched
  r = await getRequest(req2.id);
  assert.equal(r.json.status, 'open');
  assert.equal(r.json.captureSessionId, null);
});
