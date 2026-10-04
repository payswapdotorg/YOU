// ═══════════════════════════════════════════════════════════════════════════
// YOU cost/latency tests (P6.C12, Worker C lane) — node:test.
//
// Covers the five work-order deliverable surfaces:
//
// PURE UNIT half (imports the lib modules directly — Node ≥ 23.6 type
// stripping, same law as the compute-broker / deficiency-viz suites; no
// network, no db, no React):
//   1. ENV BUDGET PARSE — the explicit unlimited opt-in tokens; numeric
//      values; garbage/empty → the documented fail-closed default; "0" is a
//      valid operator choice. Unlimited is NEVER a default.
//   2. BUDGET ROW PICKING — specificity ranks (tenant,app,pipeline) >
//      (tenant,app) > (tenant,pipeline) > (tenant); out-of-scope rows never
//      match; invalid rows (negative/non-finite budget, non-positive period)
//      are skipped (a garbage row can never disable the guard); the
//      most-recent-updated row wins ties.
//   3. PURE GUARD DECISION — allow / exceed; ROUNDED-CENTS comparison
//      (0.04 + 0.01 vs a 0.05 budget must be ALLOWED — no float artifact
//      refusals); non-finite accounting → the distinct unverifiable refusal.
//   4. ACCRUAL AGGREGATION — per-pipeline / per-application breakdowns and
//      the day-bucketed usage-over-time series; malformed meta parses to
//      honest nulls (never guessed).
//   5. LATENCY RECORDER — nearestrank percentiles (real values only, null
//      when empty); breach counting against the declared target; the ring
//      buffer cap; counter keys; reset.
//   6. OPTIMIZATION EVIDENCE WIRING (pure) — extractCostLatency tolerates
//      pre-C12/malformed metrics; pairOptimizationEvidence pairs
//      sequential-vs-parallel and cold-vs-warm runs by seed, cites only run
//      ids that were passed in, and renders honest empty states without
//      pairs.
//   7. HOT-PATH CACHE — content-hash keys; same object identity on hit;
//      mutated genome → a different key (never a stale compile); hit/miss
//      counters.
//
// API half (boots/reuses the shared app server like the B6 suite; no network
// beyond 127.0.0.1 + the in-pod z-ai provider the lab benchmark already
// uses):
//   8.  usage API — anonymous 401; the cost section with the fail-closed
//       default budget (source "default", $50, rolling 24h) on a clean
//       tenant; the optimizations section present.
//   9.  budget enforcement (db row, fail-fast) — a pipeline-scoped CostBudget
//       row below the quote refuses POST /renders with the typed 402
//       compute_quota_exceeded envelope (details cite the db source) BEFORE
//       dispatch (no durable job row), and the RenderJob row is marked
//       failed (never queued-forever).
//   10. accrual + second-refusal + usage breakdown — a tenant-wide row at
//       $0.04: first ai-image-1 submit (quote $0.04) → 202 + a
//       compute.quoted_usd accrual row visible in GET /api/v1/usage
//       (byPipeline render.image); second submit → 402 (accrued + quote >
//       budget).
//   11. rolling-window reset — accrual rows older than the row's period are
//       not counted (backdated rows + a 1h period → the submit is allowed).
//   12. tenant isolation — a Prisma-seeded second tenant (API key) sees its
//       OWN empty cost section (accrued 0, no pipelines), never tenant A's.
//   13. metrics latency surface — the three declared SLOs with their
//       targets; real observations recorded under api.read with the
//       middleware-issued x-request-id (request-id correlation proof); p50
//       and p95 are real observed numbers (or honest nulls); breach
//       counters present in the counters view.
//   14. optimization evidence wiring (e2e) — two REAL lab runs on the same
//       seed (evaluationMode sequential then parallel) produce the
//       before/after evidence records in GET /usage; every cited run-id
//       resolves to a real BenchmarkRun row; parallel wall-clock ≤
//       sequential; per-org coverage/confidence are IDENTICAL across modes
//       (the optimization changes wall-clock, never scores); the first run
//       is cache-cold and the second cache-warm (the cache evidence pair).
//
// Server lifecycle: lazily boots its own `next dev` on a free port, or reuses
// the sibling suite's server when aggregated (tests/contract/index.mjs sets
// __YOU_TEST_AGGREGATED__ / publishes __YOU_TEST_BASE__) — same law as the
// B6 suite.
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
  BUDGET_METRIC,
  DEFAULT_BUDGET_USD,
  applicationUsage,
  accrualSumUsd,
  budgetConfigFromRow,
  budgetGuardDecision,
  budgetRowRank,
  parseAccrualMeta,
  parseEnvBudget,
  pickBudgetRow,
  pipelineUsage,
  usageOverTime,
} from '../../apps/web/src/lib/you/lab/cost-budgets.ts';
import {
  MAX_OBSERVATIONS,
  SLO_DECLARATIONS,
  latencySnapshot,
  nearestRankPercentile,
  recordLatency,
  resetLatencyForTests,
  sloBreachCounters,
} from '../../apps/web/src/lib/you/core/latency.ts';
import {
  OPTIMIZATION_CATALOG,
  extractCostLatency,
  pairOptimizationEvidence,
} from '../../apps/web/src/lib/you/lab/optimization-evidence.ts';
import {
  cachedCompileOrganizations,
  cachedGenerateWorld,
  resetHotPathCacheForTests,
} from '../../apps/web/src/lib/you/lab/hot-path-cache.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const APP_DIR = path.join(REPO_ROOT, 'apps', 'web');

const stamp = `${Date.now()}-${process.pid}`;
const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// ═══════════════════════════════════════════════════════════════════════════
// PURE UNIT half
// ═══════════════════════════════════════════════════════════════════════════

// ─── 1. env budget parse ────────────────────────────────────────────────────

test('budget pure: env parse — unlimited is an EXPLICIT opt-in, never a default', () => {
  // unset / empty / garbage → the documented fail-closed default
  for (const raw of [undefined, '', '  ', 'not-a-number', '-5', 'NaN']) {
    const cfg = parseEnvBudget(raw);
    assert.equal(cfg.mode, 'limited', `raw ${JSON.stringify(raw)} must NOT be unlimited`);
    assert.equal(cfg.source, 'default', `raw ${JSON.stringify(raw)} → default source`);
    assert.equal(cfg.budgetUsd, DEFAULT_BUDGET_USD, `raw ${JSON.stringify(raw)} → $${DEFAULT_BUDGET_USD} default`);
  }
  // numeric values are honored (including the explicit 0)
  assert.deepEqual(
    { mode: parseEnvBudget('0').mode, budgetUsd: parseEnvBudget('0').budgetUsd },
    { mode: 'limited', budgetUsd: 0 },
    '"0" is a VALID operator choice (block all paid work)',
  );
  assert.equal(parseEnvBudget('12.5').budgetUsd, 12.5);
  assert.equal(parseEnvBudget('12.5').source, 'env');
  // the unlimited tokens — the ONLY opt-out, case-insensitive, trimmed
  for (const token of ['unlimited', 'UNLIMITED', ' none ', 'off']) {
    const cfg = parseEnvBudget(token);
    assert.equal(cfg.mode, 'unlimited', `token ${JSON.stringify(token)} is the explicit opt-in`);
    assert.equal(cfg.budgetUsd, null);
  }
});

