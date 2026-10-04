// ═══════════════════════════════════════════════════════════════════════════
// YOU docs/playground/onboarding tests (P6.B9, Worker B lane) — node:test.
//
// Covers the P6.B9 developer surface with real evidence, two layers:
//
// PURE (no server, no network, no db — the agent-runtime suite's law):
//   1. INVENTORY: the playground operation inventory matches the FROZEN
//      OpenAPI list (contracts/openapi/v1/openapi.yaml) EXACTLY — set
//      equality both ways, parsed with the same text algorithm the
//      contract-freeze gate uses; every operation carries a derived tag.
//   2. REQUEST BUILDING: mutation/executability derivations (GET read-only;
//      the two multipart upload ops refused with their reason; exact
//      inventory lookups; query hints reference real operations) and the
//      path resolver (substitution, required params, traversal/smuggling
//      rejection, the one documented catch-all).
//   3. SANDBOX: fail-closed resolution — unset/"0"/garbage all stay LIVE
//      (default off, never accidentally on); "1" without the fixtures seam
//      is the honest unavailable state; "1" WITH a registered seam flips to
//      sandbox (the registration point is exercised, then unregistered).
//   4. EXAMPLES: every flow's operations exist in the frozen inventory;
//      every `client.<group>.<method>(` call in the snippet strings exists
//      on the REAL @you/sdk-js YouClient (structural) AND appears verbatim
//      in examples-compile.ts (the tsc-gated mirror — snippets cannot drift
//      from the SDK types or invent endpoints).
//   5. ONBOARDING: tour state persistence (fresh → show; dismissed/completed
//      → never again; corrupt storage → honest fresh start; per-user
//      isolation; storage failures swallowed) and the NO-FAKE-STEPS law
//      (every stop links to a real shell view, ids unique, copy non-empty).
//
// API LEVEL (boots/reuses the shared app server like the P6.B3/B5/B7
// suites; no network beyond 127.0.0.1; the DB is touched directly only for
// the isolation tenant — the B5/B7 suite law):
//   6. GET /api/v1/develop/playground — auth'd, honest sandbox resolution,
//      inventory count matches the client module.
//   7. POST …/execute — read-only operations execute LIVE against the real
//      API (status/headers/timing/body envelope, real tenant data).
//   8. MUTATION CONFIRMATION at the API level: a mutation without
//      mutationAcknowledged is refused with the typed envelope and has NO
//      side effect; with acknowledgement it executes (create → delete
//      lifecycle, verified gone).
//   9. HONEST REFUSALS: unknown operations, multipart ops, invalid JSON
//      bodies, and a requested sandbox (unavailable) → typed errors, never
//      fabricated responses; set-cookie never renders in the viewer.
//  10. TENANT ISOLATION: the proxy forwards ONLY the caller's auth —
//      tenant B sees none of tenant A's data through the playground, a
//      cross-tenant detail read returns the honest inner 404, and the
//      confirmation gate is tenant-independent.
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

import {
  PLAYGROUND_OPERATIONS,
  QUERY_HINTS,
  findOperation,
  isMutationMethod,
  operationExecutable,
  operationKey,
  resolveSpecPath,
  tagOf,
} from '../../apps/web/src/lib/you/develop/playground-ops.ts';
import {
  PLAYGROUND_SANDBOX_ENV_VAR,
  playgroundFixturesPresent,
  registerPlaygroundFixtures,
  resolveSandboxMode,
} from '../../apps/web/src/lib/you/develop/sandbox.ts';
import { EXAMPLE_FLOWS } from '../../apps/web/src/lib/you/develop/examples.ts';
import {
  TOUR_STOPS,
  assertTourDefinitionValid,
  completeTour,
  dismissTour,
  readTourState,
  resetTour,
  shouldShowTour,
  tourStorageKey,
  writeTourState,
} from '../../apps/web/src/lib/you/develop/onboarding.ts';
import { VIEW_IDS } from '../../apps/web/src/hooks/you/use-you-store.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const APP_DIR = path.join(REPO_ROOT, 'apps', 'web');
const stamp = `${Date.now()}-${process.pid}`;

