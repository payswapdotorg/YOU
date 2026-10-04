// ═══════════════════════════════════════════════════════════════════════════
// YOU Solution-Artifact completion tests (P6.B6, Worker B lane) — node:test.
//
// Covers the full P5 section surface end to end:
//
// PURE UNIT half (imports lib/you/core/artifact-sections.ts directly —
// Node ≥ 23.6 type stripping, same law as the deficiency-viz / f1-recon
// suites; no network, no db, no React):
//   1. SECTION ENFORCEMENT — all three creation-path builders emit ALL 10
//      P5 section keys; every null slot carries a non-empty documented
//      reason; refs cite only ids that were actually passed in (nothing
//      invented).
//   2. TWIN-COMPILE PATH — compare filled with the REAL baseline on
//      re-compile / honestly null-with-reason on the first compile; result
//      metrics quoted verbatim; evidence filled with the real asset ids.
//   3. RENDER PATH — performance filled only when the job carries one;
//      evidence honestly null (renders consume a compiled TwinVersion, not
//      raw captures); compare baseline behaves like the compile path.
//   4. PERFORMANCE PATH — performance (self) + result + provenance + apiCode
//      filled; compare/evidence/consent/feedback/evidenceRequests honest
//      nulls-with-reasons (both the twin-linked and identity-independent
//      variants).
//   5. bindArtifactId — the apiCode placeholder is replaced with the real
//      row id; every other slot is byte-identical.
//   6. enrichSectionsLive — NO COERCION: empty live state keeps the stored
//      null-with-reason; real rows fill the slots; pass-through slots stay
//      deep-equal.
//   7. linkFollowUpVersions — causality is evidence-asset overlap only;
//      disjoint versions get no causedBySessionIds; ordering asc.
//   8. DETERMINISM — same inputs → byte-identical section JSON.
//
// API half (boots/reuses the shared app server like the W4.A/B3/B4 suites;
// no network beyond 127.0.0.1; REAL durable jobs — capture.quality,
// twin.compile ×2, performance.fromText, render.image):
//   9.  twin-compile creation path → SolutionArtifactView with manifest v2:
//       all 10 sections, feedback + evidenceRequests null-with-reason (the
//       accrual law), apiCode endpoints bound (no placeholder token), compare
//       null-with-reason on the first version.
//   10. feedback loop — POST /api/v1/feedback with solutionArtifactId → 201
//       canonical FeedbackRequest; GET [id] surfaces it LIVE
//       (sections.feedback.data.requests); the STORED manifest row is NOT
//       rewritten (read back via Prisma); immutable evidence rows are
//       byte-identical before/after (contentHash, storageKey, bytes).
//   11. improve chain end-to-end — targeted evidence request on v1 → legacy
//       fulfill (linked capture session) → asset upload → complete →
//       twin.compile v2 → v1's artifact lists the follow-up version with the
//       REAL causal session; v2's own artifact is reachable via
//       ?twinVersionId=.
//   12. performance creation path — POST /performances/from-text → durable
//       job → output.solutionArtifactId → performance-review artifact with
//       honest nulls (consent/evidence/feedback); ?performanceId= finds it.
//   13. render creation path with a performance — render-review artifact
//       with the performance section FILLED (real id + name) and evidence
//       null-with-reason; ?performanceId= returns both artifacts.
//   14. list endpoint + isolation — filters (twinVersionId / type /
//       performanceId), invalid type → 400; anonymous → 401; a second
//       tenant (Prisma-seeded API key) sees an empty list and gets 404 on
//       tenant A's artifact.
//
// Server lifecycle: lazily boots its own `next dev` on a free port, or reuses
// the sibling suite's server when aggregated (tests/index.mjs /
// tests/contract/index.mjs set __YOU_TEST_AGGREGATED__ / publish
// __YOU_TEST_BASE__) — same law as the W4.A hardening suite.
// Prerequisites: cd apps/web && bun install && cp .env.example .env && bun
// run db:push.
// ═══════════════════════════════════════════════════════════════════════════
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  ARTIFACT_ID_TOKEN,
  ARTIFACT_SECTION_KEYS,
  bindArtifactId,
  buildPerformanceSections,
  buildRenderSections,
  buildTwinCompileSections,
  enrichSectionsLive,
  linkFollowUpVersions,
} from '../../apps/web/src/lib/you/core/artifact-sections.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const APP_DIR = path.join(REPO_ROOT, 'apps', 'web');

const stamp = `${Date.now()}-${process.pid}`;

// ─── pure fixtures ───────────────────────────────────────────────────────────

const CONSENT = { grantIds: ['g1', 'g2'], scopes: ['reconstruct'], subjectId: 'subj_1' };
const V1 = { id: 'twv_1', version: 1 };
const V2 = { id: 'twv_2', version: 2 };

function compileInput(overrides = {}) {
  return {
    twinId: 'twin_1',
    twinVersion: V2,
    baselineTwinVersion: V1,
    captureSessionId: 'cs_1',
    pipeline: { id: 'pipe_1', name: 'hand-designed-hybrid' },
    confidence: { overall: 0.72, deficiencies: 3 },
    evidenceAssetIds: ['a1', 'a2', 'a3'],
    adapterComponents: [{ adapterId: 'vlm-recon-1', version: '1' }],
    provenanceKeys: ['subjectId', 'usage'],
    consent: CONSENT,
    llmCalls: 4,
    ...overrides,
  };
}