// ─── 2. budget row picking ──────────────────────────────────────────────────

const scope = { tenantId: 't1', applicationId: 'app1', workload: 'render.image' };

function row(overrides = {}) {
  return {
    id: `row-${Math.random().toString(36).slice(2, 8)}`,
    applicationId: null,
    pipeline: null,
    budgetUsd: 1,
    periodHours: 24,
    note: null,
    updatedAt: new Date('2026-10-04T00:00:00Z'),
    ...overrides,
  };
}

test('budget pure: row specificity — (tenant,app,pipeline) > (tenant,app) > (tenant,pipeline) > (tenant)', () => {
  const tenantWide = row({ budgetUsd: 40, updatedAt: new Date('2026-10-04T00:00:03Z') });
  const pipelineOnly = row({ pipeline: 'render.image', budgetUsd: 30 });
  const appOnly = row({ applicationId: 'app1', budgetUsd: 20 });
  const appPipeline = row({ applicationId: 'app1', pipeline: 'render.image', budgetUsd: 10 });
  const picked = pickBudgetRow([tenantWide, pipelineOnly, appOnly, appPipeline], scope);
  assert.equal(picked.budgetUsd, 10, 'the most specific row wins');
  assert.equal(budgetConfigFromRow(appPipeline).source, 'db:application+pipeline');
  assert.equal(budgetConfigFromRow(appOnly).source, 'db:application');
  assert.equal(budgetConfigFromRow(pipelineOnly).source, 'db:pipeline');
  assert.equal(budgetConfigFromRow(tenantWide).source, 'db:tenant');
  // ranks
  assert.equal(budgetRowRank(appPipeline, scope), 3);
  assert.equal(budgetRowRank(appOnly, scope), 2);
  assert.equal(budgetRowRank(pipelineOnly, scope), 1);
  assert.equal(budgetRowRank(tenantWide, scope), 0);
  // out-of-scope rows never match
  assert.equal(budgetRowRank(row({ applicationId: 'other-app' }), scope), -1, 'a different application never matches');
  assert.equal(budgetRowRank(row({ pipeline: 'render.video' }), scope), -1, 'a different pipeline never matches');
});

test('budget pure: invalid rows are skipped — a garbage row can never disable the guard', () => {
  const bad = [
    row({ budgetUsd: -1 }), // negative
    row({ budgetUsd: Number.NaN }), // non-finite
    row({ budgetUsd: Number.POSITIVE_INFINITY }),
    row({ periodHours: 0 }), // non-positive period
    row({ periodHours: -24 }),
  ];
  assert.equal(pickBudgetRow(bad, scope), null, 'every invalid row is skipped');
  // a valid tenant-wide row still wins when the app+pipeline row is invalid
  const good = row({ budgetUsd: 5 });
  const picked = pickBudgetRow([bad[0], good], scope);
  assert.equal(picked?.budgetUsd, 5);
  // ties break to the most recently updated row (deterministic)
  const a = row({ budgetUsd: 7, updatedAt: new Date('2026-10-04T00:00:01Z') });
  const b = row({ budgetUsd: 8, updatedAt: new Date('2026-10-04T00:00:02Z') });
  assert.equal(pickBudgetRow([a, b], scope)?.budgetUsd, 8, 'most recent update wins the tie');
});

// ─── 3. pure guard decision ─────────────────────────────────────────────────

function limitedConfig(overrides = {}) {
  return {
    source: 'db:tenant',
    mode: 'limited',
    budgetUsd: 1,
    periodHours: 24,
    applicationId: null,
    pipeline: null,
    note: 'test',
    ...overrides,
  };
}

test('budget pure: guard decision — cents-rounded comparison, fail-closed on broken accounting', () => {
  // allowed
  const ok = budgetGuardDecision({ config: limitedConfig({ budgetUsd: 0.05 }), accruedUsd: 0.04, quotedUsd: 0.01, workload: 'render.image' });
  assert.equal(ok.allowed, true, '0.04 + 0.01 vs 0.05 must be ALLOWED (no float-artifact refusal)');
  assert.equal(ok.remainingUsd, 0.01, 'remaining = budget − accrued (pre-quote state, cents-rounded: 5−4=1 cent)');
  assert.equal(ok.refusal, null);

  // exceeded → the typed refusal with scope details
  const over = budgetGuardDecision({ config: limitedConfig({ budgetUsd: 0.05, source: 'db:pipeline', pipeline: 'render.image' }), accruedUsd: 0.04, quotedUsd: 0.02, workload: 'render.image', providerId: 'local-executor' });
  assert.equal(over.allowed, false);
  assert.equal(over.refusal.code, 'compute_quota_exceeded');
  assert.match(over.refusal.message, /cost budget exceeded/);
  assert.equal(over.refusal.details.budgetSource, 'db:pipeline');
  assert.equal(over.refusal.details.accruedUsd, 0.04);
  assert.equal(over.refusal.details.quotedUsd, 0.02);
  assert.match(String(over.refusal.details.basis), /^modeled/);

  // non-finite accounting → the DISTINCT unverifiable refusal (never guessed)
  const broken = budgetGuardDecision({ config: limitedConfig(), accruedUsd: Number.NaN, quotedUsd: 0.02, workload: 'render.image' });
  assert.equal(broken.allowed, false);
  assert.equal(broken.refusal.code, 'compute_quota_unverifiable');

  // unlimited config never refuses
  const unlimited = budgetGuardDecision({ config: { source: 'env', mode: 'unlimited', budgetUsd: null, periodHours: 24, applicationId: null, pipeline: null, note: 'x' }, accruedUsd: 999, quotedUsd: 999, workload: 'render.image' });
  assert.equal(unlimited.allowed, true);

  // budget 0 blocks paid work but zero-cost work still passes
  const zeroPaid = budgetGuardDecision({ config: limitedConfig({ budgetUsd: 0 }), accruedUsd: 0, quotedUsd: 0.04, workload: 'render.image' });
  assert.equal(zeroPaid.allowed, false, 'a $0 budget blocks all paid work');
  const zeroFree = budgetGuardDecision({ config: limitedConfig({ budgetUsd: 0 }), accruedUsd: 0, quotedUsd: 0, workload: 'render.image' });
  assert.equal(zeroFree.allowed, true, 'zero-cost deterministic work still passes a $0 budget');
});

