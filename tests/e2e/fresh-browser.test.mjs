// ═══════════════════════════════════════════════════════════════════════════
// YOU fresh-browser E2E suite (P6.B10) — node:test + the zero-dependency CDP
// driver in ./browser.mjs against a REAL Chromium binary.
//
// THE ACCEPTANCE LEG (docs/TL_HANDOFF.md): prove the HOSTED PRODUCT works in
// a pristine browser context — not just over HTTP like the contract suites.
// Every flow below starts from a BRAND-NEW browser process with a brand-new
// profile (no cookie/localStorage carry-over); the document-start snapshot
// taken by the driver proves the context was empty before app code ran.
//
// FLOWS (asserted in the DOM — real visible state, no fake assertions):
//   (a) bootstrap session → the app loads AUTHENTICATED in a fresh browser
//       (sidebar identity + tenant + Overview landing surface);
//   (b) create twin → the consent gate STATES are visible and honest
//       (gate dialog → blocked callout after refusing → unblocked after
//       granting → the six-statement F1 gate on the guided flow → the
//       guided 8-step capture protocol visible);
//   (c) the evidence request list renders a REAL seeded request;
//   (d) the deficiency map renders on the twin with its HONEST empty state
//       (no capture evidence → "every capability is unknown", never green);
//   (e) the Solution Artifact view renders with its section surface
//       (a real performance-review artifact created through the durable-job
//       pipeline, opened through the UI, tabs asserted);
//   (f) navigation across ALL primary views works (sidebar items, active
//       state, non-blank content) with the window.onerror/console-error
//       capture asserted EMPTY at the end of every flow.
//
// HONEST SKIP GUARD: when no Chromium-family binary is discoverable the
// suite skips LOUDLY with the documented reason (never a silent pass).
//
// Server lifecycle: boots its own `next dev` on a free port (the same law
// as the contract suites) or reuses $YOU_TEST_BASE. Prerequisites = the
// documented app boot: cd apps/web && bun install && cp .env.example .env
// && bun run db:push. The suite fails LOUDLY with that hint when missing.
//
// Deliberately NOT covered (docs/E2E.md §Scope): real provider renders
// (image/video generation, avatar embodiment, hosted try-on) — those legs
// are covered by the contract suites over HTTP; the browser suite proves
// the hosted product surfaces, not provider spend.
// ═══════════════════════════════════════════════════════════════════════════
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowserBinary, killAllStrayBrowsers, openFreshContext } from './browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const APP_DIR = path.join(REPO_ROOT, 'apps', 'web');

const BROWSER = findBrowserBinary();
const SKIP_REASON = BROWSER
  ? null
  : 'no Chromium-family binary found (searched $YOU_E2E_BROWSER, the Playwright browsers cache, system paths) — honest skip per docs/E2E.md §Skip guard; install one and re-run';

const stamp = `${Date.now()}-${process.pid}`;

// ─── tiny HTTP client with session-cookie memory (seeding side) ────────────
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
  return { status: res.status, json, text };
}

async function pollJob(jobId, timeoutMs = 240000) {
  const t0 = Date.now();
  for (;;) {
    const r = await call(`/api/v1/jobs/${jobId}`);
    assert.equal(r.status, 200, `job poll GET /api/v1/jobs/${jobId} → ${r.status}`);
    const j = r.json;
    if (['succeeded', 'failed', 'dead'].includes(j.status)) return j;
    if (Date.now() - t0 > timeoutMs) {
      assert.fail(`job ${jobId} (${j.kind}) did not reach a terminal state within ${timeoutMs}ms (last: ${j.status})`);
    }
    await new Promise((r2) => setTimeout(r2, 1200));
  }
}