function renderInput(overrides = {}) {
  return {
    renderJobId: 'rj_1',
    twinVersion: V1,
    baselineTwinVersion: null,
    performance: null,
    adapterComponents: [{ adapterId: 'svg-portrait-1', version: '1' }],
    outputArtifact: { artifactId: 'oa_1', label: 'portrait-svg (natural)', kind: 'svg' },
    latencyMs: 412,
    costUsd: 0,
    provenanceKeys: ['components', 'note'],
    consent: { grantIds: ['g1'], scopes: ['render'], subjectId: 'subj_1' },
    ...overrides,
  };
}

function performanceInput(overrides = {}) {
  return {
    performance: { id: 'perf_1', name: 'Greeting monologue' },
    origin: 'text',
    durationMs: 12400,
    trackCount: 3,
    sentenceCount: 5,
    llmEnhanced: false,
    twinId: null,
    provenanceKeys: ['origin', 'deterministic'],
    ...overrides,
  };
}

/** every null slot must carry a non-empty documented reason */
function assertSlotLaws(sections, label) {
  assert.deepEqual(
    Object.keys(sections).sort(),
    [...ARTIFACT_SECTION_KEYS].sort(),
    `${label}: all 10 P5 section keys present`,
  );
  for (const key of ARTIFACT_SECTION_KEYS) {
    const slot = sections[key];
    if (slot.data == null) {
      assert.ok(typeof slot.reason === 'string' && slot.reason.length > 0, `${label}.${key}: null slot carries a documented reason`);
    } else {
      assert.equal(slot.reason, undefined, `${label}.${key}: filled slot carries no reason`);
    }
  }
}

/** refs must cite only ids that exist in the input set — nothing invented */
function assertRefsReal(sections, label, allowedIds) {
  const refs = [
    ...(sections.result?.data?.refs ?? []),
    ...(sections.compare?.data?.baselineTwinVersion ? [{ ref: sections.compare.data.baselineTwinVersion.id }] : []),
  ];
  for (const r of refs) {
    assert.ok(allowedIds.includes(r.ref), `${label}: ref "${r.ref}" cites a real input id (allowed: ${allowedIds.join(',')})`);
  }
}

// ─── 1. section enforcement across all builders ──────────────────────────────

test('artifact pure: all builders emit the 10 P5 sections with the null-with-reason law', () => {
  const compile = buildTwinCompileSections(compileInput());
  const render = buildRenderSections(renderInput());
  const perf = buildPerformanceSections(performanceInput());
  const perfTwinLinked = buildPerformanceSections(performanceInput({ twinId: 'twin_1' }));
  assertSlotLaws(compile, 'twin-compile');
  assertSlotLaws(render, 'render');
  assertSlotLaws(perf, 'performance');
  assertSlotLaws(perfTwinLinked, 'performance(twin-linked)');
  assertRefsReal(compile, 'twin-compile', ['twv_1', 'twv_2', 'cs_1', 'pipe_1']);
  assertRefsReal(render, 'render', ['rj_1', 'twv_1', 'oa_1']);
  assertRefsReal(perf, 'performance', ['perf_1']);
  assertRefsReal(perfTwinLinked, 'performance(twin-linked)', ['perf_1', 'twin_1']);
});

// ─── 2. twin-compile path ─────────────────────────────────────────────────────

test('artifact pure: twin-compile compare baseline + verbatim result metrics + evidence ids', () => {
  const withBaseline = buildTwinCompileSections(compileInput());
  assert.deepEqual(withBaseline.compare.data.baselineTwinVersion, V1);
  assert.match(withBaseline.result.data.summary, /v2/);
  assert.match(withBaseline.result.data.summary, /baseline v1/);
  assert.equal(withBaseline.result.data.metrics.overall, 0.72);
  assert.equal(withBaseline.result.data.metrics.deficiencies, 3);
  assert.equal(withBaseline.result.data.metrics.llmCalls, 4);
  assert.deepEqual(withBaseline.evidence.data.assetIds, ['a1', 'a2', 'a3']);
  assert.equal(withBaseline.performance.data, null);
  assert.match(withBaseline.performance.reason, /no performance track is involved/);

  const first = buildTwinCompileSections(compileInput({ twinVersion: V1, baselineTwinVersion: null }));
  assert.equal(first.compare.data, null);
  assert.match(first.compare.reason, /first compiled version/);
  assert.ok(first.compare.fillHint, 'first-compile compare carries a fill hint');

  // no confidence published → the summary says so honestly (never invented)
  const noConfidence = buildTwinCompileSections(compileInput({ confidence: null }));
  assert.match(noConfidence.result.data.summary, /no confidence summary published/);
  assert.equal(noConfidence.result.data.metrics, undefined);

  // feedback + evidenceRequests are ACCRUAL slots at creation — never filled
  assert.equal(withBaseline.feedback.data, null);
  assert.match(withBaseline.feedback.reason, /accrues after creation/);
  assert.equal(withBaseline.evidenceRequests.data, null);
  assert.match(withBaseline.evidenceRequests.reason, /accrues after creation/);
});

// ─── 3. render path ──────────────────────────────────────────────────────────