// ─── shared state across the sequential tests ────────────────────────────────
let base = process.env.YOU_TEST_BASE ?? null;
let cookie = null;
let child = null;
let ownServer = false;
let basePromise = null;
let prismaClient = null;

let twinA = null;

// ═════════════════════════════════════════════════════════════════════════
// PART A — PURE: the frozen inventory
// ═════════════════════════════════════════════════════════════════════════

/** The freeze gate's own text algorithm (scripts/check-contracts-freeze.mjs §2). */
function frozenSpecOperations() {
  const spec = fs.readFileSync(path.join(REPO_ROOT, 'contracts', 'openapi', 'v1', 'openapi.yaml'), 'utf8');
  const ops = new Set();
  for (const [idx, body] of spec.split('\n  /').entries()) {
    const p = idx === 0 ? null : '/' + body.split(':\n')[0];
    if (!p) continue;
    for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
      if (new RegExp(`^    ${m}:$`, 'm').test(body)) ops.add(`${m} ${p}`);
    }
  }
  return ops;
}

test('b9: playground inventory — matches the frozen OpenAPI list exactly', () => {
  const frozen = frozenSpecOperations();
  const mine = new Set(PLAYGROUND_OPERATIONS.map((o) => operationKey(o.method, o.path)));
  assert.ok(frozen.size > 0, 'frozen spec parsed');
  assert.equal(mine.size, PLAYGROUND_OPERATIONS.length, 'no duplicate operations in the module');
  assert.deepEqual([...mine].sort(), [...frozen].sort(), 'set equality both ways with the frozen inventory');
  for (const op of PLAYGROUND_OPERATIONS) {
    assert.ok(tagOf(op.path).length > 1, `derived tag for ${op.path}`);
    assert.ok(typeof op.summary === 'string' && op.summary.length > 0, `summary carried for ${op.path}`);
  }
});

test('b9: request building — mutation/executability derivations and lookups', () => {
  assert.equal(isMutationMethod('get'), false);
  for (const m of ['post', 'put', 'patch', 'delete']) assert.equal(isMutationMethod(m), true);

  // exact inventory lookup (method case-insensitive, path verbatim)
  assert.ok(findOperation('get', '/twins'));
  assert.ok(findOperation('POST', '/twins/{id}/compile'));
  assert.equal(findOperation('get', '/twins/{id}/compile'), null, 'wrong method for that path');
  assert.equal(findOperation('post', '/not/inventory'), null);

  // the two multipart upload ops are honestly non-executable from the JSON playground
  for (const key of ['post /captures/{id}/assets', 'post /captures/{id}/f1/steps/{stepId}/submit']) {
    const [m, ...rest] = key.split(' ');
    const op = findOperation(m, rest.join(' '));
    const exec = operationExecutable(op);
    assert.equal(exec.executable, false, `${key} not executable`);
    assert.match(exec.reason, /multipart/);
  }
  assert.equal(operationExecutable(findOperation('get', '/overview')).executable, true);

  // query hints reference real frozen operations only
  for (const key of Object.keys(QUERY_HINTS)) {
    const [m, ...rest] = key.split(' ');
    assert.ok(findOperation(m, rest.join(' ')), `query hint for unknown op ${key}`);
  }
});

test('b9: resolveSpecPath — substitution rules and smuggling rejection', () => {
  // happy substitution
  let r = resolveSpecPath('/twins/{id}/compile', { id: 'twin_abc' });
  assert.equal(r.ok, true);
  assert.equal(r.path, '/twins/twin_abc/compile');

  // required params
  r = resolveSpecPath('/twins/{id}', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /"id" is required/);
  r = resolveSpecPath('/twins/{id}', { id: '   ' });
  assert.equal(r.ok, false);

  // traversal + segment rules
  r = resolveSpecPath('/twins/{id}', { id: '../api-keys' });
  assert.equal(r.ok, false, 'traversal rejected');
  r = resolveSpecPath('/twins/{id}', { id: 'a/b' });
  assert.equal(r.ok, false, 'slash rejected for a single-segment param');
  r = resolveSpecPath('/twins/{id}', { id: 'twin?a=1' });
  assert.equal(r.ok, false, 'query smuggling rejected');
  r = resolveSpecPath('/twins/{id}', { id: 'twin#x' });
  assert.equal(r.ok, false, 'fragment smuggling rejected');

  // the ONE documented catch-all: /storage/{key} may carry slashes, not traversal
  r = resolveSpecPath('/storage/{key}', { key: 'a/b/c.png' });
  assert.equal(r.ok, true);
  assert.equal(r.path, '/storage/a/b/c.png');
  r = resolveSpecPath('/storage/{key}', { key: 'a/../c.png' });
  assert.equal(r.ok, false);

  // whitespace trims; URL-encoding applies to unsafe chars in single segments
  r = resolveSpecPath('/twins/{id}', { id: ' twin_abc ' });
  assert.equal(r.ok, true);
  assert.equal(r.path, '/twins/twin_abc');
});