// ─── 4. accrual aggregation ─────────────────────────────────────────────────

test('budget pure: accrual aggregation — per pipeline / per application / over time', () => {
  const d = (iso) => new Date(iso);
  const rows = [
    { quantity: 0.04, createdAt: d('2026-10-03T10:00:00Z'), workload: 'render.image', applicationActorId: null, jobId: 'j1' },
    { quantity: 0.04, createdAt: d('2026-10-03T11:00:00Z'), workload: 'render.image', applicationActorId: 'key1', jobId: 'j2' },
    { quantity: 0.02, createdAt: d('2026-10-04T09:00:00Z'), workload: 'twin.compile', applicationActorId: 'key1', jobId: 'j3' },
    { quantity: Number.NaN, createdAt: d('2026-10-04T09:30:00Z'), workload: null, applicationActorId: null, jobId: 'j4' },
  ];
  assert.equal(accrualSumUsd(rows), 0.1, 'non-finite quantities are ignored, the rest summed (cents-rounded)');
  const byPipeline = pipelineUsage(rows);
  assert.deepEqual(
    byPipeline.map((p) => p.pipeline),
    ['render.image', 'twin.compile', 'unknown'],
    'pipelines sorted by quoted USD desc; null workload → honest "unknown"',
  );
  assert.equal(byPipeline[0].quotedUsd, 0.08);
  assert.equal(byPipeline[0].submits, 2);
  const byApp = applicationUsage(rows);
  assert.equal(byApp.find((a) => a.applicationActorId === 'key1')?.quotedUsd, 0.06);
  assert.equal(byApp.find((a) => a.applicationActorId === null)?.quotedUsd, 0.04);
  // day-bucketed series (UTC days, bounded window, oldest first)
  const series = usageOverTime(rows, 3);
  assert.equal(series.length, 3);
  assert.equal(series[0].day, new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - 2 * 86400000).toISOString().slice(0, 10));
  // malformed meta → honest nulls
  assert.deepEqual(parseAccrualMeta('{"workload": "render.image", "jobId": "j9"'), { workload: null, applicationActorId: null, jobId: null });
  assert.deepEqual(parseAccrualMeta(null), { workload: null, applicationActorId: null, jobId: null });
  assert.deepEqual(parseAccrualMeta('{"workload": 42}'), { workload: null, applicationActorId: null, jobId: null });
});

// ─── 5. latency recorder + percentiles ─────────────────────────────────────

test('latency pure: nearest-rank percentiles are REAL observed values only', () => {
  assert.equal(nearestRankPercentile([], 50), null, 'no observations → null (unknown is unknown)');
  assert.equal(nearestRankPercentile([1, 2, 3, 4], 0), null, 'p=0 is invalid → null');
  assert.equal(nearestRankPercentile([1, 2, 3, 4], 101), null, 'p>100 is invalid → null');
  assert.equal(nearestRankPercentile([10], 50), 10);
  // nearest-rank: ceil(p/100 * n)-th value — NO interpolation
  assert.equal(nearestRankPercentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 50), 50);
  assert.equal(nearestRankPercentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 95), 100);
  assert.equal(nearestRankPercentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 90), 90);
});

test('latency pure: recorder — observations, breach counting, ring-buffer cap, reset', () => {
  resetLatencyForTests();
  // three declared SLOs with the documented targets
  assert.deepEqual(
    SLO_DECLARATIONS.map((s) => [s.id, s.targetP95Ms]),
    [['api.read', 250], ['live.session.setup', 200], ['live.state.stream', 100]],
  );

  // no observations → honest nulls
  let snap = latencySnapshot();
  const apiRead = snap.slos.find((s) => s.id === 'api.read');
  assert.equal(apiRead.observations, 0);
  assert.equal(apiRead.p50Ms, null);
  assert.equal(apiRead.p95Ms, null);
  assert.equal(apiRead.breaches, 0);
  assert.equal(apiRead.lastObservation, null);

  // record under-target observations (no breach)
  for (let i = 1; i <= 10; i += 1) {
    recordLatency('api.read', { requestId: `req-${i}`, route: 'GET /api/v1/twins', method: 'GET', status: 200, durationMs: i * 10 });
  }
  // record one over-target observation (a breach)
  recordLatency('api.read', { requestId: 'req-breach', route: 'GET /api/v1/twins', method: 'GET', status: 200, durationMs: 251 });

  snap = latencySnapshot();
  const read = snap.slos.find((s) => s.id === 'api.read');
  assert.equal(read.observations, 11);
  assert.equal(read.totalObservations, 11);
  assert.equal(read.breaches, 1, 'exactly one over-target duration counted as a breach');
  assert.equal(read.p50Ms, 60, 'p50 = the 6th of 11 sorted values (nearest-rank: ceil(0.5×11)=6 → 60)');
  assert.equal(read.p95Ms, 251, 'p95 = the 11th of 11 sorted values — the real breach value');
  assert.equal(read.lastObservation.requestId, 'req-breach');
  assert.equal(read.lastObservation.route, 'GET /api/v1/twins');

  // the breach counters use the canonical counter-key form
  const counters = sloBreachCounters();
  assert.equal(counters['slo_breaches{bucket=api.read}'], 1);
  assert.equal(counters['slo_breaches{bucket=live.session.setup}'], 0);

  // ring-buffer cap: only the last MAX_OBSERVATIONS stay resident, the
  // lifetime counters keep growing
  for (let i = 0; i < MAX_OBSERVATIONS + 20; i += 1) {
    recordLatency('api.read', { requestId: `flood-${i}`, route: 'GET /api/v1/usage', method: 'GET', status: 200, durationMs: 5 });
  }
  snap = latencySnapshot();
  const capped = snap.slos.find((s) => s.id === 'api.read');
  assert.equal(capped.observations, MAX_OBSERVATIONS, 'the ring buffer is capped');
  assert.equal(capped.totalObservations, 11 + MAX_OBSERVATIONS + 20, 'the lifetime counter is NOT capped');
  assert.equal(capped.lastObservation.requestId, `flood-${MAX_OBSERVATIONS + 19}`);

  resetLatencyForTests();
  snap = latencySnapshot();
  assert.equal(snap.slos.find((s) => s.id === 'api.read').observations, 0);
  assert.equal(snap.slos.find((s) => s.id === 'api.read').totalObservations, 0);
});

