// ═══════════════════════════════════════════════════════════════════════════
// YOU Lab productionization tests (P6.C10, Worker C lane) — node:test.
//
// Covers the promotion lifecycle + learning ladder + Capture Scientist with
// real evidence:
//   PURE (no server, no db — the zero-runtime-import suite law):
//     1. ladder: the full legal/illegal transition table (promote = exactly
//        one stage forward, no skipping; retire from any live stage; revert =
//        real backward steps + un-retire);
//     2. priorStatusForRevert: trail-derived priors (rejected never moved
//        anything; retired counts forward → un-retire; double-revert lands
//        on the honest already-at-prior);
//     3. evaluators: {min}/{max}/{required} machine verdicts, descriptive
//        strings stay 'manual', unknown names/shapes are honest failures,
//        manual-only objectives cannot machine-validate;
//     4. replay: the deterministic projection strips the real measurements
//        (identity across same-seed runs, divergence on genome change,
//        single-observation honesty);
//     5. mutation: natural-key child naming, the weighted formula, the
//        offspring comparison + a hashString drift guard against
//        lab/determinism.ts;
//     6. genome: mutateGenome determinism (same seed → deep-equal mutant,
//        different seed → different mutant, evaluation seed preserved);
//     7. scientist: region → capability mapping (teeth→face, hair.back→hair,
//        walking→motion), instructions from remediation + suspected cause,
//        region-less + unmapped-region refusals.
//   API (own server — STANDALONE-BY-DESIGN, the storage-db law: this suite
//   is the only one that compiles the lab executors import chain, and that
//   compile pushes the AGGREGATED shared server past the station's 4 GiB
//   cgroup ceiling — documented in tests/index.mjs + tests/contract/index.mjs;
//   standalone it is green with its own lean server):
//     8.  401s on all five new routes + invalid action 400 + unknown
//         pipeline 404;
//     9.  no-runs + skip refusals (benchmarked gate: machine-checked from
//         real run rows; to: validated from draft → 400);
//     10. the full evidence-gated ladder walk: benchmarked → validated
//         (replay asserted byte-identical) → canary (refused, then the
//         backdated ≥1h window) → production (blocked by failures for
//         missed regions, then a clean all-captured window) — plus the
//         generalist-mirror pipeline that can never validate (the seeded
//         machine gates derive from the real seed-42 distribution);
//     11. revert semantics + un-retire + retire terminality + double-revert;
//     12. the genome loop: the durable lab.mutate job (deterministic child,
//         REAL parent-vs-offspring run with both orgs, lineage recorded,
//         idempotency same-key→same-job, natural-key child reuse, honest
//         auto-draft only on offspring wins, retired-parent refusal);
//     13. the scientist flow: 201 + the tenant-scoped queue + honest 400s;
//     14. tenant isolation: the queue is tenant-scoped; the research plane is
//         global (disclosed design) — a second tenant's actor acts on
//         promotions and is recorded verbatim in decidedBy.
//
// Server lifecycle: boots its own `next dev` on a free port (aggregated runs
// never import this suite). Prerequisites: the documented app boot (cd
// apps/web && bun install && cp .env.example .env && bun run db:push). The
// DB is touched directly (Prisma) to craft deterministic benchmark runs for
// the ladder walk (rows mirror the real harness distribution on seed 42,
// disclosed inline) — the mutate loop runs the REAL executor end-to-end. No
// network beyond 127.0.0.1 (+ the station's own AI seam for the 2 grounding
// calls, which degrade honestly to modeled-only when unavailable).
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

// ─── pure modules under test (node-importable, the genome.ts .ts law) ───────
import {
  canRetire, canRevert, isLabPipelineStatus, priorStatusForRevert, promoteTarget,
  PROMOTION_STAGE_REQUIREMENTS,
} from '../../apps/web/src/lib/you/lab/ladder.ts';
import { evaluateObjectiveGates } from '../../apps/web/src/lib/you/lab/evaluators.ts';
import { projectForDeterministicReplay, replayVerdict } from '../../apps/web/src/lib/you/lab/replay.ts';
import {
  LAB_MUTATE_JOB_KIND, naturalChildName, weightedScore, compareOffspring, childGeneration, lineageSummary,
} from '../../apps/web/src/lib/you/lab/mutation.ts';
import { buildScientistRequest, isScientistRefusal } from '../../apps/web/src/lib/you/lab/capture-scientist.ts';
import { mutateGenome } from '../../apps/web/src/lib/you/lab/genome.ts';
import { hashString, stableStringify } from '../../apps/web/src/lib/you/lab/determinism.ts';

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

let walkPipeline = null;      // the ladder-walk pipeline
let generalistMirror = null; // can never validate (seed-42 distribution)
let genomeParent = null;      // the mutate-loop parent
let tenantBCookie = null;    // the isolation tenant's session cookie