test('artifact pure: render performance fills only when the job carries one; evidence honestly null', () => {
  const withPerf = buildRenderSections(renderInput({ performance: { id: 'perf_9', name: 'Drive' } }));
  assert.deepEqual(withPerf.performance.data, { id: 'perf_9', name: 'Drive' });
  assert.equal(withPerf.evidence.data, null);
  assert.match(withPerf.evidence.reason, /render jobs consume a compiled TwinVersion/);
  assert.equal(withPerf.evidence.fillHint, 'open the twin-review artifact for this TwinVersion');

  const staticRender = buildRenderSections(renderInput());
  assert.equal(staticRender.performance.data, null);
  assert.match(staticRender.performance.reason, /static render/);

  const laterVersion = buildRenderSections(renderInput({ twinVersion: V2, baselineTwinVersion: V1 }));
  assert.deepEqual(laterVersion.compare.data.baselineTwinVersion, V1);
  const firstVersion = buildRenderSections(renderInput());
  assert.equal(firstVersion.compare.data, null);
  assert.match(firstVersion.compare.reason, /first compile/);

  assert.equal(withPerf.result.data.metrics.latencyMs, 412);
  assert.equal(withPerf.result.data.metrics.costUsd, 0);
});

// ─── 4. performance path ─────────────────────────────────────────────────────

test('artifact pure: performance-review honest nulls (both twin variants)', () => {
  const solo = buildPerformanceSections(performanceInput());
  assert.deepEqual(solo.performance.data, { id: 'perf_1', name: 'Greeting monologue' });
  assert.equal(solo.consent.data, null);
  assert.match(solo.consent.reason, /no subject evidence is involved/);
  assert.equal(solo.evidence.data, null);
  assert.match(solo.evidence.reason, /record no captures/);
  assert.equal(solo.compare.data, null);
  assert.match(solo.compare.reason, /not versioned twins/);
  assert.equal(solo.feedback.data, null);
  assert.match(solo.feedback.reason, /identity-independent and carries none/);
  assert.equal(solo.evidenceRequests.data, null);
  assert.match(solo.evidenceRequests.reason, /identity-independent and carries none/);

  const linked = buildPerformanceSections(performanceInput({ twinId: 'twin_1' }));
  assert.match(linked.feedback.reason, /twin-linked but not bound to a compiled version/);
  assert.match(linked.evidenceRequests.reason, /twin-linked but not bound/);

  assert.deepEqual(
    solo.result.data.metrics,
    { tracks: 3, durationMs: 12400, sentences: 5, llmEnhanced: false },
  );
  assert.match(solo.result.data.summary, /deterministic fallback expressions/);
});

// ─── 5. bindArtifactId ───────────────────────────────────────────────────────

test('artifact pure: bindArtifactId replaces the placeholder in apiCode only', () => {
  const sections = buildTwinCompileSections(compileInput());
  const bound = bindArtifactId(sections, 'sol_real_1');
  assert.ok(bound.apiCode.data.endpoints.every((e) => !e.includes(ARTIFACT_ID_TOKEN)));
  assert.ok(bound.apiCode.data.endpoints.includes('/api/v1/artifacts/sol_real_1'));
  // everything else is untouched
  assert.deepEqual(bound.result, sections.result);
  assert.deepEqual(bound.compare, sections.compare);
  assert.deepEqual(bound.evidence, sections.evidence);
  assert.deepEqual(bound.improve, sections.improve);
  assert.deepEqual(bound.performance, sections.performance);
  assert.deepEqual(bound.provenance, sections.provenance);
  assert.deepEqual(bound.consent, sections.consent);
  assert.deepEqual(bound.feedback, sections.feedback);
  assert.deepEqual(bound.evidenceRequests, sections.evidenceRequests);
  // a null apiCode slot (never happens today) passes through safely
  const nullApi = { ...sections, apiCode: { data: null, reason: 'none' } };
  assert.deepEqual(bindArtifactId(nullApi, 'x'), nullApi);
});

// ─── 6. enrichSectionsLive — no coercion without real rows ───────────────────

test('artifact pure: enrichSectionsLive never coerces nulls without real rows; fills with them', () => {
  const stored = buildTwinCompileSections(compileInput());

  // empty live state → the accrual slots STAY null, keeping the STORED
  // creation-time reason verbatim (the structural explanation is the honest
  // one; a generic "none yet" would only be right when no reason exists)
  const empty = enrichSectionsLive(stored, { feedbackRequests: [], evidenceRequests: [], followUpVersions: [], capabilities: ['face.profile'] });
  assert.equal(empty.feedback.data, null);
  assert.deepEqual(empty.feedback, stored.feedback, 'empty live state keeps the stored feedback slot verbatim');
  assert.equal(empty.evidenceRequests.data, null);
  assert.deepEqual(empty.evidenceRequests, stored.evidenceRequests, 'empty live state keeps the stored evidenceRequests slot verbatim');
  assert.equal(empty.improve.data, null);
  assert.deepEqual(empty.improve, stored.improve, 'empty live state keeps the stored improve slot verbatim');
  // pass-through slots are byte-identical
  for (const key of ['result', 'compare', 'evidence', 'performance', 'provenance', 'consent', 'apiCode']) {
    assert.deepEqual(empty[key], stored[key], `slot ${key} passes through untouched`);
  }

  // real rows → filled slots citing exactly those rows
  const fb = {
    id: 'fb_1', solutionArtifactId: 'sol_1', twinVersionId: 'twv_2', region: 'face.profile',
    verdict: 'missing-detail', note: 'profile is off', status: 'open', createdAt: '2026-10-04T10:00:00.000Z',
  };
  const er = {
    id: 'er_1', twinVersionId: 'twv_2', captureSessionId: 'cs_9', reason: 'profile unclear',
    capability: 'face.profile', instructions: 'turn left', expectedSignal: 'ear silhouette',
    scope: 'single capture', status: 'fulfilled', createdAt: '2026-10-04T09:00:00.000Z',
  };
  const followUps = [{
    twinVersionId: 'twv_3', version: 3, artifactId: 'sol_2', causedBySessionIds: ['cs_9'],
  }];
  const enriched = enrichSectionsLive(stored, { feedbackRequests: [fb], evidenceRequests: [er], followUpVersions: followUps, capabilities: ['face.profile'] });
  assert.deepEqual(enriched.feedback.data.requests, [fb]);
  assert.match(enriched.feedback.data.note, /merged at read time/);
  assert.deepEqual(enriched.evidenceRequests.data.requests, [er]);
  assert.deepEqual(enriched.evidenceRequests.data.capabilities, ['face.profile']);
  assert.deepEqual(enriched.improve.data.requests, [{
    requestId: 'er_1', capability: 'face.profile', status: 'fulfilled', captureSessionId: 'cs_9',
  }]);
  assert.deepEqual(enriched.improve.data.followUpVersions, followUps);
  // the STORED object was not mutated (read-time projection only)
  assert.equal(stored.feedback.data, null);
  assert.equal(stored.evidenceRequests.data, null);
  assert.equal(stored.improve.data, null);
});