// ─── 6. optimization evidence wiring (pure) ─────────────────────────────────

function clMetrics(mode, wallClockMs, opts = {}) {
  return JSON.stringify({
    aggregate: { bestOrganizationId: 'x' },
    costLatency: {
      evaluation: { mode, wallClockMs, perOrgLatencyMs: [100, 200, 300] },
      compile: {
        worldKey: opts.worldKey ?? 'wk',
        worldCacheHit: opts.worldCacheHit ?? false,
        orgKey: opts.orgKey ?? 'ok',
        orgCacheHit: opts.orgCacheHit ?? false,
        cacheHits: opts.cacheHits ?? 0,
        cacheMisses: opts.cacheMisses ?? 2,
        worldCompileMs: opts.worldCompileMs ?? 1,
      },
      optimizationVersion: 'p6/c12',
    },
  });
}

test('optimization pure: extract + pairing — cited ids only, honest empty states', () => {
  // pre-C12 / malformed metrics never fabricate evidence
  assert.equal(extractCostLatency(null), null);
  assert.equal(extractCostLatency('{}'), null);
  assert.equal(extractCostLatency('{"aggregate":{}}'), null);
  assert.equal(extractCostLatency('not json'), null);
  assert.equal(extractCostLatency(clMetrics('weird-mode', 5)), null);

  // no runs at all → every optimization renders an honest empty state
  let views = pairOptimizationEvidence([]);
  assert.equal(views.length, OPTIMIZATION_CATALOG.length);
  for (const v of views) {
    assert.equal(v.evidence, null);
    assert.ok(v.emptyStateReason.length > 0, `${v.id} carries a non-empty empty-state reason`);
  }

  // a sequential + a parallel run on the SAME seed pair up; different seeds don't
  const t0 = '2026-10-04T10:00:00Z';
  const t1 = '2026-10-04T10:01:00Z';
  const seq = { id: 'run_seq', worldSeed: 42, metrics: clMetrics('sequential', 9000), createdAt: new Date(t0) };
  const par = { id: 'run_par', worldSeed: 42, metrics: clMetrics('parallel', 3000), createdAt: new Date(t1) };
  const otherSeed = { id: 'run_other', worldSeed: 7, metrics: clMetrics('parallel', 100), createdAt: new Date(t1) };
  views = pairOptimizationEvidence([par, seq, otherSeed]);
  const parallelView = views.find((v) => v.id === 'parallel-org-evaluation');
  assert.ok(parallelView.evidence, 'same-seed sequential + parallel pair up');
  assert.equal(parallelView.evidence.before.runId, 'run_seq');
  assert.equal(parallelView.evidence.after.runId, 'run_par');
  assert.equal(parallelView.evidence.before.mode, 'sequential');
  assert.equal(parallelView.evidence.after.mode, 'parallel');
  assert.equal(parallelView.evidence.deltaMs, -6000);
  assert.equal(parallelView.evidence.improvementPct, 66.7);
  assert.match(parallelView.evidence.basis, /run_seq/);
  assert.match(parallelView.evidence.basis, /run_par/);
  // different seed alone does NOT pair
  const noPair = pairOptimizationEvidence([otherSeed]);
  assert.equal(noPair.find((v) => v.id === 'parallel-org-evaluation').evidence, null);

  // cold + warm on the same seed pair the cache optimization
  const cold = { id: 'run_cold', worldSeed: 42, metrics: clMetrics('parallel', 3000, { worldCacheHit: false, orgCacheHit: false, cacheHits: 0, cacheMisses: 2 }), createdAt: new Date(t0) };
  const warm = { id: 'run_warm', worldSeed: 42, metrics: clMetrics('parallel', 2990, { worldCacheHit: true, orgCacheHit: true, cacheHits: 2, cacheMisses: 2 }), createdAt: new Date(t1) };
  views = pairOptimizationEvidence([warm, cold]);
  const cacheView = views.find((v) => v.id === 'deterministic-subresult-cache');
  assert.ok(cacheView.evidence, 'cold + warm runs on the same seed pair the cache evidence');
  assert.equal(cacheView.evidence.before.runId, 'run_cold');
  assert.equal(cacheView.evidence.after.runId, 'run_warm');

  // the LATEST parallel run wins when several exist
  const par2 = { id: 'run_par2', worldSeed: 42, metrics: clMetrics('parallel', 2500), createdAt: new Date('2026-10-04T10:05:00Z') };
  views = pairOptimizationEvidence([par, par2, seq]);
  assert.equal(views.find((v) => v.id === 'parallel-org-evaluation').evidence.after.runId, 'run_par2');
});

// ─── 7. hot-path cache ──────────────────────────────────────────────────────

test('cache pure: content-hash keys — same input hits, mutated genome misses', () => {
  resetHotPathCacheForTests();
  const seed = 424242;
  // the compute function is INJECTED (test double — the module stays
  // zero-import so node:test can load it; see the module header)
  const worlds = new Map();
  const computeWorld = (s) => {
    if (!worlds.has(s)) worlds.set(s, { worldId: `world-${s}`, seed: s });
    return worlds.get(s);
  };
  const first = cachedGenerateWorld(seed, computeWorld);
  assert.equal(first.cache.hit, false, 'the first call is a miss');
  assert.equal(first.cache.misses, 1);
  const second = cachedGenerateWorld(seed, computeWorld);
  assert.equal(second.cache.hit, true, 'the same seed hits');
  assert.equal(second.cache.hits, 1);
  assert.equal(second.cache.key, first.cache.key, 'the content key is stable for the same seed');
  assert.strictEqual(second.world, first.world, 'a hit returns the EXACT same object (semantically transparent)');
  const otherSeed = cachedGenerateWorld(seed + 1, computeWorld);
  assert.equal(otherSeed.cache.hit, false, 'a different seed is a different key');
  assert.notStrictEqual(otherSeed.world, first.world);

  const genome = (adapterId, params) => ({
    stages: [{ adapterId, version: '1', params }],
    parameters: {}, skills: [], soulKey: 'soul-one-fast',
    compute: { class: 'serverless-cpu' }, evaluation: { rubric: [], seed: 42 },
  });
  const pipelines = () => ({
    generalist: { id: 'p-gen', name: 'generalist', genome: genome('vlm-recon-1', { singlePass: true }) },
    handDesigned: { id: 'p-hand', name: 'hand', genome: genome('lab-segment-1', {}) },
    searched: { id: 'p-search', name: 'searched', genome: genome('lab-qa-1', { role: 'fallback' }) },
  });
  const compiles = new Map();
  const computeOrgs = (s, p) => {
    const k = `${s}:${JSON.stringify(p.searched.genome)}`; // the double keys on CONTENT — like the real compile
    if (!compiles.has(k)) compiles.set(k, [{ organizationId: `org-${s}-${p.searched.id}` }]);
    return compiles.get(k);
  };
  const cold = cachedCompileOrganizations(seed, pipelines(), computeOrgs);
  assert.equal(cold.cache.hit, false);
  const warm = cachedCompileOrganizations(seed, pipelines(), computeOrgs);
  assert.equal(warm.cache.hit, true, 'equal genomes (fresh objects, same content) hit — the key is content, not identity');
  assert.strictEqual(warm.organizations, cold.organizations);
  // a MUTATED genome compiles under a DIFFERENT key — never a stale compile
  const mutated = pipelines();
  mutated.searched.genome.stages[0].params.role = 'primary';
  const other = cachedCompileOrganizations(seed, mutated, computeOrgs);
  assert.equal(other.cache.hit, false, 'mutated genome → a different content key');
  assert.notStrictEqual(other.organizations, cold.organizations);
  resetHotPathCacheForTests();
});