// ─── server lifecycle (the contract-suite law) ──────────────────────────────
let child = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; srv.close(() => resolve(port)); });
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
    detached: true, // own process group → killTree() can take the whole tree down
  });
  child.stdout.on('data', () => { /* dev chatter — intentionally ignored */ });
  child.stderr.on('data', () => { /* dev chatter — intentionally ignored */ });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120000;
  for (;;) {
    if (child.exitCode !== null) assert.fail(`next dev exited with code ${child.exitCode} before becoming ready`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) { base = url; return; }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) assert.fail(`next dev did not become ready on ${url} within 120s`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

before(async () => {
  if (!BROWSER) {
    // honest skip guard: no browser anywhere → no point booting the app;
    // every flow test reports the loud skip below
    console.log(`[b10-e2e] SKIPPING — ${SKIP_REASON}`);
    return;
  }
  if (base) {
    console.log(`[b10-e2e] reusing booted server at ${base} (YOU_TEST_BASE)`);
    return;
  }
  console.log('[b10-e2e] booting apps/web (next dev) on a free port…');
  await startServer();
  console.log(`[b10-e2e] server ready at ${base}`);
  console.log(`[b10-e2e] browser binary: ${BROWSER.path} (${BROWSER.source})`);
});

after(async () => {
  // the teardown sweep: any browser tree that survived a failed flow is
  // SIGKILLed here (orphaned renderers starve the station — observed live)
  killAllStrayBrowsers();
  await killTree();
  if (child && child.pid) {
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  console.log('[b10-e2e] server stopped');
});

// ─── shared flow helpers ────────────────────────────────────────────────────

// BROWSER-ORIGIN LAW: Next 16's dev server blocks /_next/hmr (and the dev
// resource surface) from origins it treats as cross-origin — "127.0.0.1"
// is one of them ("Blocked cross-origin request to Next.js dev resource
// /_next/hmr from 127.0.0.1", observed live). Without the HMR WebSocket
// the dev-mode client never completes hydration: the page renders its SSR
// shell, zero client fetches fire, zero console errors — a fully inert DOM.
// Navigating the browser via `localhost` (same server, same port) is
// same-origin for the dev server and hydration completes normally. The
// HTTP seeding client keeps the station-provided base verbatim.
function browserBase() {
  assert.ok(base, 'the app server is not booted (before() hook must run first)');
  return base.includes('127.0.0.1') ? base.replace('127.0.0.1', 'localhost') : base;
}

/** Open a FRESH browser (new process + new profile) and load the app shell. */
async function freshAppReady() {
  assert.ok(BROWSER, SKIP_REASON);
  const { browser, page } = await openFreshContext(BROWSER.path);
  try {
    await page.goto(browserBase());
    // the authenticated shell lands once the session bootstrap resolves
    await page.waitFor('authenticated shell', `(() => { const t = document.body ? document.body.innerText : ''; return t.includes('Studio Founder') && t.includes('YOU Demo Studio'); })()`, 120000);
  } catch (err) {
    // NEVER leak the browser tree when the shell never becomes ready —
    // orphaned renderers starve the station and cascade into later flows
    await browser.close().catch(() => undefined);
    throw err;
  }
  return { browser, page };
}

/** Assert the fresh-context snapshot: empty cookie + empty localStorage at document start. */
function assertFreshContext(snapshot, label) {
  assert.ok(snapshot, `${label}: the document-start fresh-context snapshot is missing`);
  assert.equal(snapshot.cookie, '', `${label}: the fresh context must start with NO cookies (got ${JSON.stringify(snapshot.cookie)})`);
  assert.equal(snapshot.storageKeys, 0, `${label}: the fresh context must start with EMPTY localStorage (got ${snapshot.storageKeys} keys)`);
}

// every flow runs a full assert-no-page-errors at the end; this wrapper
// keeps the browser lifecycle uniform (fresh context per flow, always closed)
async function runFlow(name, fn) {
  const { browser, page } = await freshAppReady();
  const t0 = Date.now();
  try {
    await fn(page);
    await page.assertNoPageErrors(`${name} (flow complete)`);
    console.log(`[b10-e2e] flow ok: ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } finally {
    await browser.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// (a) bootstrap session → the app loads authenticated in a pristine browser
// ═══════════════════════════════════════════════════════════════════════════
test('fresh browser (a): bootstrap session — the hosted product loads authenticated', { timeout: 240000 }, async (t) => {
  if (!BROWSER) return t.skip(SKIP_REASON);
  await runFlow('(a) bootstrap', async (page) => {
    // fresh-context proof: document-start snapshot taken BEFORE any app JS
    assertFreshContext(await page.freshSnapshot(), '(a)');

    // the authenticated identity renders (sidebar footer: demo user + tenant)
    const body = await page.text();
    assert.match(body, /Studio Founder/, 'the demo session user must be visible');
    assert.match(body, /YOU Demo Studio/, 'the demo tenant must be visible');

    // the Overview landing surface is real backend state, not a blank shell
    // (stat tiles + pipeline + event ledger render on every loaded overview;
    // the Get-started card is cold-workspace-only — honest, not assumed)
    await page.waitFor('overview landing', `(() => { const t = document.body.innerText; return t.includes('Pipeline') && t.includes('Recent activity') && t.includes('Active grants'); })()`);
    assert.match(await page.text(), /Overview/, 'the Overview view must be the landing view');

    // the session bootstrap actually issued the cookie in THIS fresh context.
    // The cookie is httpOnly (by design — scripts cannot read sessions), so
    // the PROOF is behavioral: the in-page request log shows the unauthenticated
    // wall first, the bootstrap POST, and then authenticated requests riding
    // the cookie (GET /overview 401 → POST /session 200 → GET /overview 200).
    const cookie = await page.evaluate('document.cookie');
    assert.equal(cookie, '', 'the httpOnly session cookie must NOT be readable from scripts');
    const net = await page.netLog();
    const sessionPost = net.find((e) => e.method === 'POST' && /\/api\/v1\/session$/.test(e.url));
    assert.ok(sessionPost, `the fresh browser must have POSTed /api/v1/session (net log: ${JSON.stringify(net.slice(0, 8))})`);
    assert.equal(sessionPost.status, 200, `the session bootstrap POST must succeed (got ${sessionPost.status})`);
    const postIdx = net.indexOf(sessionPost);
    const authedOverview = net.slice(postIdx + 1).find((e) => e.method === 'GET' && /\/api\/v1\/overview$/.test(e.url) && e.status === 200);
    assert.ok(
      authedOverview,
      'an authenticated GET /overview must follow the bootstrap POST (the httpOnly cookie rides along)',
    );
    const unauthOverview = net.slice(0, postIdx).find((e) => e.method === 'GET' && /\/api\/v1\/overview$/.test(e.url) && e.status === 401);
    assert.ok(unauthOverview, 'the same endpoint must have answered 401 BEFORE the bootstrap (the auth wall is real)');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (b) create twin → capture session — guided flow visible with consent-gate
//     states (every state is a REAL server-enforced transition)
// ═══════════════════════════════════════════════════════════════════════════
test('fresh browser (b): create twin → consent gate states → guided F1 capture visible', { timeout: 300000 }, async (t) => {
  if (!BROWSER) return t.skip(SKIP_REASON);
  const twinName = `E2E Twin ${stamp}`;
  await runFlow('(b) twin + consent gates', async (page) => {
    assertFreshContext(await page.freshSnapshot(), '(b)');

    // ── Twins view → create dialog ─────────────────────────────────────────
    await page.click({ text: 'Twins', scope: 'aside nav' });
    await page.waitFor('twins view', `(() => { const t = document.body.innerText; return t.includes('Persistent human objects'); })()`);
    await page.click({ text: 'Create Twin', scope: 'main' });
    await page.waitFor('create dialog open', `(() => { const d = document.querySelector('[role=\\"dialog\\"]'); return !!d && d.innerText.includes('Create twin') && d.innerText.includes('grant scoped consent next'); })()`);

    // ── create the twin (real POST through the app's own client) ───────────
    await page.fill('#twin-display-name', twinName);
    await page.fill('#twin-person-name', 'E2E Consent Tester');
    await page.click({ text: 'Create twin', scope: '[role="dialog"]' });

    // ── CONSENT GATE STATE 1: the gate dialog opens immediately ────────────
    await page.waitFor('consent gate dialog', `(() => { const d = document.querySelector('[role=\\"dialog\\"]'); return !!d && d.innerText.includes('Grant consent') && d.innerText.includes('blocked until an active, scoped consent grant'); })()`);

    // ── refuse: the gate stays honest (capture blocked, twin exists) ───────
    await page.click({ text: 'Cancel', scope: '[role="dialog"]' });
    // ── CONSENT GATE STATE 2: the blocked callout on the Capture tab ───────
    await page.waitFor('blocked consent callout', `(() => { const t = document.body.innerText; return t.includes('Capture is consent-gated.') && t.includes('An active grant with the capture scope is required'); })()`);

    // grant through the callout's gate
    await page.click({ text: 'Grant consent', scope: 'main' });
    await page.waitFor('gate dialog reopened', `(() => { const d = document.querySelector('[role=\\"dialog\\"]'); return !!d && d.innerText.includes('Grant consent') && d.innerText.includes('Capture, reconstruction and rendering are blocked'); })()`);

    // ── CONSENT GATE STATE 3: granting unblocks the capture surface ────────
    await page.click({ text: 'Grant consent', scope: '[role="dialog"]' });
    await page.waitFor('consent callout gone', `(() => { return !document.body.innerText.includes('Capture is consent-gated.'); })()`, 60000);
    await page.waitFor('capture toolbar live', `(() => { const t = document.body.innerText; return t.includes('Guided F1 capture') && t.includes('Start capture session') && t.includes('0 sessions'); })()`);

    // ── the guided F1 flow refuses the PLAIN grant: the six-statement gate ─
    await page.click({ text: 'Guided F1 capture', scope: 'main' });
    // ── CONSENT GATE STATE 4: the F1 statements gate (server 403 surfaced) ─
    await page.waitFor('F1 six-statement gate', `(() => { const d = document.querySelector('[role=\\"dialog\\"]'); return !!d && d.innerText.includes('F1 capture consent') && d.innerText.includes('missing/invalid:'); })()`, 60000);

    // ── record the six-statement consent → the guided flow auto-retries ────
    await page.fill('#f1-what', 'Photos and short clips of the consenting internal tester following the guided 8-step protocol — raw evidence stays in the immutable evidence store.');
    await page.fill('#f1-why', 'To build and improve the subject digital twin for the product tests listed below.');
    await page.fill('#f1-tests', 'E2E fresh-browser guided-flow visibility run');
    await page.fill('#f1-deletion', 'The subject may withdraw at any time by revoking this consent grant; capture evidence is then deleted.');
    await page.click({ text: 'Record F1 consent', scope: '[role="dialog"]' });

    // ── CONSENT GATE STATE 5: the guided 8-step protocol is VISIBLE ────────
    // (NOTE: innerText applies CSS text-transform — the protocol heading
    // renders as "PROTOCOL — …" — matching is case-insensitive on purpose)
    await page.waitFor('guided F1 flow visible', `(() => { const t = document.body.innerText; return t.includes('Guided F1 capture') && /0\\/8 steps done/.test(t) && /protocol —/i.test(t); })()`, 90000);
    const guidedBody = await page.text();
    assert.match(guidedBody, /0\/8 steps done/, 'the guided protocol progress must show 0 of 8 steps done');
    // the step rows are interactive surfaces, not a static mock
    const progressbar = await page.evaluate('document.querySelector(\'[role="progressbar"][aria-label="Completed protocol steps"]\') ? true : false');
    assert.equal(progressbar, true, 'the protocol progress bar must render (real step state)');

    // the twin we created is visible in this same flow (list + detail states)
    assert.match(guidedBody, new RegExp(twinName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the created twin must be visible');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (c) evidence request list renders a REAL seeded request
// ═══════════════════════════════════════════════════════════════════════════
test('fresh browser (c): the evidence request list renders', { timeout: 240000 }, async (t) => {
  if (!BROWSER) return t.skip(SKIP_REASON);

  // seed a REAL open request through the canonical API (own session cookie)
  const s = await call('/api/v1/session', { method: 'POST', body: {} });
  assert.equal(s.status, 200, `session bootstrap → ${s.status}`);
  const reason = `E2E visible request ${stamp}`;
  const req = await call('/api/v1/evidence-requests', {
    method: 'POST',
    body: {
      reason,
      capability: 'face.profile',
      instructions: 'One additional profile capture, neutral expression, even lighting.',
      expectedSignal: 'sharper jawline profile silhouette',
    },
  });
  assert.equal(req.status, 201, `evidence request create → ${req.status}`);
  assert.equal(req.json.status, 'open');

  await runFlow('(c) evidence requests', async (page) => {
    assertFreshContext(await page.freshSnapshot(), '(c)');
    await page.click({ text: 'Evidence Requests', scope: 'aside nav' });
    await page.waitFor('evidence requests view', `(() => { const t = document.body.innerText; return t.includes('Targeted additional-evidence requests') && t.includes('${reason}'); })()`);
    const body = await page.text();
    assert.match(body, /face\.profile/, 'the seeded capability must render');
    assert.match(body, /open/i, 'the request status must render');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (d) deficiency map renders on the twin — the HONEST empty state
// ═══════════════════════════════════════════════════════════════════════════
test('fresh browser (d): deficiency map — honest empty state on the twin', { timeout: 240000 }, async (t) => {
  if (!BROWSER) return t.skip(SKIP_REASON);

  // seed a REAL twin through the canonical API (no captures — the map must
  // stay honestly empty, never a wall of fabricated green)
  const s = await call('/api/v1/session', { method: 'POST', body: {} });
  assert.equal(s.status, 200);
  const twinName = `E2E Quality ${stamp}`;
  const created = await call('/api/v1/twins', { method: 'POST', body: { displayName: twinName } });
  assert.equal(created.status, 201, `twin create → ${created.status}`);

  await runFlow('(d) deficiency map', async (page) => {
    assertFreshContext(await page.freshSnapshot(), '(d)');
    await page.click({ text: 'Twins', scope: 'aside nav' });
    // open THIS twin's card (aria-label carries the display name)
    await page.waitFor('twin card listed', `(() => { return !!document.querySelector('[aria-label=\\"Open twin ${twinName}\\"]'); })()`);
    await page.click({ ariaLabel: `Open twin ${twinName}` });
    await page.waitFor('twin detail open', `(() => { const t = document.body.innerText; return t.includes('${twinName}') && t.includes('Versions') && t.includes('Quality'); })()`);

    // the Quality tab is the deficiency map surface (P6.B4)
    await page.click({ text: 'Quality', scope: 'main' });
    await page.waitFor('honest empty state', `(() => { const t = document.body.innerText; return t.includes('No capture evidence yet') && t.includes('every capability is unknown'); })()`);
    const body = await page.text();
    // the honest law: NOT a wall of ok rows / fabricated summary
    assert.ok(!body.includes('capability summary'), 'the empty state must NOT render a fabricated capability summary');
    assert.ok(!/\b1 ok\b/.test(body), 'no fabricated "1 ok" badge may render without evidence');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (e) artifact view renders with sections (a REAL performance-review artifact
//     created through the durable-job pipeline, opened through the UI)
// ═══════════════════════════════════════════════════════════════════════════
test('fresh browser (e): Solution Artifact view renders with sections', { timeout: 300000 }, async (t) => {
  if (!BROWSER) return t.skip(SKIP_REASON);

  // seed a REAL artifact: performance.fromText runs the durable-job pipeline
  // (deterministic tracks; optional LLM enhance degrades honestly) and emits
  // a manifest-v2 performance-review Solution Artifact
  const s = await call('/api/v1/session', { method: 'POST', body: {} });
  assert.equal(s.status, 200);
  const perfName = `E2E Monologue ${stamp}`;
  const created = await call('/api/v1/performances/from-text', {
    method: 'POST',
    body: { name: perfName, script: 'Hello there. This is a fresh-browser end-to-end performance. It walks through the artifact surface.' },
  });
  assert.equal(created.status, 202, `from-text → ${created.status}`);
  const job = await pollJob(created.json.jobId);
  assert.equal(job.status, 'succeeded', `performance job failed honestly: ${job.error ?? ''}`);
  assert.ok(job.output.solutionArtifactId, 'the job output must reference the artifact');

  const artifactTitle = `Performance review — ${perfName}`;

  await runFlow('(e) artifact view', async (page) => {
    assertFreshContext(await page.freshSnapshot(), '(e)');
    await page.click({ text: 'Performances', scope: 'aside nav' });
    await page.waitFor('performances view', `(() => { const t = document.body.innerText; return t.includes('identity-independent') && t.includes('${perfName}'); })()`);

    // open the performance row (table row with aria-label)
    await page.click({ ariaLabel: `Open performance ${perfName}` });
    await page.waitFor('performance dialog', `(() => { const d = document.querySelector('[role=\\"dialog\\"]'); return !!d && d.innerText.includes('Solution Artifacts') && d.innerText.includes('${artifactTitle}'); })()`);

    // open the artifact through its real UI affordance
    await page.click({ text: artifactTitle, scope: '[role="dialog"]' });
    await page.waitFor('artifact view open', `(() => { const t = document.body.innerText; return t.includes('Solution Artifact') && t.includes('${artifactTitle}') && t.includes('never the source of truth'); })()`, 90000);

    // the P5 section surface renders: the completeness card over ALL sections
    await page.waitFor('section completeness card', `(() => { const t = document.body.innerText; return t.includes('Section completeness') && t.includes('P5 sections filled'); })()`);

    // the artifact tabs are real navigable surfaces — walk them and assert
    // each renders its honest content (filled or explicitly-empty)
    await page.click({ text: 'Evidence', scope: 'main' });
    await page.waitFor('evidence tab honest empty', `(() => { return document.body.innerText.includes('No evidence referenced'); })()`);
    await page.click({ text: 'Improve', scope: 'main' });
    await page.waitFor('improve tab', `(() => { return document.body.innerText.includes('The improve loop:'); })()`);
    await page.click({ text: 'Feedback', scope: 'main' });
    await page.waitFor('feedback tab', `(() => { return document.body.innerText.includes('Review requests'); })()`);
    await page.click({ text: 'Provenance', scope: 'main' });
    await page.waitFor('provenance tab', `(() => { return document.body.innerText.includes('Provenance chain'); })()`);
    await page.click({ text: 'API', scope: 'main' });
    await page.waitFor('api tab', `(() => { const t = document.body.innerText; return t.includes('curl') && t.includes('${job.output.solutionArtifactId}'); })()`);

    // the Performance tab (manifest.performance filled with the real id)
    await page.click({ text: 'Performance', scope: 'main' });
    await page.waitFor('performance tab', `(() => { const t = document.body.innerText; return t.includes('Script') || t.includes('duration'); })()`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (f) navigation across ALL primary views — no dead links, no console errors
// ═══════════════════════════════════════════════════════════════════════════
test('fresh browser (f): every primary view navigates and renders — zero page errors', { timeout: 300000 }, async (t) => {
  if (!BROWSER) return t.skip(SKIP_REASON);

  // every sidebar item (the app shell NAV) with the visible title that must
  // render in the main column when the view is active
  const NAV_ITEMS = [
    ['Overview', 'Overview'],
    ['Twins', 'Twins'],
    ['Captures', 'Captures'],
    ['Evidence Requests', 'Evidence Requests'],
    ['Performances', 'Performances'],
    ['Templates', 'Templates'],
    ['Renders', 'Renders'],
    ['Try-on', 'Virtual Try-on'],
    ['Live', 'Live'],
    ['Agent Avatars', 'Agent Avatars'],
    ['API & Tools', 'API & Tools'],
    ['Labs', 'Labs'],
    ['Consent & Provenance', 'Consent & Provenance'],
    ['Usage & Billing', 'Usage & Billing'],
    ['Settings', 'Settings'],
  ];

  await runFlow('(f) navigation sweep', async (page) => {
    assertFreshContext(await page.freshSnapshot(), '(f)');
    for (const [label, title] of NAV_ITEMS) {
      await page.click({ text: label, scope: 'aside nav' });
      // the sidebar marks the ACTIVE item (aria-current="page")
      await page.waitFor(`active ${label}`, `(() => { const active = document.querySelector('aside nav button[aria-current=\\"page\\"]'); return !!active && active.textContent.trim() === ${JSON.stringify(label)}; })()`);
      // the view's own header renders in the main column (non-blank content)
      await page.waitFor(`${label} view title`, `(() => { const main = document.querySelector('main'); return !!main && main.innerText.includes(${JSON.stringify(title)}); })()`);
    }
    // the error capture (window.onerror + console.error + exceptions +
    // network failures) stayed EMPTY across the whole sweep
  });
});