// ─── 7. causal linking ───────────────────────────────────────────────────────

test('artifact pure: linkFollowUpVersions — causality is evidence overlap only', () => {
  const linked = linkFollowUpVersions({
    requests: [
      { requestId: 'er_1', captureSessionId: 'cs_1' },
      { requestId: 'er_2', captureSessionId: 'cs_2' },
      { requestId: 'er_3', captureSessionId: null },
    ],
    sessionAssets: { cs_1: ['a1', 'a2'], cs_2: ['b1'] },
    versions: [
      { twinVersionId: 'twv_3', version: 3, evidenceAssetIds: ['a2', 'z9'], artifactId: 'sol_3' },
      { twinVersionId: 'twv_4', version: 4, evidenceAssetIds: ['q1'], artifactId: null },
      { twinVersionId: 'twv_5', version: 5, evidenceAssetIds: ['b1'], artifactId: 'sol_5' },
    ],
  });
  // asc by version
  assert.deepEqual(linked.map((v) => v.version), [3, 4, 5]);
  assert.deepEqual(linked[0].causedBySessionIds, ['cs_1'], 'v3 overlaps cs_1 (a2) only');
  assert.deepEqual(linked[1].causedBySessionIds, [], 'v4 shares no asset with any fulfillment session');
  assert.deepEqual(linked[2].causedBySessionIds, ['cs_2'], 'v5 overlaps cs_2 (b1)');
  assert.equal(linked[1].artifactId, null);
});

// ─── 8. determinism ──────────────────────────────────────────────────────────

test('artifact pure: determinism — same inputs, byte-identical section JSON', () => {
  const a = buildTwinCompileSections(compileInput());
  const b = buildTwinCompileSections(compileInput());
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const c = buildRenderSections(renderInput());
  const d = buildRenderSections(renderInput());
  assert.equal(JSON.stringify(c), JSON.stringify(d));
});

// ═══════════════════════════════════════════════════════════════════════════
// API half — real durable jobs against the shared app server
// ═══════════════════════════════════════════════════════════════════════════

let base = process.env.YOU_TEST_BASE ?? null;
let cookie = null;
let child = null;
let ownServer = false;
let basePromise = null;
let prismaClient = null;

async function call(pathname, { method = 'GET', body, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie && !h.authorization) h.cookie = cookie;
  let payload;
  if (body !== undefined) {
    h['content-type'] = h['content-type'] ?? 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + pathname, { method, headers: h, body: payload });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && !h.authorization) cookie = setCookie.split(';')[0];
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
    if (j.status === 'succeeded' || j.status === 'failed' || j.status === 'dead') return j;
    if (Date.now() - t0 > timeoutMs) {
      assert.fail(`job ${jobId} (${j.kind}) did not reach a terminal state within ${timeoutMs}ms (last: ${j.status}, progress ${j.progress})`);
    }
    await new Promise((r2) => setTimeout(r2, 1500));
  }
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
          console.log(`[b6-tests] reusing suite server at ${base}`);
          return base;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(!aggregated, 'aggregated run: the sibling suite never published its server URL within 150s');
      console.log('[b6-tests] booting apps/web (next dev) on a free port…');
      await startServer();
      ownServer = true;
      console.log(`[b6-tests] server ready at ${base}`);
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

after(async () => {
  if (prismaClient) await prismaClient.$disconnect().catch(() => undefined);
  if (ownServer) {
    await killTree();
    if (child && child.pid) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    console.log('[b6-tests] own server stopped');
  }
});

// minimal valid PNG (1×1) — same fixture as the verification-flow suite
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