// ═══════════════════════════════════════════════════════════════════════════
// API half — boots/reuses the shared app server (same law as the B6 suite)
// ═══════════════════════════════════════════════════════════════════════════

let base = process.env.YOU_TEST_BASE ?? null;
let ownServer = false;
let child = null;
let basePromise = null;
let prismaClient = null;
let cookie = null;
let demoTenantId = null;
let twinRow = null;           // { id, subjectId, versionId }
let foreignKey = null;        // tenant-B API key secret
let budgetRowIds = [];        // CostBudget rows this suite created (cleanup)

function call(pathname, opts = {}) {
  const h = { ...(opts.headers ?? {}) };
  if (cookie && !h.authorization) h.cookie = cookie;
  if (h.authorization) delete h.cookie;
  let payload;
  if (opts.body !== undefined) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(opts.body);
  }
  return fetch(base + pathname, { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers: h, body: payload }).then(async (res) => {
    const setCookie = res.headers.get('set-cookie');
    if (setCookie && !h.authorization) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: res.status, json, text };
  });
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
      if (base) return base;
      const aggregated = !!globalThis.__YOU_TEST_AGGREGATED__;
      const deadline = Date.now() + (aggregated ? 150000 : 5000);
      while (Date.now() < deadline) {
        if (globalThis.__YOU_TEST_BASE__) {
          base = globalThis.__YOU_TEST_BASE__;
          console.log(`[c12-tests] reusing suite server at ${base}`);
          return base;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(!aggregated, 'aggregated run: the sibling suite never published its server URL within 150s');
      console.log('[c12-tests] booting apps/web (next dev) on a free port…');
      await startServer();
      ownServer = true;
      console.log(`[c12-tests] server ready at ${base}`);
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
  if (prismaClient) {
    // suite hygiene: drop the CostBudget rows this suite created (the demo
    // tenant keeps behaving fail-closed-default for the sibling suites)
    try { await prismaClient.costBudget.deleteMany({ where: { id: { in: budgetRowIds } } }); } catch { /* best effort */ }
    await prismaClient.$disconnect().catch(() => undefined);
  }
  if (ownServer) {
    await killTree();
    if (child && child.pid) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    console.log('[c12-tests] own server stopped');
  }
});

/** boot the demo session + seed a minimal twin/version/consent for renders */
async function ensureRenderFixture() {
  if (twinRow) return twinRow;
  await ensureBase();
  const db = await prisma();
  const session = await call('/api/v1/session', { method: 'POST', body: {} });
  assert.ok([200, 201].includes(session.status), `demo session bootstrap → ${session.status}`);
  demoTenantId = session.json.tenant.id;

  const slug = `c12-${stamp}`;
  const subjectId = `c12-subj-${stamp}`;
  const twin = await db.twin.create({
    data: { tenantId: demoTenantId, displayName: `C12 twin ${stamp}`, subjectId, status: 'ready' },
  });
  const version = await db.twinVersion.create({
    data: {
      twinId: twin.id,
      version: 1,
      status: 'published',
      htir: JSON.stringify({ note: 'c12 budget fixture — minimal HTIR stand-in (the renders route only validates existence)' }),
      confidenceSummary: JSON.stringify({ overall: 0.5 }),
    },
  });
  const grant = await db.consentGrant.create({
    data: {
      tenantId: demoTenantId,
      subjectId,
      granteeId: demoTenantId,
      purpose: `c12 cost-budget enforcement ${stamp}`,
      scopes: JSON.stringify(['render']),
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    },
  });
  twinRow = { id: twin.id, subjectId, versionId: version.id, grantId: grant.id };
  return twinRow;
}

function postRender(extra = {}) {
  assert.ok(twinRow, 'render fixture must exist');
  return call('/api/v1/renders', {
    method: 'POST',
    body: {
      twinId: twinRow.id,
      twinVersionId: twinRow.versionId,
      kind: 'image',
      style: 'stylized-portrait',
      adapter: 'ai-image-1', // $0.04 modeled quote on local-executor
      ...extra,
    },
  });
}

// ─── 8. usage API — auth + the fail-closed default budget shape ─────────────