// ═════════════════════════════════════════════════════════════════════════
// PART B — PURE: sandbox resolution (fail-closed) + the fixtures seam
// ═════════════════════════════════════════════════════════════════════════

test('b9: sandbox resolution — fail-closed default off, honest unavailable, seam wiring', () => {
  // unset / empty → not configured, live
  for (const raw of [undefined, '', '   ']) {
    const s = resolveSandboxMode({ raw }, false);
    assert.equal(s.configured, false);
    assert.equal(s.requested, false);
    assert.equal(s.available, false);
    assert.equal(s.mode, 'live');
    assert.match(s.reason, /not configured/);
  }

  // explicit off
  const off = resolveSandboxMode({ raw: '0' }, false);
  assert.equal(off.configured, true);
  assert.equal(off.requested, false);
  assert.equal(off.mode, 'live');

  // requested but NO fixtures seam → honest unavailable, still live
  const noSeam = resolveSandboxMode({ raw: '1' }, false);
  assert.equal(noSeam.configured, true);
  assert.equal(noSeam.requested, true);
  assert.equal(noSeam.available, false);
  assert.equal(noSeam.mode, 'live');
  assert.match(noSeam.reason, /no deterministic fixtures seam/i);

  // requested WITH the seam → sandbox active
  const withSeam = resolveSandboxMode({ raw: ' 1 ' }, true);
  assert.equal(withSeam.requested, true);
  assert.equal(withSeam.available, true);
  assert.equal(withSeam.mode, 'sandbox');

  // garbage fails closed to live; the reason never echoes the raw value
  const garbage = resolveSandboxMode({ raw: 'SECRET-VALUE-LEAK-TEST' }, true);
  assert.equal(garbage.configured, true);
  assert.equal(garbage.requested, false);
  assert.equal(garbage.available, false);
  assert.equal(garbage.mode, 'live');
  assert.match(garbage.reason, /"0" or "1"/);
  assert.ok(!garbage.reason.includes('SECRET-VALUE-LEAK-TEST'), 'raw env value never echoed');

  // the seam registration point is real: registering flips presence, unregistering restores
  assert.equal(playgroundFixturesPresent(), false, 'nothing registers fixtures on this base');
  registerPlaygroundFixtures(() => new Response('{}', { status: 200 }));
  try {
    assert.equal(playgroundFixturesPresent(), true);
    const flipped = resolveSandboxMode({ raw: '1' }, playgroundFixturesPresent());
    assert.equal(flipped.available, true);
    assert.equal(flipped.mode, 'sandbox');
  } finally {
    registerPlaygroundFixtures(null); // restore the honest not-present state
  }
  assert.equal(playgroundFixturesPresent(), false);
  assert.equal(PLAYGROUND_SANDBOX_ENV_VAR, 'YOU_PLAYGROUND_SANDBOX');
});

// ═════════════════════════════════════════════════════════════════════════
// PART C — PURE: official examples (frozen routes, real SDK methods, mirror)
// ═════════════════════════════════════════════════════════════════════════

// The SDK is NOT node-importable (client.ts uses constructor parameter
// properties — non-erasable TS, the exact reason api.ts documents itself
// the same way). The structural check therefore reads the REAL client
// source and extracts its surface tokens; the TYPE-level proof that the
// mirrored calls compile against the SDK's types is the apps/web tsc gate
// over examples-compile.ts (enforced by the mirror assertion below).
const SDK_CLIENT_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'sdk-js', 'src', 'client.ts'), 'utf8');