// ─── tiny HTTP client with session-cookie memory ─────────────────────────────
async function call(pathname, { method = 'GET', body, headers = {}, noCookie = false, cookieOverride } = {}) {
  const h = { ...headers };
  if (cookieOverride) h.cookie = cookieOverride;
  else if (cookie && !noCookie) h.cookie = cookie;
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

// ─── server lifecycle (own lean server — never aggregated) ───────────────────
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
    setTimeout(finish, 5000).unref();
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
    // the lab.mutate executor makes up to 2 real grounding calls inside its
    // job budget — widen ONLY the job wall-clock budget for this suite's own
    // server (documented env knobs; the default 30s budget is tight when the
    // station AI seam is rate-limiting and the grounding calls back off)
    env: { ...process.env, YOU_JOB_RETRY_BUDGET_MS: '180000' },
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

function ensureBase() {
  if (!basePromise) {
    basePromise = (async () => {
      if (base) return base; // YOU_TEST_BASE (station-provided)
      console.log('[lab-prod] booting apps/web (next dev) on a free port…');
      await startServer();
      ownServer = true;
      console.log(`[lab-prod] server ready at ${base}`);
      return base;
    })().catch((err) => {
      basePromise = null;
      throw err;
    });
  }
  return basePromise;
}

/** The demo session (also runs the idempotent seedLabBaseline upgrade). */
async function login() {
  if (cookie) return;
  await ensureBase();
  const r = await call('/api/v1/session', { method: 'POST', body: {} });
  assert.equal(r.status, 200, `session bootstrap → ${r.status}: ${r.text}`);
}

// ─── direct DB access (deterministic ladder-walk fixtures) ───────────────────
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

// ─── fixtures ────────────────────────────────────────────────────────────────
// A hand-designed-like genome (mirrors the seeded HAND_DESIGNED_GENOME shape —
// inlined here because seed.ts is not node-importable; the ladder gates read
// run rows, not this object).
const WALK_GENOME = {
  stages: [
    { adapterId: 'lab-segment-1', version: '1', params: { method: 'region-grid', granularity: 2 } },
    { adapterId: 'vlm-recon-1', version: '1', params: { perAssetCalls: 1, mergeStrategy: 'weighted-average' } },
    { adapterId: 'lab-merge-1', version: '1', params: { confidencePolicy: 'weighted', coveragePolicy: 'canonical-regions' } },
    { adapterId: 'lab-qa-1', version: '1', params: { deficiencyPolicy: 'canonical-regions' } },
  ],
  parameters: { designNote: `lab-prod walk fixture ${stamp}` },
  skills: ['region-coverage-check', 'deficiency-remediation'],
  soulKey: 'soul-two-deep',
  compute: { class: 'serverless-cpu', maxCostUsd: 1 },
  evaluation: { rubric: ['coverage', 'confidence', 'latency', 'cost', 'determinism'], seed: 42 },
};

const CANONICAL_REGIONS = [
  'face.front', 'face.profile', 'face.hairline', 'teeth',
  'hands', 'hair.back', 'silhouette.front', 'silhouette.side',
  'walking', 'speech',
];

function regionSimulation({ missed = [] } = {}) {
  return CANONICAL_REGIONS.map((region) => ({
    region,
    difficulty: 0.5,
    occlusionPenalty: 0,
    captured: !missed.includes(region),
    regionConfidence: missed.includes(region) ? 0 : 0.78,
  }));
}

/**
 * A report detail mirroring the real harness distribution on seed 42
 * (hand-designed: coverage 0.8 / confidence 0.78 / costUsd 0.02 — verified
 * live against evaluateOrganizations during C10; the real-measurement fields
 * vary per run so the replay strip is exercised for real).
 */
function walkReportDetail({ missed = ['hands', 'walking'], latencyBasis = 'mixed: modeled + ONE observed grounding call' } = {}) {
  return {
    simulated: true,
    worldId: 'world-human-recon-42',
    worldSeed: 42,
    genomeStages: WALK_GENOME.stages,
    regionSimulation: regionSimulation({ missed }),
    perStage: WALK_GENOME.stages.map((s) => ({
      adapterId: s.adapterId,
      role: 'stage',
      modeledLatencyMs: 120,
      modeledCostUsd: s.adapterId === 'vlm-recon-1' ? 0.01 : 0,
      observedLatencyMs: 847, // real measurement — must be stripped by the replay projection
    })),
    thresholds: { baseSensitivity: 0.87 },
    // the real-measurement block (stripped by the projection):
    groundingCall: { real: true, latencyMs: 847, model: 'glm-fast', error: null },
    latencyRealMs: 847,
    latencyComponentsLabeled: 5,
    llmLatencyComponents: [{ component: 'vlm-recon-1', latencyMs: 847, basis: 'observed' }],
    latencyMsBasis: latencyBasis,
    latencyNote: 'latencyMs = modeled per-stage + ONE real grounding call',
  };
}

function walkScores({ coverage = 0.8, confidence = 0.78, latencyMs = 947 } = {}) {
  return { coverage, confidence, latencyMs, costUsd: 0.02, determinism: 1 };
}

async function createTestPipeline(pr, { name, status = 'draft', genome = WALK_GENOME, generation = 0 } = {}) {
  return pr.pipelineCandidate.create({
    data: { name, genome: JSON.stringify(genome), generation, parentId: null, origin: 'searched', status },
  });
}

/** Craft a succeeded BenchmarkRun + the pipeline's org report (deterministic). */
async function seedRun(pr, { pipelineId, orgId, createdAt = new Date(), scores = walkScores(), detail = walkReportDetail() } = {}) {
  const objective = await pr.labObjective.findUnique({ where: { code: 'HUMAN-RECON-001' } });
  assert.ok(objective, 'HUMAN-RECON-001 must exist (the session bootstrap seeds it)');
  const run = await pr.benchmarkRun.create({
    data: {
      objectiveId: objective.id,
      worldSeed: 42,
      status: 'succeeded',
      organizations: JSON.stringify([
        { organizationId: orgId, label: `lab-prod org ${orgId}`, origin: 'searched', bodies: [], pipelineId },
      ]),
      metrics: JSON.stringify({ simulated: true, note: 'lab-prod test fixture (mirrors the real seed-42 distribution)' }),
      startedAt: createdAt,
      finishedAt: createdAt,
      createdAt,
    },
  });
  await pr.evaluationReport.create({
    data: {
      benchmarkRunId: run.id,
      organizationId: orgId,
      scores: JSON.stringify(scores),
      reproducible: true,
      seed: 42,
      detail: JSON.stringify(detail),
      createdAt,
    },
  });
  return run;
}

async function promote(pipelineId, body = {}) {
  return call('/api/v1/lab/promotions', {
    method: 'POST',
    body: { pipelineId, action: 'promote', ...body },
  });
}

async function getGates(pipelineId) {
  return call(`/api/v1/lab/pipelines/${pipelineId}/gates`);
}

/** Poll a durable job to a terminal state (the UI's exact flow). */
async function waitForJob(jobId, { timeoutMs = 180000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await call(`/api/v1/jobs/${jobId}`);
    assert.equal(r.status, 200, `job fetch → ${r.status}`);
    const { status } = r.json;
    if (status === 'succeeded' || status === 'failed' || status === 'dead') return r.json;
    if (Date.now() > deadline) assert.fail(`job ${jobId} did not finish within ${timeoutMs}ms (last status: ${status})`);
    await new Promise((res2) => setTimeout(res2, 750));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PURE — ladder
// ═══════════════════════════════════════════════════════════════════════════
test('ladder: the full legal/illegal transition table', () => {
  // promote = exactly one stage forward, never skipping
  assert.equal(promoteTarget('draft'), 'benchmarked');
  assert.equal(promoteTarget('benchmarked'), 'validated');
  assert.equal(promoteTarget('validated'), 'canary');
  assert.equal(promoteTarget('canary'), 'production');
  assert.equal(promoteTarget('production'), null, 'production is the top of the ladder');
  assert.equal(promoteTarget('retired'), null, 'retired is terminal — not a promote source');

  // retire is legal from every live stage, never from retired
  for (const s of ['draft', 'benchmarked', 'validated', 'canary', 'production']) {
    assert.ok(canRetire(s), `retire from ${s} is legal`);
  }
  assert.ok(!canRetire('retired'), 'retired is terminal');

  // revert: real backward steps only (or un-retire)
  assert.ok(canRevert('benchmarked', 'draft'));
  assert.ok(canRevert('validated', 'benchmarked'));
  assert.ok(canRevert('canary', 'validated'));
  assert.ok(canRevert('production', 'canary'));
  assert.ok(!canRevert('draft', 'draft'), 'staying put is not a revert (already-at-prior 409 instead)');
  assert.ok(!canRevert('validated', 'draft'), 'multi-step backward is not a single revert');
  assert.ok(!canRevert('canary', 'production'), 'forward is never a revert');
  for (const to of ['draft', 'benchmarked', 'validated', 'canary', 'production']) {
    assert.ok(canRevert('retired', to), `un-retire to ${to} is legal`);
  }
  assert.ok(!canRevert('retired', 'retired'), 'un-retire to retired is incoherent');

  // status recognition + the stage requirements table
  for (const s of ['draft', 'benchmarked', 'validated', 'canary', 'production', 'retired']) {
    assert.ok(isLabPipelineStatus(s));
  }
  assert.ok(!isLabPipelineStatus('live'));
  assert.ok(!isLabPipelineStatus(''));
  for (const target of ['benchmarked', 'validated', 'canary', 'production']) {
    const req = PROMOTION_STAGE_REQUIREMENTS[target];
    assert.ok(req?.label, `requirement label for ${target}`);
    assert.ok(req?.detail, `requirement detail for ${target}`);
    assert.ok(Array.isArray(req?.criteria) && req.criteria.length > 0);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PURE — revert priors
// ═══════════════════════════════════════════════════════════════════════════
test('ladder: priorStatusForRevert from the promotion trail (incl. un-retire, double-revert)', () => {
  const t0 = new Date('2026-10-05T00:00:00Z');
  const t1 = new Date('2026-10-05T01:00:00Z');
  const t2 = new Date('2026-10-05T02:00:00Z');
  const t3 = new Date('2026-10-05T03:00:00Z');

  // nothing forward ever happened → nothing to revert to
  assert.equal(priorStatusForRevert([]), null);
  assert.equal(
    priorStatusForRevert([
      { decision: 'rejected', fromStatus: 'validated', toStatus: 'validated', createdAt: t1 },
    ]),
    null,
    'rejected never moved anything — no prior to revert to',
  );

  // the newest forward move defines the prior
  assert.equal(
    priorStatusForRevert([
      { decision: 'drafted', fromStatus: 'draft', toStatus: 'benchmarked', createdAt: t0 },
      { decision: 'promoted', fromStatus: 'benchmarked', toStatus: 'validated', createdAt: t1 },
    ]),
    'benchmarked',
  );

  // a reject between forwards does not disturb the prior
  assert.equal(
    priorStatusForRevert([
      { decision: 'drafted', fromStatus: 'draft', toStatus: 'benchmarked', createdAt: t0 },
      { decision: 'rejected', fromStatus: 'benchmarked', toStatus: 'benchmarked', createdAt: t1 },
      { decision: 'promoted', fromStatus: 'benchmarked', toStatus: 'validated', createdAt: t2 },
    ]),
    'benchmarked',
  );

  // a reverted (backward) record is skipped — the latest FORWARD defines the prior,
  // so a double-revert lands on the honest already-at-prior 409
  assert.equal(
    priorStatusForRevert([
      { decision: 'drafted', fromStatus: 'draft', toStatus: 'benchmarked', createdAt: t0 },
      { decision: 'promoted', fromStatus: 'benchmarked', toStatus: 'validated', createdAt: t1 },
      { decision: 'reverted', fromStatus: 'validated', toStatus: 'benchmarked', createdAt: t2 },
    ]),
    'benchmarked',
    'already at the prior — the second revert must 409 (already_at_prior)',
  );

  // retiring counts as a forward move → reverting a retired pipeline un-retires
  assert.equal(
    priorStatusForRevert([
      { decision: 'promoted', fromStatus: 'canary', toStatus: 'production', createdAt: t1 },
      { decision: 'retired', fromStatus: 'production', toStatus: 'retired', createdAt: t2 },
    ]),
    'production',
  );

  // re-promotion after a revert: the newest forward wins
  assert.equal(
    priorStatusForRevert([
      { decision: 'drafted', fromStatus: 'draft', toStatus: 'benchmarked', createdAt: t0 },
      { decision: 'promoted', fromStatus: 'benchmarked', toStatus: 'validated', createdAt: t1 },
      { decision: 'reverted', fromStatus: 'validated', toStatus: 'benchmarked', createdAt: t2 },
      { decision: 'promoted', fromStatus: 'benchmarked', toStatus: 'validated', createdAt: t3 },
    ]),
    'benchmarked',
  );

  // garbage fromStatus on the newest forward → honest null (never a guess)
  assert.equal(
    priorStatusForRevert([{ decision: 'promoted', fromStatus: 'live', toStatus: 'validated', createdAt: t1 }]),
    null,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// PURE — evaluators
// ═══════════════════════════════════════════════════════════════════════════
test('evaluators: machine verdicts, manual gates, honest refusals', () => {
  const report = { scores: { coverage: 0.8, confidence: 0.78, costUsd: 0.02, determinism: 1, latencyMs: 947 }, reproducible: true };

  // the seeded objective's exact gates — hand-designed passes, generalist fails
  const seeded = {
    coverage: { min: 0.7 },
    confidence: { min: 0.6 },
    determinism: { required: true },
    costUsd: { max: 0.05 },
    reproducibility: { required: true },
    benchmark: 'descriptive', rights: 'descriptive', privacy: 'descriptive', cost: 'descriptive', latency: 'descriptive',
  };
  let v = evaluateObjectiveGates(seeded, report);
  assert.ok(v.machinePass, `seeded gates must machine-pass on the hand-designed distribution: ${v.note}`);
  assert.equal(v.checks.find((c) => c.gate === 'coverage').verdict, 'pass');
  assert.equal(v.checks.find((c) => c.gate === 'coverage').actual, 0.8);
  assert.equal(v.checks.find((c) => c.gate === 'latency').verdict, 'manual', 'latency stays a human gate');

  const generalist = { scores: { coverage: 0.5, confidence: 0.38, costUsd: 0.02, determinism: 1, latencyMs: 700 }, reproducible: true };
  v = evaluateObjectiveGates(seeded, generalist);
  assert.ok(!v.machinePass, 'the generalist distribution must fail the seeded gates');
  assert.equal(v.checks.find((c) => c.gate === 'coverage').verdict, 'fail');
  assert.equal(v.checks.find((c) => c.gate === 'confidence').verdict, 'fail');

  // {min}/{max} boundaries + booleans
  v = evaluateObjectiveGates({ coverage: { min: 0.8 } }, report);
  assert.ok(v.machinePass, 'boundary is inclusive (>=)');
  v = evaluateObjectiveGates({ coverage: { min: 0.81 } }, report);
  assert.ok(!v.machinePass);
  v = evaluateObjectiveGates({ costUsd: { max: 0.02 } }, report);
  assert.ok(v.machinePass, 'boundary is inclusive (<=)');
  v = evaluateObjectiveGates({ reproducibility: { required: true } }, { scores: {}, reproducible: false });
  assert.ok(!v.machinePass);

  // descriptive strings are manual, never auto-pass
  v = evaluateObjectiveGates({ rights: 'research-only never promotes past research' }, report);
  assert.ok(!v.anyMachine && !v.anyFail);
  assert.ok(!v.machinePass, 'a manual-only objective cannot machine-validate');
  assert.match(v.note, /cannot machine-validate/);
  assert.equal(v.checks[0].verdict, 'manual');

  // unknown gate name → honest failure
  v = evaluateObjectiveGates({ vibes: { min: 0.5 } }, report);
  assert.ok(!v.machinePass);
  assert.equal(v.checks.find((c) => c.gate === 'vibes').verdict, 'fail');
  assert.match(v.checks.find((c) => c.gate === 'vibes').note, /no machine mapping/);

  // garbage shapes → honest failures
  v = evaluateObjectiveGates({ coverage: 0.7, confidence: ['high'], determinism: {} }, report);
  assert.ok(!v.machinePass);
  assert.equal(v.checks.find((c) => c.gate === 'coverage').verdict, 'fail');
  assert.equal(v.checks.find((c) => c.gate === 'confidence').verdict, 'fail');
  assert.equal(v.checks.find((c) => c.gate === 'determinism').verdict, 'fail');

  // missing metric → honest failure
  v = evaluateObjectiveGates({ coverage: { min: 0.5 } }, { scores: {}, reproducible: true });
  assert.ok(!v.machinePass);
  assert.match(v.checks.find((c) => c.gate === 'coverage').note, /not reported/);

  // non-object gates JSON
  v = evaluateObjectiveGates('all good', report);
  assert.ok(!v.machinePass && !v.anyMachine);
  v = evaluateObjectiveGates(null, report);
  assert.ok(!v.machinePass);
});

// ═══════════════════════════════════════════════════════════════════════════
// PURE — replay
// ═══════════════════════════════════════════════════════════════════════════
test('replay: the deterministic projection + verdicts (identity, divergence, single-observation honesty)', () => {
  const mk = (latencyMs, basis) => ({
    scores: { coverage: 0.8, confidence: 0.78, latencyMs, costUsd: 0.02, determinism: 1 },
    detail: {
      genomeStages: WALK_GENOME.stages,
      regionSimulation: regionSimulation({}),
      perStage: [{ adapterId: 'vlm-recon-1', modeledLatencyMs: 120, observedLatencyMs: latencyMs }],
      groundingCall: { real: true, latencyMs, model: 'glm-fast', error: null },
      latencyRealMs: latencyMs,
      latencyMsBasis: basis,
      latencyNote: 'varies per run',
    },
  });

  // the projection strips the real measurements — different latencies, same projection
  const p1 = projectForDeterministicReplay(mk(847, 'mixed'));
  const p2 = projectForDeterministicReplay(mk(1334, 'modeled only'));
  assert.equal(stableStringify(p1), stableStringify(p2), 'real measurements must not affect the projection');
  assert.equal(p1.scores.latencyMs, undefined);
  assert.equal(p1.detail.groundingCall, undefined);
  assert.equal(p1.detail.latencyRealMs, undefined);
  assert.equal(p1.detail.llmLatencyComponents, undefined);
  assert.equal(p1.detail.latencyMsBasis, undefined);
  assert.equal(p1.detail.perStage[0].observedLatencyMs, undefined);
  assert.ok(p1.detail.genomeStages, 'genome-determined evidence stays');
  assert.ok(p1.scores.coverage === 0.8, 'pure metrics stay');

  // identity across same-seed runs
  let verdict = replayVerdict([projectForDeterministicReplay(mk(100, 'a')), projectForDeterministicReplay(mk(200, 'b')), projectForDeterministicReplay(mk(300, 'c'))]);
  assert.ok(verdict.deterministic);
  assert.equal(verdict.runsCompared, 3);
  assert.match(verdict.reason, /byte-identical/);

  // divergence: a mutated genome (genomeStages changed) never replays as its parent
  const mutated = mk(100, 'a');
  mutated.detail.genomeStages = [...WALK_GENOME.stages, { adapterId: 'lab-qa-1', version: '1', params: { role: 'fallback' } }];
  verdict = replayVerdict([projectForDeterministicReplay(mk(100, 'a')), projectForDeterministicReplay(mutated)]);
  assert.ok(!verdict.deterministic);
  assert.match(verdict.reason, /diverged/);

  // divergence on a pure metric change (coverage)
  const worse = mk(100, 'a');
  worse.scores.coverage = 0.5;
  verdict = replayVerdict([projectForDeterministicReplay(mk(100, 'a')), projectForDeterministicReplay(worse)]);
  assert.ok(!verdict.deterministic);

  // single-observation honesty — never a fabricated pass
  verdict = replayVerdict([projectForDeterministicReplay(mk(100, 'a'))]);
  assert.ok(!verdict.deterministic);
  assert.equal(verdict.runsCompared, 1);
  assert.match(verdict.reason, /single observation|honest refusal/);

  verdict = replayVerdict([]);
  assert.ok(!verdict.deterministic);
  assert.equal(verdict.runsCompared, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// PURE — mutation lineage + the drift guard
// ═══════════════════════════════════════════════════════════════════════════
test('mutation: natural-key naming, the weighted formula, the comparison + the hashString drift guard', () => {
  // drift guard: determinism.ts's hashString must never silently change
  assert.equal(hashString('P6.C10'), 3540863661, 'lab/determinism.ts hashString drifted — replay/naming would break');
  assert.equal(hashString('HUMAN-RECON-001'), 723484502);
  assert.equal(hashString(''), 2166136261);

  // natural key: deterministic, seed-sensitive, parent-sensitive
  assert.equal(naturalChildName('hand-designed-hybrid', 5), naturalChildName('hand-designed-hybrid', 5));
  assert.notEqual(naturalChildName('hand-designed-hybrid', 5), naturalChildName('hand-designed-hybrid', 6));
  assert.notEqual(naturalChildName('hand-designed-hybrid', 5), naturalChildName('searched-gen1', 5));
  assert.ok(naturalChildName('hand-designed-hybrid', 5).startsWith('hand-designed-hybrid-'));
  assert.equal(childGeneration(3), 4);

  // the weighted formula mirrors lab/benchmark.ts
  assert.equal(LAB_MUTATE_JOB_KIND, 'lab.mutate');
  assert.equal(
    weightedScore({ coverage: 0.8, confidence: 0.78, determinism: 1, latencyMs: 390 }),
    0.8324,
  );
  assert.equal(
    weightedScore({ coverage: 0.5, confidence: 0.38, determinism: 1, latencyMs: 800 }),
    0.5567,
  );

  // the honest comparison
  let c = compareOffspring(
    { coverage: 0.5, confidence: 0.38, determinism: 1, latencyMs: 800 },
    { coverage: 0.8, confidence: 0.78, determinism: 1, latencyMs: 900 },
  );
  assert.ok(c.childBetter);
  assert.equal(c.parentScore, 0.5567);
  assert.equal(c.childScore, 0.8315);
  assert.equal(c.delta, 0.2748);
  assert.match(c.note, /offspring wins/);

  c = compareOffspring(
    { coverage: 0.8, confidence: 0.78, determinism: 1, latencyMs: 100 },
    { coverage: 0.5, confidence: 0.38, determinism: 1, latencyMs: 100 },
  );
  assert.ok(!c.childBetter);
  assert.ok(c.delta < 0);
  assert.match(c.note, /offspring loses/);

  c = compareOffspring(
    { coverage: 0.8, confidence: 0.78, determinism: 1, latencyMs: 100 },
    { coverage: 0.8, confidence: 0.78, determinism: 1, latencyMs: 100 },
  );
  assert.ok(!c.childBetter && c.delta === 0);
  assert.match(c.note, /tie/);

  // the lineage summary
  const l = lineageSummary({ id: 'p1', name: 'parent', generation: 2 }, 7, ['a', 42, 'b']);
  assert.equal(l.parentId, 'p1');
  assert.equal(l.childGeneration, 3);
  assert.deepEqual(l.mutations, ['a', 'b'], 'non-string mutation entries are dropped');
  assert.equal(l.mutationSeed, 7);
});

// ═══════════════════════════════════════════════════════════════════════════
// PURE — mutateGenome determinism
// ═══════════════════════════════════════════════════════════════════════════
test('genome: mutateGenome determinism (same seed → same mutant; evaluation seed preserved)', () => {
  const a = mutateGenome(WALK_GENOME, 5);
  const b = mutateGenome(WALK_GENOME, 5);
  assert.deepEqual(a, b, 'same genome + same seed → the same mutant');
  const c = mutateGenome(WALK_GENOME, 6);
  assert.notDeepEqual(a, c, 'different seed → a different mutant');

  // the evaluation seed is deliberately preserved (benchmark reproducibility)
  assert.equal(a.evaluation.seed, WALK_GENOME.evaluation.seed);
  assert.equal(c.evaluation.seed, WALK_GENOME.evaluation.seed);

  // lineage is recorded
  assert.ok(Array.isArray(a.parameters.mutations) && a.parameters.mutations.length > 0);
  assert.match(a.parameters.mutatedBy, /mutateGenome\(seed=5\)/);

  // a mutant of a mutant still records its own lineage
  const d = mutateGenome(a, 9);
  assert.ok(Array.isArray(d.parameters.mutations) && d.parameters.mutations.length > 0);
  assert.notDeepEqual(d.stages, a.stages);
});

// ═══════════════════════════════════════════════════════════════════════════
// PURE — the Capture Scientist
// ═══════════════════════════════════════════════════════════════════════════
test('scientist: region→capability mapping + honest refusals (no fabricated guidance)', () => {
  const failure = (region, extra = {}) => ({
    id: `f-${Math.random()}`,
    benchmarkRunId: 'run-1',
    inputConditions: { region, worldSeed: 42, regionDifficulty: 0.6, occlusionPenalty: 0, ...extra },
    suspectedCause: 'Region "hands" has high capture difficulty under the world noise. Two sentences.',
    remediation: 'Request targeted hand evidence (palms visible, fingers spread).',
    confidence: 0.75,
  });

  // the full canonical-region mapping (the reported axes)
  const cases = [
    ['face.front', 'face'], ['face.profile', 'face'], ['face.hairline', 'face'],
    ['teeth', 'face'], ['hands', 'hands'], ['hair.back', 'hair'],
    ['silhouette.front', 'silhouette'], ['silhouette.side', 'silhouette'],
    ['walking', 'motion'], ['speech', 'speech'],
  ];
  for (const [region, capability] of cases) {
    const draft = buildScientistRequest(failure(region));
    assert.ok(!isScientistRefusal(draft), `${region} must map`);
    assert.equal(draft.capability, capability);
    assert.match(draft.instructions, /Suspected cause:/);
    assert.match(draft.instructions, /Recorded remediation:/);
    assert.match(draft.expectedSignal, /next benchmark/);
    assert.match(draft.expectedSignal, new RegExp(region));
    assert.ok(draft.reason.includes(region));
    assert.ok(draft.scope.length > 20);
  }

  // no region → honest refusal
  let r = buildScientistRequest({ ...failure('hands'), inputConditions: { worldSeed: 42 } });
  assert.ok(isScientistRefusal(r));
  assert.match(r.refusal, /no region/);

  // unmapped region → honest refusal
  r = buildScientistRequest(failure('left-elbow'));
  assert.ok(isScientistRefusal(r));
  assert.match(r.refusal, /unmapped region/);

  // missing remediation → honest degrade, not fabrication
  const draft = buildScientistRequest({ ...failure('hands'), remediation: null });
  assert.ok(!isScientistRefusal(draft));
  assert.match(draft.instructions, /No remediation was recorded/);
});

// ═══════════════════════════════════════════════════════════════════════════
// API — auth + validation surfaces
// ═══════════════════════════════════════════════════════════════════════════
test('api: 401s on all five routes + invalid action 400 + unknown pipeline 404', async () => {
  await ensureBase();

  const unauth = [
    ['/api/v1/lab/promotions', 'POST', { pipelineId: 'x', action: 'reject', reason: 'x' }],
    ['/api/v1/lab/pipelines/x/gates', 'GET', undefined],
    ['/api/v1/lab/pipelines/x/mutate', 'POST', {}],
    ['/api/v1/lab/failures/x/evidence-request', 'POST', {}],
    ['/api/v1/lab/capture-requests', 'GET', undefined],
  ];
  for (const [pathname, method, body] of unauth) {
    const r = await call(pathname, { method, body, noCookie: true });
    assert.equal(r.status, 401, `${method} ${pathname} unauthenticated → ${r.status}`);
    assert.equal(r.json?.error?.code, 'unauthenticated');
  }

  await login();

  // invalid action
  let r = await call('/api/v1/lab/promotions', { method: 'POST', body: { pipelineId: 'x', action: 'teleport' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /action must be one of/);

  // unknown pipeline
  r = await call('/api/v1/lab/promotions', { method: 'POST', body: { pipelineId: `nope-${stamp}`, action: 'reject', reason: 'x' } });
  assert.equal(r.status, 404);
  r = await getGates(`nope-${stamp}`);
  assert.equal(r.status, 404);
  r = await call(`/api/v1/lab/pipelines/nope-${stamp}/mutate`, { method: 'POST', body: {} });
  assert.equal(r.status, 404);
});

test('api: promote gates — no-runs refusal + skip refusal (machine-checked from real rows)', async () => {
  await login();
  const pr = await prisma();
  const pipeline = await createTestPipeline(pr, { name: `lab-prod-noruns-${stamp}` });

  // no succeeded run includes the pipeline → the benchmarked gate fails
  let r = await promote(pipeline.id);
  assert.equal(r.status, 409, `no-runs promote → ${r.status}`);
  assert.equal(r.json.error.details.reason, 'gate_failed');
  assert.match(r.json.error.message, /no succeeded benchmark run/);

  // the preview agrees with the refusal (the UI renders this before any attempt)
  let g = await getGates(pipeline.id);
  assert.equal(g.status, 200);
  assert.equal(g.json.target, 'benchmarked');
  assert.ok(g.json.requirement.label.length > 0);
  assert.equal(g.json.evaluation.pass, false);
  assert.match(g.json.evaluation.reason, /no succeeded benchmark run/);

  // skipping ahead: the only legal promote target from draft is benchmarked
  r = await promote(pipeline.id, { to: 'validated' });
  assert.equal(r.status, 400, `skip promote → ${r.status}`);
  assert.match(r.json.error.message, /only legal promote target/);

  // a cited run id that does not include the pipeline → 404 (no silent citation)
  const other = await seedRun(pr, { pipelineId: `other-${stamp}`, orgId: `org-other-${stamp}` });
  r = await promote(pipeline.id, { benchmarkRunIds: [other.id] });
  assert.equal(r.status, 404, `foreign run citation → ${r.status}`);
  assert.match(r.json.error.message, /does not exist or does not include/);
});

// ═══════════════════════════════════════════════════════════════════════════
// API — the full evidence-gated ladder walk
// ═══════════════════════════════════════════════════════════════════════════
test('api: the full evidence-gated ladder walk (benchmarked → validated → canary → production)', async () => {
  await login();
  const pr = await prisma();

  // the seeded objective NOW carries quantitative machine gates (the seed
  // upgrade ran at session bootstrap) — assert the law this walk relies on
  const objective = await pr.labObjective.findUnique({ where: { code: 'HUMAN-RECON-001' } });
  const gates = JSON.parse(objective.gates);
  assert.equal(gates.coverage.min, 0.7);
  assert.equal(gates.confidence.min, 0.6);
  assert.equal(gates.costUsd.max, 0.05);

  walkPipeline = await createTestPipeline(pr, { name: `lab-prod-walk-${stamp}` });
  const orgId = `org-walk-${stamp}`;

  // three same-seed runs whose projections are byte-identical (real
  // measurement fields deliberately vary — the replay strip is exercised)
  const now = Date.now();
  const R = [];
  for (let i = 0; i < 3; i++) {
    R.push(await seedRun(pr, {
      pipelineId: walkPipeline.id,
      orgId,
      createdAt: new Date(now - i * 60_000),
      scores: walkScores({ latencyMs: 900 + i * 137 }),
      detail: walkReportDetail({ latencyBasis: i % 2 === 0 ? 'mixed: modeled + ONE observed' : 'modeled only' }),
    }));
  }

  // ─── draft → benchmarked: ≥1 succeeded run including this pipeline ──────
  let g = await getGates(walkPipeline.id);
  assert.equal(g.status, 200);
  assert.equal(g.json.evaluation.pass, true, `benchmarked gate must pass: ${g.json.evaluation?.reason}`);
  assert.ok(g.json.succeededRunIds.length >= 3);

  let r = await promote(walkPipeline.id);
  assert.equal(r.status, 200, `benchmarked promote → ${r.status}: ${r.text}`);
  assert.equal(r.json.pipeline.status, 'benchmarked');
  assert.equal(r.json.promotion.decision, 'promoted');
  assert.match(r.json.promotion.decidedBy, /^user:/, 'decidedBy is SERVER-derived from the authenticated actor');
  assert.equal(r.json.promotion.fromStatus, 'draft');
  assert.equal(r.json.promotion.toStatus, 'benchmarked');
  assert.ok(r.json.promotion.evidence.citedRunIds === null || Array.isArray(r.json.promotion.evidence.citedRunIds));

  // ─── benchmarked → validated: machine gates + byte-identical replay ──────
  g = await getGates(walkPipeline.id);
  assert.equal(g.json.target, 'validated');
  assert.equal(g.json.evaluation.pass, true, `validated gate must pass: ${g.json.evaluation?.reason}`);
  assert.equal(g.json.evaluation.replay.deterministic, true, 'the three runs replay byte-identical');
  assert.equal(g.json.evaluation.replay.runsCompared, 3);
  assert.ok(g.json.evaluation.gates.gates.some((c) => c.gate === 'coverage' && c.verdict === 'pass'));

  r = await promote(walkPipeline.id);
  assert.equal(r.status, 200, `validated promote → ${r.status}: ${r.text}`);
  assert.equal(r.json.pipeline.status, 'validated');

  // ─── validated → canary: the newest-3-run window must span ≥1h of REAL time
  g = await getGates(walkPipeline.id);
  assert.equal(g.json.target, 'canary');
  assert.equal(g.json.evaluation.pass, false, 'fresh timestamps cannot span an hour');
  assert.equal(g.json.evaluation.canary.countOk, true);
  assert.equal(g.json.evaluation.canary.spanOk, false);

  r = await promote(walkPipeline.id);
  assert.equal(r.status, 409, `canary promote with a short window → ${r.status}`);
  assert.equal(r.json.error.details.reason, 'gate_failed');
  assert.match(r.json.error.message, /span/);

  // backdate the oldest window run (the B5 createdAt-seeding precedent)
  await pr.benchmarkRun.update({
    where: { id: R[2].id },
    data: { createdAt: new Date(now - 2 * 3600 * 1000) },
  });

  r = await promote(walkPipeline.id);
  assert.equal(r.status, 200, `canary promote after backdating → ${r.status}: ${r.text}`);
  assert.equal(r.json.pipeline.status, 'canary');
  assert.ok(r.json.evaluation.canary.spanMs >= 3600_000, 'the window now spans ≥1h');

  // ─── canary → production: zero blocking failures for missed regions ──────
  // the walk reports miss hands+walking; failures inside the window for
  // missed regions block; an unknown region blocks conservatively
  const failureRows = [];
  for (const spec of [
    { region: 'hands', cause: 'hands stayed uncaptured' },
    { region: 'left-elbow', cause: 'a region the simulation never saw — unknown is unknown' },
  ]) {
    failureRows.push(await pr.failureCase.create({
      data: {
        benchmarkRunId: R[0].id,
        inputConditions: JSON.stringify({ region: spec.region, worldSeed: 42, simulated: true }),
        suspectedCause: spec.cause,
        confidence: 0.7,
        remediation: 'Request targeted evidence via an EvidenceRequest and re-benchmark.',
      },
    }));
  }

  g = await getGates(walkPipeline.id);
  assert.equal(g.json.target, 'production');
  assert.equal(g.json.evaluation.pass, false, 'blocking failures must refuse production');
  const blocking = g.json.evaluation.blockingFailures;
  assert.equal(blocking.length, 2, `expected hands + unknown-region to block (got ${blocking.length})`);
  assert.ok(blocking.some((f) => f.region === 'hands'));
  assert.ok(blocking.some((f) => f.region === 'left-elbow'));
  // a failure for a region the org CAPTURED does not block — add one and count
  await pr.failureCase.create({
    data: {
      benchmarkRunId: R[0].id,
      inputConditions: JSON.stringify({ region: 'face.front', worldSeed: 42, simulated: true }),
      suspectedCause: 'another org missed face.front — not this pipeline',
      confidence: 0.7,
    },
  });
  g = await getGates(walkPipeline.id);
  assert.equal(g.json.evaluation.blockingFailures.length, 2, 'captured-region failures do not block');

  r = await promote(walkPipeline.id);
  assert.equal(r.status, 409, `production promote with blocking failures → ${r.status}`);
  assert.equal(r.json.error.details.reason, 'gate_failed');
  assert.match(r.json.error.message, /blocking failure/);
  assert.equal(r.json.error.details.evaluation.blockingFailures.length, 2);

  // the clean window: three all-captured runs NEWER than everything before
  // and spanning ≥1h, with the failure-carrying runs backdated OUT of the
  // window (the B5 createdAt-seeding precedent)
  const now2 = Date.now();
  await pr.benchmarkRun.update({ where: { id: R[0].id }, data: { createdAt: new Date(now2 - 3 * 3600 * 1000) } });
  await pr.benchmarkRun.update({ where: { id: R[1].id }, data: { createdAt: new Date(now2 - 3 * 3600 * 1000 + 60_000) } });
  for (const createdAt of [new Date(now2 - 70 * 60_000), new Date(now2 - 10 * 60_000), new Date(now2 - 60_000)]) {
    await seedRun(pr, {
      pipelineId: walkPipeline.id,
      orgId,
      createdAt,
      scores: walkScores({ coverage: 1, confidence: 0.78, latencyMs: 800 }),
      detail: walkReportDetail({ missed: [] }),
    });
  }
  g = await getGates(walkPipeline.id);
  assert.equal(g.json.evaluation.pass, true, `the clean window must pass production: ${g.json.evaluation?.reason}`);
  assert.equal(g.json.evaluation.blockingFailures.length, 0);

  r = await promote(walkPipeline.id);
  assert.equal(r.status, 200, `production promote → ${r.status}: ${r.text}`);
  assert.equal(r.json.pipeline.status, 'production');

  // production is the top — only retire (or revert) applies
  r = await promote(walkPipeline.id);
  assert.equal(r.status, 409);
  assert.match(r.json.error.message, /top of the ladder/);
  g = await getGates(walkPipeline.id);
  assert.equal(g.json.target, null);
  assert.match(g.json.note, /top of the ladder/);

  // ─── the generalist mirror can never validate (the seeded machine gates
  // derive from the real seed-42 distribution: generalist 0.5/0.38) ────────
  generalistMirror = await createTestPipeline(pr, { name: `lab-prod-generalist-${stamp}` });
  await seedRun(pr, {
    pipelineId: generalistMirror.id,
    orgId: `org-generalist-${stamp}`,
    scores: walkScores({ coverage: 0.5, confidence: 0.38, latencyMs: 700 }),
  });
  r = await promote(generalistMirror.id);
  assert.equal(r.status, 200, 'benchmarked only needs a run — the gate is the run itself');
  r = await promote(generalistMirror.id);
  assert.equal(r.status, 409, 'the generalist distribution must fail the machine gates');
  assert.match(r.json.error.message, /coverage|confidence/);
});

// ═══════════════════════════════════════════════════════════════════════════
// API — revert semantics + un-retire + retire terminality
// ═══════════════════════════════════════════════════════════════════════════
test('api: revert semantics, un-retire, retire terminality, double-revert honesty', async () => {
  await login();
  const pr = await prisma();
  assert.ok(walkPipeline, 'the ladder walk must have run first (sequential suite)');

  // a fresh pipeline with no forward trail has nothing to revert to
  const fresh = await createTestPipeline(pr, { name: `lab-prod-fresh-${stamp}` });
  let r = await call('/api/v1/lab/promotions', { method: 'POST', body: { pipelineId: fresh.id, action: 'revert', reason: 'go back' } });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.details.reason, 'no_prior_status');
  assert.match(r.json.error.message, /nothing to revert to/);

  // reject requires a reason (auditable refusal)
  r = await call('/api/v1/lab/promotions', { method: 'POST', body: { pipelineId: walkPipeline.id, action: 'reject' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /reject requires a reason/);
  r = await call('/api/v1/lab/promotions', { method: 'POST', body: { pipelineId: walkPipeline.id, action: 'reject', reason: `walk rejection ${stamp}` } });
  assert.equal(r.status, 200, `reject at production → ${r.status}`);
  assert.equal(r.json.pipeline.status, 'production', 'reject never moves the pipeline');
  assert.equal(r.json.promotion.decision, 'rejected');
  assert.equal(r.json.promotion.fromStatus, r.json.promotion.toStatus);

  // retire from production → terminal
  r = await call('/api/v1/lab/promotions', { method: 'POST', body: { pipelineId: walkPipeline.id, action: 'retire', reason: `walk retire ${stamp}` } });
  assert.equal(r.status, 200, `retire → ${r.status}`);
  assert.equal(r.json.pipeline.status, 'retired');
  assert.equal(r.json.promotion.decision, 'retired');

  // terminal: promote/reject/mutate all refused from retired
  r = await promote(walkPipeline.id);
  assert.equal(r.status, 409);
  assert.match(r.json.error.message, /retired is terminal|no promote target/);
  r = await call('/api/v1/lab/promotions', { method: 'POST', body: { pipelineId: walkPipeline.id, action: 'reject', reason: 'x' } });
  assert.equal(r.status, 409);
  assert.match(r.json.error.message, /retired pipeline cannot be rejected/);
  r = await call(`/api/v1/lab/pipelines/${walkPipeline.id}/mutate`, { method: 'POST', body: {} });
  assert.equal(r.status, 409);
  assert.match(r.json.error.message, /retired pipelines are not mutated/);
  r = await call('/api/v1/lab/promotions', { method: 'POST', body: { pipelineId: walkPipeline.id, action: 'retire' } });
  assert.equal(r.status, 409);
  assert.match(r.json.error.message, /retired is terminal — nothing to retire/);

  // gates preview states the terminal truth
  let g = await getGates(walkPipeline.id);
  assert.equal(g.json.target, null);
  assert.match(g.json.note, /terminal/);

  // un-retire: revert computes the pre-retire status from the trail
  r = await call('/api/v1/lab/promotions', { method: 'POST', body: { pipelineId: walkPipeline.id, action: 'revert', reason: `un-retire ${stamp}` } });
  assert.equal(r.status, 200, `un-retire → ${r.status}: ${r.text}`);
  assert.equal(r.json.pipeline.status, 'production', 'the trail says the pipeline was production before retiring');
  assert.equal(r.json.promotion.decision, 'reverted');
  assert.equal(r.json.promotion.fromStatus, 'retired');
  assert.equal(r.json.promotion.toStatus, 'production');

  // double-revert: the newest forward move is still the retire record →
  // the pipeline already sits at its prior → the honest 409
  r = await call('/api/v1/lab/promotions', { method: 'POST', body: { pipelineId: walkPipeline.id, action: 'revert', reason: 'again' } });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.details.reason, 'already_at_prior_status');
  assert.match(r.json.error.message, /already sits at its prior status/);

  // a REAL backward step: the generalist mirror sits at benchmarked with a
  // single promoted(draft→benchmarked) record on its trail → prior = draft
  assert.ok(generalistMirror, 'the walk must have run first');
  r = await call('/api/v1/lab/promotions', { method: 'POST', body: { pipelineId: generalistMirror.id, action: 'revert', reason: `mirror back to draft ${stamp}` } });
  assert.equal(r.status, 200, `real backward step → ${r.status}: ${r.text}`);
  assert.equal(r.json.pipeline.status, 'draft');
  assert.equal(r.json.promotion.fromStatus, 'benchmarked');
  assert.equal(r.json.promotion.toStatus, 'draft');
  assert.equal(r.json.promotion.decision, 'reverted');
  // reverting again: the newest forward move is still the promote record →
  // the pipeline already sits at its prior → the honest 409
  r = await call('/api/v1/lab/promotions', { method: 'POST', body: { pipelineId: generalistMirror.id, action: 'revert', reason: 'again' } });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.details.reason, 'already_at_prior_status');

  // retire + un-retire cycles keep working (the trail-derived prior is the
  // pre-retire status every time)
  r = await call('/api/v1/lab/promotions', { method: 'POST', body: { pipelineId: walkPipeline.id, action: 'retire', reason: 'cycle 2' } });
  assert.equal(r.status, 200);
  r = await call('/api/v1/lab/promotions', { method: 'POST', body: { pipelineId: walkPipeline.id, action: 'revert', reason: 'un-retire again' } });
  assert.equal(r.status, 200, `second un-retire → ${r.status}: ${r.text}`);
  assert.equal(r.json.pipeline.status, 'production');

  g = await getGates(walkPipeline.id);
  assert.equal(g.json.status, 'production');
});

// ═══════════════════════════════════════════════════════════════════════════
// API — the Pipeline Genome loop (the REAL lab.mutate executor)
// ═══════════════════════════════════════════════════════════════════════════
test('api: the genome loop — durable lab.mutate job, lineage, idempotency, natural-key reuse', async () => {
  await login();
  const pr = await prisma();

  genomeParent = await createTestPipeline(pr, { name: `lab-prod-genome-parent-${stamp}` });
  const idemKey = `lab-prod-mutate-${stamp}`;
  const childName = naturalChildName(genomeParent.name, 5);

  // validation precedes everything
  let r = await call(`/api/v1/lab/pipelines/${genomeParent.id}/mutate`, { method: 'POST', body: { mutationSeed: 1.5 } });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /31-bit integer/);
  r = await call(`/api/v1/lab/pipelines/${genomeParent.id}/mutate`, { method: 'POST', body: { objectiveCode: 'NOPE-404' } });
  assert.equal(r.status, 404);

  // the real mutation: 202 + a durable job
  r = await call(`/api/v1/lab/pipelines/${genomeParent.id}/mutate`, {
    method: 'POST',
    body: { mutationSeed: 5, worldSeed: 42 },
    headers: { 'x-idempotency-key': idemKey },
  });
  assert.equal(r.status, 202, `mutate → ${r.status}: ${r.text}`);
  assert.equal(r.json.mutationSeed, 5);
  assert.equal(r.json.worldSeed, 42);
  assert.equal(r.json.objectiveCode, 'HUMAN-RECON-001');
  const jobId = r.json.jobId;

  // idempotency: same key → the same job
  r = await call(`/api/v1/lab/pipelines/${genomeParent.id}/mutate`, {
    method: 'POST',
    body: { mutationSeed: 5, worldSeed: 42 },
    headers: { 'x-idempotency-key': idemKey },
  });
  assert.equal(r.status, 202);
  assert.equal(r.json.jobId, jobId, 'same idempotency key → the same job');

  const job = await waitForJob(jobId);
  assert.equal(job.status, 'succeeded', `the lab.mutate job must succeed: ${job.error ?? ''}`);
  assert.equal(job.kind, 'lab.mutate');
  const out = job.output;
  assert.ok(out.benchmarkRunId, 'a REAL benchmark run was persisted');
  assert.equal(out.childName, childName);
  assert.equal(out.parentPipelineId, genomeParent.id);
  assert.equal(out.mutationSeed, 5);
  assert.ok(out.lineage.mutations.length > 0, 'the mutation diff is recorded');
  assert.equal(out.lineage.childGeneration, genomeParent.generation + 1);
  assert.ok(out.comparison.childScore > 0);
  assert.ok(out.comparison.parentScore > 0);
  assert.equal(typeof out.comparison.childBetter, 'boolean');

  // both orgs in the run (the parent AND the offspring)
  const run = await pr.benchmarkRun.findUnique({ where: { id: out.benchmarkRunId }, include: { reports: true } });
  assert.ok(run);
  const orgs = JSON.parse(run.organizations);
  assert.equal(orgs.length, 2);
  assert.ok(orgs.some((o) => o.pipelineId === genomeParent.id), 'the parent org is in the run');
  assert.ok(orgs.some((o) => o.pipelineId === out.childPipelineId), 'the offspring org is in the run');
  assert.equal(run.worldSeed, 42);
  assert.equal(run.reports.length, 2);
  for (const rep of run.reports) {
    const scores = JSON.parse(rep.scores);
    assert.equal(scores.coverage, 0.8, 'the offspring/parent distribution on seed 42');
    assert.ok(typeof rep.reproducible === 'boolean');
  }

  // the child row: lineage + deterministic genome
  const child = await pr.pipelineCandidate.findFirst({ where: { name: childName } });
  assert.ok(child, `the child row ${childName} exists`);
  assert.equal(child.parentId, genomeParent.id);
  assert.equal(child.generation, genomeParent.generation + 1);
  assert.equal(child.origin, 'searched');
  const childGenome = JSON.parse(child.genome);
  assert.ok(Array.isArray(childGenome.parameters.mutations) && childGenome.parameters.mutations.length > 0);
  assert.equal(childGenome.evaluation.seed, 42, 'the evaluation seed is preserved for comparability');

  // auto-draft iff the offspring won (both branches honest)
  if (out.comparison.childBetter) {
    assert.equal(out.childStatus, 'benchmarked', 'offspring won → auto-drafted');
    const draft = await pr.promotionRecord.findFirst({ where: { pipelineId: child.id, decision: 'drafted' } });
    assert.ok(draft, 'the auto-draft promotion record exists');
    assert.match(draft.decidedBy, /lab\.mutate executor/);
    const evidence = JSON.parse(draft.evidence);
    assert.equal(evidence.benchmarkRunId, out.benchmarkRunId);
  } else {
    assert.equal(out.childStatus, 'draft', 'offspring lost → stays draft');
    const draft = await pr.promotionRecord.findFirst({ where: { pipelineId: child.id, decision: 'drafted' } });
    assert.ok(!draft, 'no auto-draft when the parent still wins');
  }

  // natural-key reuse: a second job (different key, same seed) reuses the child
  const childCountBefore = await pr.pipelineCandidate.count({ where: { name: childName } });
  r = await call(`/api/v1/lab/pipelines/${genomeParent.id}/mutate`, {
    method: 'POST',
    body: { mutationSeed: 5, worldSeed: 42 },
    headers: { 'x-idempotency-key': `${idemKey}-2` },
  });
  assert.equal(r.status, 202);
  const job2 = await waitForJob(r.json.jobId);
  assert.equal(job2.status, 'succeeded');
  const childCountAfter = await pr.pipelineCandidate.count({ where: { name: childName } });
  assert.equal(childCountAfter, childCountBefore, 'same parent + same seed → the SAME child row (no duplicates)');

  // a different seed explores a different child
  r = await call(`/api/v1/lab/pipelines/${genomeParent.id}/mutate`, {
    method: 'POST',
    body: { mutationSeed: 6, worldSeed: 42 },
  });
  assert.equal(r.status, 202);
  const job3 = await waitForJob(r.json.jobId);
  assert.equal(job3.status, 'succeeded');
  assert.notEqual(job3.output.childName, childName, 'a different seed explores a different offspring');

  // a retired parent is refused
  const retireParent = await createTestPipeline(pr, { name: `lab-prod-retired-parent-${stamp}` });
  await call('/api/v1/lab/promotions', { method: 'POST', body: { pipelineId: retireParent.id, action: 'retire', reason: 'done' } });
  r = await call(`/api/v1/lab/pipelines/${retireParent.id}/mutate`, { method: 'POST', body: { mutationSeed: 1 } });
  assert.equal(r.status, 409);
  assert.match(r.json.error.message, /retired pipelines are not mutated/);
});

// ═══════════════════════════════════════════════════════════════════════════
// API — the Capture Scientist flow
// ═══════════════════════════════════════════════════════════════════════════
test('api: the scientist flow — 201 + the tenant-scoped queue + honest 400s', async () => {
  await login();
  const pr = await prisma();

  const mkFailure = (region, extraConditions = {}) => pr.failureCase.create({
    data: {
      benchmarkRunId: null,
      inputConditions: JSON.stringify({ region, worldSeed: 42, regionDifficulty: 0.6, simulated: true, ...extraConditions }),
      suspectedCause: `Region "${region}" stayed uncaptured in the seeded world.`,
      confidence: 0.75,
      remediation: 'Request targeted evidence and re-benchmark the mutated genome on the same seed.',
    },
  });

  // a mapped region → 201 with the derivation recorded
  const handsFailure = await mkFailure('hands');
  let r = await call(`/api/v1/lab/failures/${handsFailure.id}/evidence-request`, { method: 'POST', body: {} });
  assert.equal(r.status, 201, `scientist request → ${r.status}: ${r.text}`);
  assert.equal(r.json.capability, 'hands');
  assert.equal(r.json.source, 'lab');
  assert.equal(r.json.originFailureId, handsFailure.id);
  assert.equal(r.json.status, 'open');
  assert.match(r.json.instructions, /Suspected cause:/);
  assert.match(r.json.instructions, /Recorded remediation:/);
  assert.match(r.json.expectedSignal, /next benchmark/);

  // the mapping axes the report calls out
  for (const [region, capability] of [['teeth', 'face'], ['hair.back', 'hair'], ['walking', 'motion']]) {
    const f = await mkFailure(region);
    r = await call(`/api/v1/lab/failures/${f.id}/evidence-request`, { method: 'POST', body: {} });
    assert.equal(r.status, 201, `${region} → ${r.status}`);
    assert.equal(r.json.capability, capability, `${region} maps to ${capability}`);
  }

  // honest refusals
  const regionless = await pr.failureCase.create({
    data: {
      inputConditions: JSON.stringify({ worldSeed: 42 }),
      suspectedCause: 'A failure with no region recorded.',
      confidence: 0.5,
    },
  });
  r = await call(`/api/v1/lab/failures/${regionless.id}/evidence-request`, { method: 'POST', body: {} });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /no region/);

  const unmapped = await mkFailure('left-elbow');
  r = await call(`/api/v1/lab/failures/${unmapped.id}/evidence-request`, { method: 'POST', body: {} });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /unmapped region/);

  r = await call(`/api/v1/lab/failures/nope-${stamp}/evidence-request`, { method: 'POST', body: {} });
  assert.equal(r.status, 404);

  // the queue: tenant-scoped, newest first, status filter
  r = await call('/api/v1/lab/capture-requests');
  assert.equal(r.status, 200);
  const queue = r.json;
  assert.ok(queue.length >= 4, `the queue carries the derived requests (got ${queue.length})`);
  assert.ok(queue.every((x) => x.source === 'lab'));
  assert.ok(queue.some((x) => x.id === r.json[0].id));
  r = await call('/api/v1/lab/capture-requests?status=open');
  assert.equal(r.status, 200);
  assert.ok(r.json.every((x) => x.status === 'open'));
  // the route FILTERS (exact match); it does not validate a status
  // vocabulary — an unknown status matches nothing, honestly
  r = await call('/api/v1/lab/capture-requests?status=bogus');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, []);

  // the derived request rides the EXISTING B5 evidence-request surface
  r = await call('/api/v1/evidence-requests?status=open');
  assert.equal(r.status, 200);
  assert.ok(r.json.some((x) => x.originFailureId === handsFailure.id), 'the scientist request is visible on the B5 list too');
});

// ═══════════════════════════════════════════════════════════════════════════
// API — tenant isolation
// ═══════════════════════════════════════════════════════════════════════════
test('api: tenant isolation — the queue is tenant-scoped; the research plane is global (disclosed)', async () => {
  await login();
  const pr = await prisma();

  // seed a second tenant + user + session directly (the B3 seeding precedent)
  const tenantB = await pr.tenant.create({
    data: { slug: `lab-prod-iso-${stamp}`, name: `Lab-prod Isolation ${stamp}` },
  });
  const userB = await pr.user.create({
    data: { tenantId: tenantB.id, email: `lab-prod-${stamp}@example.test`, name: 'Lab-prod Isolation User' },
  });
  const sessionB = await pr.session.create({
    data: {
      userId: userB.id,
      token: `lab-prod-tok-${stamp}-${randomBytes(8).toString('hex')}`,
      expiresAt: new Date(Date.now() + 3600 * 1000),
    },
  });
  tenantBCookie = `you_session=${sessionB.token}`;

  // tenant B's scientist queue is EMPTY of tenant A's derived requests
  let r = await call('/api/v1/lab/capture-requests', { cookieOverride: tenantBCookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.length, 0, 'the queue is tenant-scoped — tenant B sees none of tenant A\'s requests');

  // the Lab research plane is GLOBAL by design (the existing model):
  // tenant B acts on promotions and is recorded verbatim in decidedBy
  const globalPipeline = await createTestPipeline(pr, { name: `lab-prod-global-${stamp}` });
  await seedRun(pr, { pipelineId: globalPipeline.id, orgId: `org-global-${stamp}` });
  r = await call('/api/v1/lab/promotions', {
    method: 'POST',
    body: { pipelineId: globalPipeline.id, action: 'promote' },
    cookieOverride: tenantBCookie,
  });
  assert.equal(r.status, 200, `the global research plane lets any authenticated operator act (disclosed design) → ${r.status}`);
  assert.match(r.json.promotion.decidedBy, /^user:/, 'the actor is recorded verbatim');

  // and the queue stays empty for B (the promotion wrote no request)
  r = await call('/api/v1/lab/capture-requests', { cookieOverride: tenantBCookie });
  assert.equal(r.json.length, 0);
});

// ─── lifecycle ───────────────────────────────────────────────────────────────
after(async () => {
  if (prismaClient) await prismaClient.$disconnect().catch(() => undefined);
  if (ownServer) {
    await killTree();
    if (child && child.pid) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    console.log('[lab-prod] own server stopped');
  }
});