test('usage api: anonymous 401; cost section shows the fail-closed default on a clean tenant', async () => {
  await ensureBase();
  const anon = await fetch(`${base}/api/v1/usage`);
  assert.equal(anon.status, 401, `anonymous usage → ${anon.status}`);

  const session = await call('/api/v1/session', { method: 'POST', body: {} });
  assert.ok([200, 201].includes(session.status), `demo session bootstrap → ${session.status}`);
  demoTenantId = session.json.tenant.id;

  // SUITE HYGIENE (idempotent re-runs against the persistent station DB):
  // drop the demo tenant's quoted-cost accrual rows left by previous runs of
  // THIS suite — the budget tests below need a deterministic accrued state.
  // The metric is new in P6.C12 and only broker submits write it; sibling
  // suites' zero-cost svg accruals are recreated by their own runs.
  {
    const db = await prisma();
    await db.usageRecord.deleteMany({ where: { tenantId: demoTenantId, metric: BUDGET_METRIC } });
    await db.costBudget.deleteMany({ where: { tenantId: demoTenantId } });
  }

  const usage = await call('/api/v1/usage');
  assert.equal(usage.status, 200);
  // legacy shape unchanged
  assert.ok(Array.isArray(usage.json.metrics), 'legacy metrics array intact');
  assert.ok(usage.json.totals && typeof usage.json.totals.jobs === 'number', 'legacy totals intact');
  // P6.C12 sections present
  assert.ok(usage.json.cost, 'the cost section is present');
  const cost = usage.json.cost;
  assert.equal(cost.accrualMetric, BUDGET_METRIC);
  // no db rows, no env on the shared server → the documented fail-closed default
  assert.equal(cost.budget.mode, 'limited');
  assert.equal(cost.budget.source, 'default');
  assert.equal(cost.budget.budgetUsd, DEFAULT_BUDGET_USD);
  assert.equal(cost.budget.periodHours, 24);
  assert.equal(cost.budget.remainingUsd, DEFAULT_BUDGET_USD - cost.budget.accruedUsd);
  assert.match(cost.basis, /^modeled/);
  assert.ok(Array.isArray(cost.byPipeline), 'byPipeline breakdown present');
  assert.ok(Array.isArray(cost.byApplication), 'byApplication breakdown present');
  assert.ok(Array.isArray(cost.series) && cost.series.length === 14, 'the 14-day usage-over-time series is present');
  assert.ok(Array.isArray(usage.json.optimizations), 'the optimizations section is present');
});

// ─── 9. budget enforcement — db row, fail-fast BEFORE dispatch ──────────────

test('budget api: pipeline-scoped db row below the quote refuses the submit (402, typed, pre-dispatch)', async () => {
  await ensureRenderFixture();
  const db = await prisma();
  // clean slate for this tenant's budget rows
  await db.costBudget.deleteMany({ where: { tenantId: demoTenantId } });
  const below = await db.costBudget.create({
    data: { tenantId: demoTenantId, pipeline: 'render.image', budgetUsd: 0.03, periodHours: 24, note: 'c12 below-quote row' },
  });
  budgetRowIds.push(below.id);

  const refused = await postRender();
  assert.equal(refused.status, 402, `over-budget submit → ${refused.status}`);
  assert.equal(refused.json.error.code, 'compute_quota_exceeded');
  assert.equal(refused.json.error.details.budgetSource, 'db:pipeline');
  assert.equal(refused.json.error.details.budgetUsd, 0.03);
  assert.equal(refused.json.error.details.quotedUsd, 0.04);
  assert.equal(refused.json.error.details.accruedUsd, 0);
  assert.match(String(refused.json.error.details.basis), /^modeled/);

  // FAIL-FAST, BEFORE DISPATCH: no durable broker job row was created for the
  // refused submit (the RenderJob id never appears in any Job input).
  // Scoped to THIS suite's fixture twin — sibling suites render on their own twins.
  const renderJobs = await db.renderJob.findMany({ where: { tenantId: demoTenantId, twinId: twinRow.id }, orderBy: { createdAt: 'desc' }, take: 1 });
  assert.ok(renderJobs[0], 'the RenderJob row exists (created before the broker call)');
  const refusedRenderJobId = renderJobs[0].id;
  const jobsForRefusedRender = await db.job.count({
    where: { tenantId: demoTenantId, input: { contains: refusedRenderJobId } },
  });
  assert.equal(jobsForRefusedRender, 0, 'the refused submit created NO durable job (fail-fast, before dispatch)');

  // the RenderJob row is marked failed with the verbatim refusal (never queued-forever)
  assert.equal(renderJobs[0].status, 'failed', 'the refused render is marked failed');
  assert.match(renderJobs[0].error ?? '', /cost budget exceeded/);

  // cleanup: drop the below-budget row
  await db.costBudget.delete({ where: { id: below.id } }).catch(() => undefined);
});

// ─── 10. accrual + second-refusal + usage breakdown ─────────────────────────

test('budget api: accrual is visible in usage; the second submit crosses the tenant-wide budget', async () => {
  await ensureRenderFixture();
  const db = await prisma();
  await db.costBudget.deleteMany({ where: { tenantId: demoTenantId } });
  const tight = await db.costBudget.create({
    data: { tenantId: demoTenantId, budgetUsd: 0.04, periodHours: 24, note: 'c12 tenant-wide tight row' },
  });
  budgetRowIds.push(tight.id);

  // first submit: accrued 0 + quote 0.04 <= 0.04 → accepted
  const first = await postRender();
  assert.equal(first.status, 202, `first submit → ${first.status} (${first.text.slice(0, 200)})`);

  // the accrual row exists (the durable per-pipeline usage truth) — scoped to
  // THIS submit's job id (sibling suites' zero-cost renders accrue too)
  const accrual = await db.usageRecord.findFirst({
    where: { tenantId: demoTenantId, metric: BUDGET_METRIC, meta: { contains: first.json.jobId } },
  });
  assert.ok(accrual, 'the compute.quoted_usd accrual row exists');
  assert.equal(accrual.quantity, 0.04);
  const meta = JSON.parse(accrual.meta);
  assert.equal(meta.workload, 'render.image');
  assert.equal(meta.providerId, 'local-executor');
  assert.equal(meta.jobId, first.json.jobId, 'the accrual cites the durable job id');
  assert.equal(meta.applicationActorId, null, 'an interactive session accrues tenant-wide (application null)');

  // the usage surface reports it (per-pipeline breakdown)
  const usage = await call('/api/v1/usage');
  assert.equal(usage.status, 200);
  const renderImage = usage.json.cost.byPipeline.find((p) => p.pipeline === 'render.image');
  assert.ok(renderImage, 'render.image appears in the per-pipeline breakdown');
  assert.ok(renderImage.quotedUsd >= 0.04, `quotedUsd ${renderImage.quotedUsd} >= the accepted submit's 0.04`);
  assert.ok(renderImage.submits >= 1);
  assert.ok(usage.json.cost.budget.accruedUsd >= 0.04, `accruedUsd ${usage.json.cost.budget.accruedUsd} >= 0.04`);
  assert.equal(usage.json.cost.budget.source, 'db:tenant', 'the tenant-wide row is the budget shown');
  assert.equal(usage.json.cost.budget.budgetUsd, 0.04);

  // second submit: accrued 0.04 + quote 0.04 > 0.04 → refused
  const second = await postRender();
  assert.equal(second.status, 402, `second submit → ${second.status}`);
  assert.equal(second.json.error.code, 'compute_quota_exceeded');
  assert.equal(second.json.error.details.accruedUsd >= 0.04, true);
  assert.equal(second.json.error.details.budgetSource, 'db:tenant');

  await db.costBudget.delete({ where: { id: tight.id } }).catch(() => undefined);
});