/** Extract group.method tokens from the real SDK client source. */
function sdkSurfaceTokens(source) {
  const tokens = new Set();
  for (const gm of source.matchAll(/readonly\s+([a-zA-Z]+)\s*=\s*\{/g)) {
    const group = gm[1];
    const start = gm.index + gm[0].length;
    let depth = 1;
    let i = start;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    const body = source.slice(start, i - 1);
    for (const m of body.matchAll(/(?:^|\n)\s{4}([a-zA-Z]+)\s*[:(]/g)) {
      tokens.add(`${group}.${m[1]}`);
    }
  }
  return tokens;
}

const CALL_TOKEN = /client\.([a-zA-Z]+)\.([a-zA-Z]+)\s*\(/g;
function callTokens(text) {
  const tokens = new Set();
  for (const m of text.matchAll(CALL_TOKEN)) tokens.add(`${m[1]}.${m[2]}`);
  return tokens;
}

test('b9: examples — only frozen routes, real SDK methods, compile-mirror holds', () => {
  const frozen = frozenSpecOperations();
  const sdkTokens = sdkSurfaceTokens(SDK_CLIENT_SOURCE);
  assert.ok(sdkTokens.has('session.get') && sdkTokens.has('artifacts.requestEvidence'), 'the real SDK surface was extracted');
  const compileSource = fs.readFileSync(
    path.join(APP_DIR, 'src', 'lib', 'you', 'develop', 'examples-compile.ts'),
    'utf8',
  );
  const compiledTokens = callTokens(compileSource);
  assert.ok(compiledTokens.size >= 10, 'the compile mirror carries the SDK surface');

  assert.ok(EXAMPLE_FLOWS.length >= 7, 'the canonical flows are present');
  for (const flow of EXAMPLE_FLOWS) {
    assert.ok(flow.operations.length >= 1, `${flow.id} references operations`);
    for (const ref of flow.operations) {
      const [method, ...rest] = ref.split(' ');
      assert.ok(
        frozen.has(`${method.toLowerCase()} ${rest.join(' ')}`),
        `${flow.id}: operation "${ref}" is in the frozen inventory`,
      );
    }
    assert.ok(flow.code.includes('client.'), `${flow.id} carries SDK calls`);
    for (const token of callTokens(flow.code)) {
      assert.ok(
        sdkTokens.has(token),
        `${flow.id}: client.${token}() exists on the REAL @you/sdk-js client source`,
      );
      assert.ok(
        compiledTokens.has(token),
        `${flow.id}: client.${token}() appears in examples-compile.ts (the tsc-gated mirror)`,
      );
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════
// PART D — PURE: onboarding state persistence + no fake steps
// ═════════════════════════════════════════════════════════════════════════

function fakeStorage(initial = new Map()) {
  const store = initial;
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, v); },
    _store: store,
  };
}

test('b9: onboarding — persisted per user, dismissible, honest resets', () => {
  const storage = fakeStorage();
  const userA = 'usr_a';
  const userB = 'usr_b';

  // first run → the tour shows
  assert.equal(readTourState(storage, userA), 'unseen');
  assert.equal(shouldShowTour('unseen'), true);

  // active (mid-tour reload) still shows; dismissed and completed never do
  writeTourState(storage, userA, 'active');
  assert.equal(shouldShowTour(readTourState(storage, userA)), true);
  dismissTour(storage, userA);
  assert.equal(readTourState(storage, userA), 'dismissed');
  assert.equal(shouldShowTour(readTourState(storage, userA)), false);
  resetTour(storage, userA);
  assert.equal(shouldShowTour(readTourState(storage, userA)), true, 'reset re-arms the walkthrough');
  completeTour(storage, userA);
  assert.equal(shouldShowTour(readTourState(storage, userA)), false);

  // per-user isolation: B is independent of A's state
  assert.equal(readTourState(storage, userB), 'unseen');
  assert.equal(tourStorageKey(userA) !== tourStorageKey(userB), true);

  // corrupt payload → honest fresh start, never a crash
  storage._store.set(tourStorageKey('usr_corrupt'), '{not json');
  assert.equal(readTourState(storage, 'usr_corrupt'), 'unseen');
  storage._store.set(tourStorageKey('usr_wrongshape'), JSON.stringify({ nope: 1 }));
  assert.equal(readTourState(storage, 'usr_wrongshape'), 'unseen');

  // unavailable storage → first-run behavior (the tour is cosmetic)
  const broken = {
    getItem: () => { throw new Error('storage disabled'); },
    setItem: () => { throw new Error('storage disabled'); },
  };
  assert.equal(readTourState(broken, userA), 'unseen');
  assert.doesNotThrow(() => writeTourState(broken, userA, 'dismissed'));
});

test('b9: onboarding — no fake steps: every stop links to a real view', () => {
  assert.equal(TOUR_STOPS.length, 7, 'the primary flow: Build → capture → review → compile → render → artifact → Develop');
  assert.doesNotThrow(() => assertTourDefinitionValid(TOUR_STOPS, [...VIEW_IDS]));
  // invalid definitions are caught (the law is enforced, not decorative)
  assert.throws(() => assertTourDefinitionValid([{ id: 'x', viewId: 'not-a-view', title: 't', body: 'b', ctaLabel: 'c' }], [...VIEW_IDS]));
  assert.throws(() => assertTourDefinitionValid([], [...VIEW_IDS]));
  // the canonical order's view set
  const views = TOUR_STOPS.map((s) => s.viewId);
  assert.ok(views.includes('twins') && views.includes('captures') && views.includes('renders')
    && views.includes('artifact') && views.includes('develop'), 'the real primary-flow views are linked');
});

// ═════════════════════════════════════════════════════════════════════════
// PART E — API level: the playground surface over the booted app
// ═════════════════════════════════════════════════════════════════════════

async function call(pathname, { method = 'GET', body, headers = {}, cookieOverride } = {}) {
  const h = { ...headers };
  if (cookieOverride) h.cookie = cookieOverride;
  else if (cookie) h.cookie = cookie;
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
          console.log(`[b9-tests] reusing suite server at ${base}`);
          return base;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(!aggregated, 'aggregated run: the sibling suite never published its server URL within 150s');
      console.log('[b9-tests] booting apps/web (next dev) on a free port…');
      await startServer();
      ownServer = true;
      console.log(`[b9-tests] server ready at ${base}`);
      return base;
    })().catch((err) => {
      basePromise = null;
      throw err;
    });
  }
  return basePromise;
}

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

async function execute(payload, { cookieOverride } = {}) {
  return call('/api/v1/develop/playground/execute', { method: 'POST', body: payload, cookieOverride });
}

after(async () => {
  if (prismaClient) await prismaClient.$disconnect().catch(() => undefined);
  if (ownServer) {
    await killTree();
    if (child && child.pid) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    console.log('[b9-tests] own server stopped');
  }
});

test('b9: status surface — auth required, honest sandbox, inventory count', async () => {
  await ensureBase();
  await call('/api/v1/session', { method: 'POST', body: {} });

  // no session → honest 401 (never an open surface)
  const raw = await fetch(`${base}/api/v1/develop/playground`);
  assert.equal(raw.status, 401, `unauthenticated status → ${raw.status}`);

  const r = await call('/api/v1/develop/playground');
  assert.equal(r.status, 200, `status → ${r.status}`);
  assert.equal(r.json.envVar, 'YOU_PLAYGROUND_SANDBOX');
  assert.equal(typeof r.json.inventoryCount, 'number');
  assert.equal(r.json.inventoryCount, PLAYGROUND_OPERATIONS.length, 'server inventory count matches the client module');
  const sandbox = r.json.sandbox;
  assert.equal(sandbox.mode, 'live');
  assert.equal(sandbox.available, false);
  assert.ok(typeof sandbox.reason === 'string' && sandbox.reason.length > 0, 'the honest reason is carried');
});

test('b9: execute — read-only operations run live against the real API', async () => {
  await ensureBase();

  // a real twin for the path-parameter case
  const t = await call('/api/v1/twins', { method: 'POST', body: { displayName: `B9 playground ${stamp}` } });
  assert.equal(t.status, 201, `twin create → ${t.status}`);
  twinA = t.json;

  let r = await execute({ method: 'get', path: '/overview', pathParams: {}, query: {} });
  assert.equal(r.status, 200, `execute overview → ${r.status}`);
  assert.equal(r.json.operation.method, 'GET');
  assert.equal(r.json.operation.path, '/overview');
  assert.equal(r.json.sandbox, false, 'live execution, honestly labeled');
  assert.equal(r.json.status, 200, 'the inner real API answered 200');
  assert.ok(typeof r.json.durationMs === 'number' && r.json.durationMs >= 0, 'timing carried');
  const headerNames = r.json.headers.map((h) => h.name.toLowerCase());
  assert.ok(headerNames.includes('content-type'), 'inner content-type present');
  assert.ok(headerNames.includes('x-request-id'), 'inner request id present (A7 correlation)');
  const overview = JSON.parse(r.json.body);
  assert.ok(typeof overview.twins === 'number', 'the body is the REAL overview payload');

  // path-parameter substitution against the real route
  r = await execute({ method: 'get', path: '/twins/{id}', pathParams: { id: twinA.id }, query: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 200, 'inner twin detail 200');
  assert.equal(r.json.resolvedPath, `/twins/${twinA.id}`);
  assert.equal(JSON.parse(r.json.body).id, twinA.id, 'the real twin came back through the proxy');

  // query parameters ride along (typed filter validation is the route's own)
  r = await execute({ method: 'get', path: '/evidence-requests', pathParams: {}, query: { status: 'open', capability: 'face.profile' } });
  assert.equal(r.json.status, 200);
  assert.ok(Array.isArray(JSON.parse(r.json.body)), 'filtered list rendered');
});

test('b9: execute — mutation confirmation enforced at the API level, no accidental writes', async () => {
  await ensureBase();

  const before = await call('/api/v1/twins');
  const countBefore = before.json.length;

  // a mutation WITHOUT acknowledgement → typed 400, and NOTHING happened
  let r = await execute({
    method: 'post', path: '/twins', pathParams: {}, query: {},
    body: JSON.stringify({ displayName: `B9 must-not-exist ${stamp}` }),
    mutationAcknowledged: false,
  });
  assert.equal(r.status, 400, `unconfirmed mutation → ${r.status}`);
  assert.equal(r.json.error.code, 'validation_failed');
  assert.equal(r.json.error.details.reason, 'mutation_confirmation_required');
  assert.equal(r.json.error.details.path, '/twins');

  const after = await call('/api/v1/twins');
  assert.equal(after.json.length, countBefore, 'no side effect — the unconfirmed call never executed');

  // WITH acknowledgement → executes for real (create → delete lifecycle)
  r = await execute({
    method: 'post', path: '/twins', pathParams: {}, query: {},
    body: JSON.stringify({ displayName: `B9 confirmed ${stamp}` }),
    mutationAcknowledged: true,
  });
  assert.equal(r.status, 200, 'the execute envelope itself is 200');
  assert.equal(r.json.status, 201, 'the inner create answered 201');
  const created = JSON.parse(r.json.body);
  assert.ok(created.id && created.id !== twinA.id, 'the real created twin renders');

  const list = await call('/api/v1/twins');
  assert.ok(list.json.some((x) => x.id === created.id), 'the mutation really happened (honest execution)');

  r = await execute({ method: 'delete', path: '/twins/{id}', pathParams: { id: created.id }, query: {}, mutationAcknowledged: true });
  assert.equal(r.json.status, 204, 'inner delete 204');
  assert.equal(r.json.body, '', '204 carries an empty body, honestly');

  const listAfter = await call('/api/v1/twins');
  assert.ok(!listAfter.json.some((x) => x.id === created.id), 'cleanup verified gone');

  // the deletion gate applies to DELETE just the same
  r = await execute({ method: 'delete', path: '/twins/{id}', pathParams: { id: twinA.id }, query: {} });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.details.reason, 'mutation_confirmation_required');
});

test('b9: execute — honest refusals (unknown op, multipart, bad JSON, sandbox)', async () => {
  await ensureBase();

  // unknown operation (not in the frozen inventory)
  let r = await execute({ method: 'get', path: '/not-a-frozen-operation', pathParams: {}, query: {} });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /unknown operation/);

  // multipart upload ops are refused with their reason
  r = await execute({ method: 'post', path: '/captures/{id}/assets', pathParams: { id: 'cap_x' }, query: {}, mutationAcknowledged: true });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /multipart/);

  // invalid JSON body is refused BEFORE executing
  r = await execute({ method: 'post', path: '/twins', pathParams: {}, query: {}, body: '{oops', mutationAcknowledged: true });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /not valid JSON/);

  // a body on a GET is refused (the method takes no body)
  r = await execute({ method: 'get', path: '/overview', pathParams: {}, query: {}, body: '{"x":1}' });
  assert.equal(r.status, 400);

  // a missing required path parameter
  r = await execute({ method: 'get', path: '/twins/{id}', pathParams: {}, query: {} });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /"id" is required/);

  // a requested sandbox is honestly unavailable on this deployment
  r = await execute({ method: 'get', path: '/overview', pathParams: {}, query: {}, sandbox: true });
  assert.equal(r.status, 409, `sandbox request → ${r.status}`);
  assert.equal(r.json.error.code, 'conflict');
  assert.equal(r.json.error.details.reason, 'sandbox_unavailable');
  assert.equal(r.json.error.details.sandbox.mode, 'live');
});