async function uploadFormCall(pathname, regions) {
  const h = {};
  if (cookie) h.cookie = cookie;
  const res = await fetch(base + pathname, { method: 'POST', headers: h, body: uploadForm(regions) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// shared state across the sequential API tests
let twinA = null;            // { id, subjectId }
let v1 = null;               // { id, version }
let artifact1 = null;        // the v1 twin-review SolutionArtifactView
let session1 = null;         // first capture session id
let feedbackRow = null;      // created FeedbackRequest
let evidenceAssetsBefore = null; // immutability snapshot
let fulfillmentSessionId = null;
let v2 = null;               // follow-up version
let artifact2 = null;        // v2's artifact id
let performanceArtifact = null; // performance-review SolutionArtifactView
let performanceId = null;
let renderArtifact = null;   // render-review SolutionArtifactView
let foreignKey = null;       // tenant-B API key secret

const REGIONS_FULL = ['face.front', 'face.profile', 'face.hairline', 'teeth', 'hands', 'silhouette.front', 'silhouette.side'];

/** boot a capture session → upload → complete → return the quality job */
async function runCaptureCycle(sessionId, regions) {
  const up = await uploadFormCall(`/api/v1/captures/${sessionId}/assets`, regions);
  assert.equal(up.status, 201, `upload → ${up.status}`);
  const done = await call(`/api/v1/captures/${sessionId}/complete`, { method: 'POST', body: {} });
  assert.equal(done.status, 202, `complete → ${done.status}`);
  const qualityJob = await pollJob(done.json.jobId);
  assert.equal(qualityJob.status, 'succeeded', `capture.quality failed honestly: ${qualityJob.error ?? ''}`);
  const after = await call(`/api/v1/captures/${sessionId}`);
  assert.equal(after.status, 200);
  assert.equal(after.json.status, 'complete', `session ${sessionId} must be complete`);
  return after.json;
}

// ─── 9. twin-compile creation path end-to-end ────────────────────────────────

test('artifact api: twin.compile produces a manifest-v2 SolutionArtifact with honest sections', async () => {
  await ensureBase();
  await call('/api/v1/session', { method: 'POST', body: {} });

  const created = await call('/api/v1/twins', { method: 'POST', body: { displayName: `B6 twin ${stamp}` } });
  assert.equal(created.status, 201, `twin create → ${created.status}`);
  twinA = created.json;

  const grant = await call('/api/v1/consent-grants', {
    method: 'POST',
    body: { subjectId: twinA.subjectId, purpose: `b6 artifact completion ${stamp}`, scopes: ['capture', 'reconstruct', 'render'], ttlHours: 2 },
  });
  assert.equal(grant.status, 201, `grant → ${grant.status}`);

  const cap = await call(`/api/v1/twins/${twinA.id}/capture-sessions`, { method: 'POST', body: {} });
  assert.equal(cap.status, 201);
  session1 = cap.json.id;
  await runCaptureCycle(session1, REGIONS_FULL);

  const compile = await call(`/api/v1/twins/${twinA.id}/compile`, {
    method: 'POST',
    body: { captureSessionId: session1, style: 'photorealistic' },
  });
  assert.equal(compile.status, 202);
  const compileJob = await pollJob(compile.json.jobId);
  assert.equal(compileJob.status, 'succeeded', `twin.compile failed honestly: ${compileJob.error ?? ''}`);
  assert.ok(compileJob.output.solutionArtifactId, 'compile output must reference the artifact');
  v1 = { id: compileJob.output.twinVersionId, version: compileJob.output.version };

  const r = await call(`/api/v1/artifacts/${compileJob.output.solutionArtifactId}`);
  assert.equal(r.status, 200, `GET artifact → ${r.status}`);
  artifact1 = r.json;
  assert.equal(artifact1.type, 'twin-review');
  assert.equal(artifact1.manifest.version, 2, 'manifest v2');
  assert.equal(artifact1.manifest.solutionId, artifact1.id);

  const sections = artifact1.manifest.sections;
  assert.ok(sections, 'v2 manifest carries sections');
  assert.deepEqual(Object.keys(sections).sort(), [...ARTIFACT_SECTION_KEYS].sort());

  // result: real refs + verbatim metrics from the job output
  assert.ok(sections.result.data.refs.some((x) => x.ref === v1.id), 'result cites the real TwinVersion');
  assert.ok(sections.result.data.refs.some((x) => x.ref === session1), 'result cites the real capture session');
  assert.equal(sections.result.data.metrics.deficiencies, compileJob.output.deficienciesCount);
  assert.equal(sections.result.data.metrics.overall, compileJob.output.confidence);

  // first version → compare honestly null
  assert.equal(sections.compare.data, null);
  assert.match(sections.compare.reason, /first compiled version/);

  // evidence: the real asset ids from the capture session
  const sessionAfter = await call(`/api/v1/captures/${session1}`);
  const assetIds = sessionAfter.json.assets.map((a) => a.id);
  assert.deepEqual(sections.evidence.data.assetIds, assetIds);

  // accrual slots honestly null
  assert.equal(sections.feedback.data, null);
  assert.match(sections.feedback.reason, /no FeedbackRequests reference this artifact yet|accrues after creation/);
  assert.equal(sections.evidenceRequests.data, null);

  // apiCode endpoints are bound — no placeholder survives
  assert.ok(sections.apiCode.data.endpoints.includes(`/api/v1/artifacts/${artifact1.id}`));
  assert.ok(sections.apiCode.data.endpoints.every((e) => !e.includes('__ARTIFACT_ID__')));
  assert.ok(sections.apiCode.data.endpoints.includes(`/api/v1/twins/${twinA.id}/versions`));
});

// ─── 10. feedback loop: linkage, live surfacing, immutability ────────────────

test('artifact api: feedback → canonical FeedbackRequest + live merge + evidence immutability', async () => {
  await ensureBase();
  const db = await prisma();

  // snapshot the immutable evidence rows BEFORE feedback
  const assetRows = await db.evidenceAsset.findMany({ where: { captureSessionId: session1 } });
  assert.ok(assetRows.length > 0);
  evidenceAssetsBefore = assetRows.map((a) => ({ id: a.id, contentHash: a.contentHash, storageKey: a.storageKey, bytes: a.bytes }));

  // the STORED manifest before any feedback (for the not-rewritten assert)
  const storedBefore = await db.solutionArtifact.findUnique({ where: { id: artifact1.id } });

  const fb = await call('/api/v1/feedback', {
    method: 'POST',
    body: {
      solutionArtifactId: artifact1.id,
      twinVersionId: v1.id,
      verdict: 'missing-detail',
      region: 'face.profile',
      note: 'profile silhouette is off',
    },
  });
  assert.equal(fb.status, 201, `feedback POST → ${fb.status}`);
  feedbackRow = fb.json;
  assert.equal(feedbackRow.solutionArtifactId, artifact1.id, 'the FeedbackRequest is linked to the artifact');
  assert.equal(feedbackRow.twinVersionId, v1.id);
  assert.equal(feedbackRow.status, 'open');

  // GET [id] → the live merge surfaces the request
  const r = await call(`/api/v1/artifacts/${artifact1.id}`);
  assert.equal(r.status, 200);
  const live = r.json.manifest.sections;
  assert.ok(live.feedback.data, 'feedback slot FILLED after a real request exists');
  assert.deepEqual(live.feedback.data.requests, [feedbackRow]);
  assert.match(live.feedback.data.note, /merged at read time/);

  // the STORED manifest row was NOT rewritten by feedback or the read
  const storedAfter = await db.solutionArtifact.findUnique({ where: { id: artifact1.id } });
  assert.equal(storedAfter.manifest, storedBefore.manifest, 'the stored manifest is byte-identical (immutable snapshot)');

  // immutable evidence rows are untouched
  const assetsAfter = await db.evidenceAsset.findMany({ where: { captureSessionId: session1 } });
  assert.deepEqual(
    assetsAfter.map((a) => ({ id: a.id, contentHash: a.contentHash, storageKey: a.storageKey, bytes: a.bytes })),
    evidenceAssetsBefore,
    'feedback NEVER mutates immutable evidence',
  );

  // invalid verdict is refused (canonical contract enforcement)
  const bad = await call('/api/v1/feedback', {
    method: 'POST',
    body: { solutionArtifactId: artifact1.id, twinVersionId: v1.id, verdict: 'great' },
  });
  assert.equal(bad.status, 400);
});

// ─── 11. improve chain end-to-end (request → fulfill → capture → v2) ─────────

test('artifact api: improve chain — request → fulfillment capture → v2, causally linked', async () => {
  await ensureBase();

  // (a) create a targeted evidence request against v1
  const req = await call('/api/v1/evidence-requests', {
    method: 'POST',
    body: {
      twinVersionId: v1.id,
      reason: 'b6 chain: profile unclear at v1',
      capability: 'face.profile',
      instructions: 'turn the head left and right',
      expectedSignal: 'ear silhouette + jawline',
    },
  });
  assert.equal(req.status, 201, `evidence request → ${req.status}`);
  const request1 = req.json;
  assert.equal(request1.status, 'open');
  assert.equal(request1.twinVersionId, v1.id);

  // the artifact now surfaces the live request in BOTH accrual slots
  const mid = await call(`/api/v1/artifacts/${artifact1.id}`);
  assert.equal(mid.status, 200);
  assert.ok(mid.json.manifest.sections.evidenceRequests.data, 'evidenceRequests slot filled by the live request');
  assert.equal(mid.json.manifest.sections.evidenceRequests.data.requests[0].id, request1.id);
  assert.ok(mid.json.manifest.sections.improve.data, 'improve slot filled once a request exists');
  assert.equal(mid.json.manifest.sections.improve.data.requests[0].requestId, request1.id);
  assert.equal(mid.json.manifest.sections.improve.data.requests[0].captureSessionId, null, 'not yet fulfilled');
  assert.deepEqual(mid.json.manifest.sections.improve.data.followUpVersions, [], 'no follow-up version yet');

  // (b) LEGACY fulfill → a linked capture session (request flips fulfilled)
  const fulfill = await call(`/api/v1/evidence-requests/${request1.id}/fulfill`, {
    method: 'POST',
    body: { twinId: twinA.id },
  });
  assert.equal(fulfill.status, 201, `fulfill → ${fulfill.status}`);
  fulfillmentSessionId = fulfill.json.captureSession.id;

  // (c) upload evidence into the fulfillment session + complete
  await runCaptureCycle(fulfillmentSessionId, ['face.profile']);

  // (d) compile v2 FROM the fulfillment session only
  const compile2 = await call(`/api/v1/twins/${twinA.id}/compile`, {
    method: 'POST',
    body: { captureSessionId: fulfillmentSessionId, style: 'photorealistic' },
  });
  assert.equal(compile2.status, 202);
  const job2 = await pollJob(compile2.json.jobId);
  assert.equal(job2.status, 'succeeded', `second compile failed honestly: ${job2.error ?? ''}`);
  v2 = { id: job2.output.twinVersionId, version: job2.output.version };
  assert.equal(v2.version, 2);
  artifact2 = job2.output.solutionArtifactId;

  // (e) v1's artifact now shows the REAL causal chain
  const after = await call(`/api/v1/artifacts/${artifact1.id}`);
  assert.equal(after.status, 200);
  const improve = after.json.manifest.sections.improve.data;
  assert.ok(improve, 'improve slot filled');
  const chainRequest = improve.requests.find((r) => r.requestId === request1.id);
  assert.ok(chainRequest, 'the fulfillment request is in the chain');
  assert.equal(chainRequest.captureSessionId, fulfillmentSessionId, 'the request cites its fulfillment capture');
  assert.equal(chainRequest.status, 'fulfilled');

  assert.equal(improve.followUpVersions.length, 1, 'one follow-up version');
  const followUp = improve.followUpVersions[0];
  assert.equal(followUp.twinVersionId, v2.id);
  assert.equal(followUp.artifactId, artifact2, 'the follow-up links to v2\u2019s own artifact');
  assert.deepEqual(followUp.causedBySessionIds, [fulfillmentSessionId], 'v2 is causally linked to the fulfillment capture (evidence overlap)');

  // (f) v2's own artifact is a first-class twin-review with v1 as baseline
  const a2 = await call(`/api/v1/artifacts/${artifact2}`);
  assert.equal(a2.status, 200);
  assert.deepEqual(a2.json.manifest.sections.compare.data.baselineTwinVersion, { id: v1.id, version: 1 });

  // (g) ?twinVersionId= list filter finds v2's artifact
  const byVersion = await call(`/api/v1/artifacts?twinVersionId=${v2.id}`);
  assert.equal(byVersion.status, 200);
  assert.ok(byVersion.json.some((x) => x.id === artifact2), 'list filter by twinVersionId finds the v2 artifact');
  assert.ok(!byVersion.json.some((x) => x.id === artifact1.id), 'v1\u2019s artifact is not in v2\u2019s list');
});

// ─── 12. performance creation path ───────────────────────────────────────────

test('artifact api: performance.fromText produces a performance-review artifact with honest nulls', async () => {
  await ensureBase();

  const created = await call('/api/v1/performances/from-text', {
    method: 'POST',
    body: {
      name: `B6 monologue ${stamp}`,
      script: 'Hello there. This is a test performance. It has a few sentences.',
    },
  });
  assert.equal(created.status, 202, `from-text → ${created.status}`);
  const job = await pollJob(created.json.jobId);
  assert.equal(job.status, 'succeeded', `performance job failed honestly: ${job.error ?? ''}`);
  assert.ok(job.output.solutionArtifactId, 'performance output must reference the artifact');
  performanceId = job.output.performanceId;

  const r = await call(`/api/v1/artifacts/${job.output.solutionArtifactId}`);
  assert.equal(r.status, 200);
  performanceArtifact = r.json;
  assert.equal(performanceArtifact.type, 'performance-review');

  const sections = performanceArtifact.manifest.sections;
  assert.deepEqual(Object.keys(sections).sort(), [...ARTIFACT_SECTION_KEYS].sort());

  // performance (self) is filled with the REAL id
  assert.deepEqual(sections.performance.data, { id: performanceId, name: `B6 monologue ${stamp}` });

  // honest nulls — documented, never invented
  assert.equal(sections.consent.data, null);
  assert.match(sections.consent.reason, /no subject evidence is involved/);
  assert.equal(sections.evidence.data, null);
  assert.match(sections.evidence.reason, /record no captures/);
  assert.equal(sections.compare.data, null);
  assert.match(sections.compare.reason, /not versioned twins/);
  assert.equal(sections.feedback.data, null);
  assert.match(sections.feedback.reason, /identity-independent and carries none/);
  assert.equal(sections.evidenceRequests.data, null);

  // result metrics are the job's verbatim output
  assert.equal(sections.result.data.metrics.tracks, job.output.tracks);
  assert.equal(sections.result.data.metrics.durationMs, job.output.durationMs);
  assert.equal(sections.result.data.metrics.sentences, job.output.sentences);
  assert.equal(sections.result.data.metrics.llmEnhanced, job.output.llmEnhanced);

  // the manifest-level consent is null too (no biometrics involved)
  assert.equal(performanceArtifact.manifest.consent, null);

  // ?performanceId= finds it
  const byPerf = await call(`/api/v1/artifacts?performanceId=${performanceId}`);
  assert.equal(byPerf.status, 200);
  assert.ok(byPerf.json.some((x) => x.id === performanceArtifact.id), 'performanceId filter finds the artifact');
});

// ─── 13. render creation path with a performance ─────────────────────────────

test('artifact api: render with a performance fills the performance section with real references', async () => {
  await ensureBase();

  const render = await call('/api/v1/renders', {
    method: 'POST',
    body: {
      twinId: twinA.id,
      twinVersionId: v1.id,
      performanceId,
      kind: 'image',
      style: 'stylized-portrait',
      adapter: 'svg-portrait-1',
    },
  });
  assert.equal(render.status, 202, `render create → ${render.status}`);
  const job = await pollJob(render.json.jobId);
  assert.equal(job.status, 'succeeded', `render job failed honestly: ${job.error ?? ''}`);
  assert.ok(job.output.solutionArtifactId, 'render output must reference the artifact');

  const r = await call(`/api/v1/artifacts/${job.output.solutionArtifactId}`);
  assert.equal(r.status, 200);
  renderArtifact = r.json;
  assert.equal(renderArtifact.type, 'render-review');

  const sections = renderArtifact.manifest.sections;
  assert.deepEqual(Object.keys(sections).sort(), [...ARTIFACT_SECTION_KEYS].sort());

  // the performance slot cites the REAL performance driving the render
  assert.deepEqual(sections.performance.data, { id: performanceId, name: `B6 monologue ${stamp}` });
  // evidence honestly null — renders consume a compiled TwinVersion
  assert.equal(sections.evidence.data, null);
  assert.match(sections.evidence.reason, /render jobs consume a compiled TwinVersion/);
  // this render's TwinVersion is v1 — the FIRST compile → compare honestly null
  assert.equal(sections.compare.data, null);
  // result metrics verbatim from the job output
  assert.equal(sections.result.data.metrics.latencyMs, job.output.latencyMs);

  // ?performanceId= now returns BOTH artifacts (performance-review + render-review)
  const byPerf = await call(`/api/v1/artifacts?performanceId=${performanceId}`);
  assert.equal(byPerf.status, 200);
  const ids = byPerf.json.map((x) => x.id);
  assert.ok(ids.includes(performanceArtifact.id), 'performance-review artifact listed');
  assert.ok(ids.includes(renderArtifact.id), 'render-review artifact listed');
});

// ─── 14. list endpoint, validation, auth + tenant isolation ───────────────────

test('artifact api: list filters, validation, auth and tenant isolation', async () => {
  await ensureBase();
  const db = await prisma();

  // anonymous → 401
  const anon = await fetch(`${base}/api/v1/artifacts`);
  assert.equal(anon.status, 401, `anonymous list → ${anon.status}`);
  const anonDetail = await fetch(`${base}/api/v1/artifacts/${artifact1.id}`);
  assert.equal(anonDetail.status, 401, `anonymous detail → ${anonDetail.status}`);

  // invalid type filter → 400 with the documented envelope
  const badType = await call('/api/v1/artifacts?type=nope');
  assert.equal(badType.status, 400);
  assert.equal(badType.json.error.code, 'validation_failed');

  // unfiltered list (tenant A, cookie session) contains this run's artifacts
  const all = await call('/api/v1/artifacts');
  assert.equal(all.status, 200);
  const allIds = all.json.map((x) => x.id);
  assert.ok(allIds.includes(artifact1.id));
  assert.ok(allIds.includes(performanceArtifact.id));
  assert.ok(allIds.includes(renderArtifact.id));
  // newest first ordering
  assert.ok(all.json[0].createdAt >= all.json[all.json.length - 1].createdAt, 'newest first');

  // type filter
  const perfOnly = await call('/api/v1/artifacts?type=performance-review');
  assert.equal(perfOnly.status, 200);
  assert.ok(perfOnly.json.every((x) => x.type === 'performance-review'));
  assert.ok(perfOnly.json.some((x) => x.id === performanceArtifact.id));

  // twinVersionId filter (v1 → twin-review + render-review, not the performance artifact)
  const v1List = await call(`/api/v1/artifacts?twinVersionId=${v1.id}`);
  assert.equal(v1List.status, 200);
  assert.ok(v1List.json.some((x) => x.id === artifact1.id));
  assert.ok(v1List.json.some((x) => x.id === renderArtifact.id));
  assert.ok(!v1List.json.some((x) => x.id === performanceArtifact.id));

  // unknown artifact id → 404 for the owner
  const missing = await call('/api/v1/artifacts/sol_does_not_exist');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'not_found');

  // ── second tenant (Prisma-seeded API key — the honest multi-tenant path)
  const slug = `b6-foreign-${stamp}`;
  const tenant = await db.tenant.create({ data: { slug, name: `B6 Foreign ${stamp}` } });
  await db.user.create({ data: { tenantId: tenant.id, email: `b6-foreign-${stamp}@example.test`, name: 'B6 Foreign', role: 'owner' } });
  foreignKey = `you_sk_b6_${sha256hex(`${stamp}-foreign`).slice(0, 24)}`;
  await db.apiKey.create({
    data: { tenantId: tenant.id, name: 'b6-isolation', prefix: foreignKey.slice(0, 10), hash: sha256hex(foreignKey), scopes: JSON.stringify(['read', 'write']) },
  });

  // tenant B sees an EMPTY list (its own scope, indistinguishable from none)
  const foreignList = await call('/api/v1/artifacts', { headers: { authorization: `Bearer ${foreignKey}` } });
  assert.equal(foreignList.status, 200, `foreign list → ${foreignList.status}`);
  assert.deepEqual(foreignList.json, [], 'tenant B has no artifacts');

  // tenant B gets 404 on tenant A's artifact (indistinguishable from nonexistent)
  const foreignDetail = await call(`/api/v1/artifacts/${artifact1.id}`, { headers: { authorization: `Bearer ${foreignKey}` } });
  assert.equal(foreignDetail.status, 404);
  assert.equal(foreignDetail.json.error.code, 'not_found');

  // tenant B cannot attach feedback to tenant A's artifact either
  const foreignFeedback = await call('/api/v1/feedback', {
    method: 'POST',
    body: { solutionArtifactId: artifact1.id, twinVersionId: v1.id, verdict: 'correct' },
    headers: { authorization: `Bearer ${foreignKey}` },
  });
  assert.equal(foreignFeedback.status, 404, `foreign feedback → ${foreignFeedback.status}`);

  // tenant B cannot list tenant A's version-scoped artifacts
  const foreignVersion = await call(`/api/v1/artifacts?twinVersionId=${v1.id}`, { headers: { authorization: `Bearer ${foreignKey}` } });
  assert.equal(foreignVersion.status, 200);
  assert.deepEqual(foreignVersion.json, []);
});