// ─── 11. rolling-window reset ───────────────────────────────────────────────

test('budget api: accrual older than the budget period drops out of the window (reset semantics)', async () => {
  await ensureRenderFixture();
  const db = await prisma();
  await db.costBudget.deleteMany({ where: { tenantId: demoTenantId } });
  const oneHour = await db.costBudget.create({
    data: { tenantId: demoTenantId, budgetUsd: 1, periodHours: 1, note: 'c12 one-hour window' },
  });
  budgetRowIds.push(oneHour.id);

  // backdated accrual (2h old — OUTSIDE the 1h rolling window)
  await db.usageRecord.create({
    data: {
      tenantId: demoTenantId,
      metric: BUDGET_METRIC,
      quantity: 5.0,
      meta: JSON.stringify({ workload: 'render.image', providerId: 'local-executor', jobId: 'backdated-c12', applicationActorId: null, basis: 'modeled' }),
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    },
  });

  // the fresh submit is judged against the CURRENT window only: the backdated
  // $5.0 does not count (accrued ~0.04 from the in-window submit + 0.04 quote
  // stays well under the $1 budget)
  const ok = await postRender();
  assert.equal(ok.status, 202, `submit with out-of-window history → ${ok.status} (${ok.text.slice(0, 200)})`);

  // the usage surface confirms the backdated row is outside the budget window
  const usage = await call('/api/v1/usage');
  assert.equal(usage.status, 200);
  assert.ok(usage.json.cost.budget.accruedUsd < 1, `accruedUsd ${usage.json.cost.budget.accruedUsd} excludes the backdated $5.0`);

  await db.costBudget.delete({ where: { id: oneHour.id } }).catch(() => undefined);
});

// ─── 12. tenant isolation ───────────────────────────────────────────────────

test('usage api: tenant isolation — a second tenant sees only its own (empty) cost data', async () => {
  await ensureBase();
  const db = await prisma();
  const slug = `c12-foreign-${stamp}`;
  const tenant = await db.tenant.create({ data: { slug, name: `C12 Foreign ${stamp}` } });
  await db.user.create({ data: { tenantId: tenant.id, email: `c12-foreign-${stamp}@example.test`, name: 'C12 Foreign', role: 'owner' } });
  foreignKey = `you_sk_c12_${sha256hex(`${stamp}-foreign`).slice(0, 24)}`;
  await db.apiKey.create({
    data: { tenantId: tenant.id, name: 'c12-isolation', prefix: foreignKey.slice(0, 10), hash: sha256hex(foreignKey), scopes: JSON.stringify(['read', 'write']) },
  });

  // tenant B (api key, read scope) gets its OWN usage view — empty, honest
  const foreignUsage = await call('/api/v1/usage', { headers: { authorization: `Bearer ${foreignKey}` } });
  assert.equal(foreignUsage.status, 200, `foreign usage → ${foreignUsage.status}`);
  assert.equal(foreignUsage.json.cost.budget.accruedUsd, 0, 'tenant B accrued nothing');
  assert.deepEqual(foreignUsage.json.cost.byPipeline, [], 'tenant B has no broker submits');
  assert.deepEqual(foreignUsage.json.cost.byApplication, []);
  assert.equal(foreignUsage.json.cost.budget.source, 'default', 'tenant B has the fail-closed default budget');
  // tenant A's pipelines are invisible
  assert.equal(
    foreignUsage.json.cost.byPipeline.some((p) => p.pipeline === 'render.image' && p.quotedUsd >= 0.04),
    false,
    'tenant A cost data never leaks',
  );
  // metrics is operator-session gated: the api key is refused (honest 403)
  const foreignMetrics = await call('/api/v1/metrics', { headers: { authorization: `Bearer ${foreignKey}` } });
  assert.equal(foreignMetrics.status, 403, `api-key metrics → ${foreignMetrics.status}`);
});

// ─── 13. metrics latency surface ────────────────────────────────────────────

test('metrics api: declared SLOs + real observations with request-id correlation', async () => {
  await ensureRenderFixture();
  const db = await prisma();
  void db;

  // operator session (the demo cookie) — the metrics surface is session-gated
  const metrics = await call('/api/v1/metrics');
  assert.equal(metrics.status, 200, `metrics → ${metrics.status}`);
  assert.ok(metrics.json.latency, 'the latency section is present');
  const slos = metrics.json.latency.slos;
  assert.deepEqual(
    slos.map((s) => [s.id, s.targetP95Ms]),
    [['api.read', 250], ['live.session.setup', 200], ['live.state.stream', 100]],
    'the three declared SLOs with their targets',
  );
  for (const s of slos) {
    assert.match(s.basis, /declared SLO/);
    assert.match(s.percentileMethod, /nearest-rank/);
    assert.equal(typeof s.breaches, 'number');
  }

  // api.read has REAL observations by now (the usage GETs above were recorded)
  const read = slos.find((s) => s.id === 'api.read');
  assert.ok(read.observations > 0, `api.read observations ${read.observations} > 0`);
  assert.ok(read.p50Ms === null || (read.p50Ms >= 0 && Number.isFinite(read.p50Ms)), 'p50 is a real observed number or honest null');
  assert.ok(read.p95Ms === null || (read.p95Ms >= 0 && Number.isFinite(read.p95Ms)), 'p95 is a real observed number or honest null');

  // request-id correlation: a pinned x-request-id (the P6.A7 middleware
  // honors + echoes inbound ids with a valid charset) must appear on the
  // observation the PROBE request recorded. The record happens AFTER the
  // handler body is serialized (handleRoute records after fn() resolves), so
  // the probe's own observation shows up in the NEXT metrics snapshot —
  // read it via a follow-up call.
  const probeId = `c12probe${stamp}`.replace(/[^A-Za-z0-9._-]/g, '');
  assert.ok(/^[A-Za-z0-9._-]{8,64}$/.test(probeId), 'the probe id satisfies the middleware charset law');
  const probe = await call('/api/v1/twins', { headers: { 'x-request-id': probeId } });
  assert.equal(probe.status, 200, 'the probe request itself succeeds');
  const metrics2 = await call('/api/v1/metrics');
  assert.equal(metrics2.status, 200);
  const last = metrics2.json.latency.slos.find((s) => s.id === 'api.read').lastObservation;
  assert.ok(last, 'an observation was recorded');
  assert.equal(last.requestId, probeId, 'the observation carries the middleware-issued request id');
  assert.equal(last.route, 'GET /api/v1/twins');
  assert.equal(last.method, 'GET');
  assert.equal(last.status, 200);
  assert.ok(last.durationMs >= 0, 'the duration is a real measured number');

  // the SLO breach counters are merged into the counters view
  assert.equal(typeof metrics2.json.counters['slo_breaches{bucket=api.read}'], 'number');

  // the realtime buckets exist with zero observations on a quiet deployment —
  // honest nulls, never fabricated percentiles
  const setup = metrics2.json.latency.slos.find((s) => s.id === 'live.session.setup');
  assert.equal(typeof setup.observations, 'number');
  if (setup.observations === 0) {
    assert.equal(setup.p50Ms, null, 'zero observations → null p50');
    assert.equal(setup.p95Ms, null, 'zero observations → null p95');
    assert.equal(setup.lastObservation, null);
  }
});