test('b9: execute — set-cookie never renders in the response viewer', async () => {
  await ensureBase();

  // POST /session sets a cookie on the inner response — the envelope must not carry it.
  // (The route answers 200 in practice — the frozen spec declares 201; the
  // playground renders what the real API returns, and this is that truth.)
  const r = await execute({ method: 'post', path: '/session', pathParams: {}, query: {}, mutationAcknowledged: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 200, 'the inner session bootstrap answered 200 (real behavior)');
  const body = JSON.parse(r.json.body);
  assert.ok(body.user && body.tenant, 'the real session payload renders');
  for (const h of r.json.headers) {
    assert.notEqual(h.name.toLowerCase(), 'set-cookie', 'session tokens never reach the viewer');
  }
});

test('b9: tenant isolation — the proxy forwards only the caller\'s auth', async () => {
  await ensureBase();
  const pr = await prisma();

  // seed a second tenant + user + session directly (the B3/B5/B7 precedent)
  const tenantB = await pr.tenant.create({
    data: { slug: `b9-iso-${stamp}`, name: `B9 Isolation ${stamp}` },
  });
  const userB = await pr.user.create({
    data: { tenantId: tenantB.id, email: `b9-${stamp}@example.test`, name: 'B9 Isolation User' },
  });
  const sessionB = await pr.session.create({
    data: {
      userId: userB.id,
      token: `b9-tok-${stamp}-${randomBytes(8).toString('hex')}`,
      expiresAt: new Date(Date.now() + 3600 * 1000),
    },
  });
  const bCookie = `you_session=${sessionB.token}`;

  // the execute route itself requires auth
  const raw = await fetch(`${base}/api/v1/develop/playground/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'get', path: '/overview', pathParams: {}, query: {} }),
  });
  assert.equal(raw.status, 401, `unauthenticated execute → ${raw.status}`);

  // tenant B's list carries none of tenant A's twins
  let r = await execute({ method: 'get', path: '/twins', pathParams: {}, query: {} }, { cookieOverride: bCookie });
  assert.equal(r.json.status, 200);
  const bTwins = JSON.parse(r.json.body);
  assert.ok(Array.isArray(bTwins));
  assert.ok(!bTwins.some((x) => x.id === twinA.id), 'tenant B sees none of tenant A twins through the playground');

  // cross-tenant detail → the honest inner 404 (no existence leak)
  r = await execute({ method: 'get', path: '/twins/{id}', pathParams: { id: twinA.id }, query: {} }, { cookieOverride: bCookie });
  assert.equal(r.json.status, 404, 'cross-tenant detail read → inner 404');

  // the mutation-confirmation gate is tenant-independent
  r = await execute({ method: 'post', path: '/twins', pathParams: {}, query: {}, body: JSON.stringify({ displayName: 'x' }) }, { cookieOverride: bCookie });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.details.reason, 'mutation_confirmation_required');

  // tenant A's twin is untouched by all of tenant B's attempts
  const stillThere = await call(`/api/v1/twins/${twinA.id}`);
  assert.equal(stillThere.status, 200, 'tenant A data untouched by cross-tenant playground attempts');
});