// ─── 14. optimization evidence wiring (e2e, cited run-ids exist) ────────────

test('optimization e2e: sequential + parallel runs on one seed produce evidence with REAL cited run-ids', async () => {
  await ensureRenderFixture();
  const db = await prisma();
  const worldSeed = 424242 + (Number(stamp.replace(/\D/g, '').slice(-5)) % 1000);

  // BEFORE run: sequential (the preserved pre-C12 code path) — cold cache
  const before = await call('/api/v1/lab/runs', {
    method: 'POST',
    body: { objectiveCode: 'HUMAN-RECON-001', worldSeed, evaluationMode: 'sequential' },
  });
  assert.equal(before.status, 202, `sequential run create → ${before.status} (${before.text.slice(0, 200)})`);
  const beforeJob = await pollJob(before.json.jobId);
  assert.equal(beforeJob.status, 'succeeded', `sequential lab run failed honestly: ${beforeJob.error ?? ''}`);
  const beforeRunId = beforeJob.output.benchmarkRunId;

  // AFTER run: parallel (the C12 optimization) — warm cache (same seed, same process)
  const after = await call('/api/v1/lab/runs', {
    method: 'POST',
    body: { objectiveCode: 'HUMAN-RECON-001', worldSeed, evaluationMode: 'parallel' },
  });
  assert.equal(after.status, 202, `parallel run create → ${after.status}`);
  const afterJob = await pollJob(after.json.jobId);
  assert.equal(afterJob.status, 'succeeded', `parallel lab run failed honestly: ${afterJob.error ?? ''}`);
  const afterRunId = afterJob.output.benchmarkRunId;

  // the evidence records surface via GET /usage with the cited run-ids
  const usage = await call('/api/v1/usage');
  assert.equal(usage.status, 200);
  const optimizations = usage.json.optimizations;
  assert.ok(Array.isArray(optimizations) && optimizations.length >= 2, 'the optimization catalog is present');

  const parallelView = optimizations.find((o) => o.id === 'parallel-org-evaluation');
  assert.ok(parallelView.evidence, `parallel evidence present (empty state: ${parallelView.emptyStateReason})`);
  assert.equal(parallelView.evidence.before.runId, beforeRunId, 'the before side cites the sequential run');
  assert.equal(parallelView.evidence.after.runId, afterRunId, 'the after side cites the parallel run');
  assert.equal(parallelView.evidence.before.mode, 'sequential');
  assert.equal(parallelView.evidence.after.mode, 'parallel');

  const cacheView = optimizations.find((o) => o.id === 'deterministic-subresult-cache');
  assert.ok(cacheView.evidence, `cache evidence present (empty state: ${cacheView.emptyStateReason})`);
  assert.equal(cacheView.evidence.before.runId, beforeRunId, 'the cold side cites the first (cold) run');
  assert.equal(cacheView.evidence.after.runId, afterRunId, 'the warm side cites the second (warm) run');

  // CITED RUN-IDS MUST EXIST — every referenced id resolves to a real row
  const beforeRow = await db.benchmarkRun.findUnique({ where: { id: beforeRunId } });
  const afterRow = await db.benchmarkRun.findUnique({ where: { id: afterRunId } });
  assert.ok(beforeRow, `cited run-id ${beforeRunId} exists`);
  assert.ok(afterRow, `cited run-id ${afterRunId} exists`);

  // the runs' own persisted evidence agrees with the pairing
  const beforeEv = extractCostLatency(beforeRow.metrics);
  const afterEv = extractCostLatency(afterRow.metrics);
  assert.equal(beforeEv.evaluation.mode, 'sequential');
  assert.equal(afterEv.evaluation.mode, 'parallel');
  assert.equal(beforeEv.compile.worldCacheHit, false, 'the first run was cache-cold');
  assert.equal(beforeEv.compile.orgCacheHit, false);
  assert.equal(afterEv.compile.worldCacheHit, true, 'the second run was cache-warm (same seed, same process)');
  assert.equal(afterEv.compile.orgCacheHit, true);

  // the optimization changes WALL-CLOCK, never per-org scores. <= always
  // holds (concurrent awaits never exceed serial ones); the STRICT < is only
  // asserted when real provider work dominates measurement noise (>= 100ms
  // of sequential work) — with fast-failing grounding calls both wall-clocks
  // are single-digit ms and Date.now() noise can flip strictness.
  assert.ok(
    afterEv.evaluation.wallClockMs <= beforeEv.evaluation.wallClockMs,
    `parallel wall-clock ${afterEv.evaluation.wallClockMs}ms <= sequential ${beforeEv.evaluation.wallClockMs}ms`,
  );
  if (beforeEv.evaluation.wallClockMs >= 100) {
    assert.ok(afterEv.evaluation.wallClockMs < beforeEv.evaluation.wallClockMs, 'with real provider work in flight, parallel is strictly faster');
  }
  const beforeScores = JSON.parse(beforeRow.metrics).perOrganization;
  const afterScores = JSON.parse(afterRow.metrics).perOrganization;
  assert.equal(beforeScores.length, 3);
  assert.equal(afterScores.length, 3);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(beforeScores[i].organizationId, afterScores[i].organizationId, 'organization order is mode-independent');
    assert.equal(beforeScores[i].scores.coverage, afterScores[i].scores.coverage, 'coverage is pure — identical across modes');
    assert.equal(beforeScores[i].scores.confidence, afterScores[i].scores.confidence, 'confidence is pure — identical across modes');
    assert.equal(beforeScores[i].scores.determinism, afterScores[i].scores.determinism, 'determinism is pure — identical across modes');
    // latencyMs carries the per-org grounding measurement (a real number in
    // BOTH modes — parallelization never fakes or drops it)
    assert.ok(Number.isFinite(afterScores[i].scores.latencyMs));
  }
});
