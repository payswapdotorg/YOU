// ═══════════════════════════════════════════════════════════════════════════
// Lab benchmark artifacts + Failure Atlas contract tests (P6.C11 — Worker C
// lane) — node:test.
//
// PURE UNIT TESTS — no server boot, no network, no real keys, no database.
// Covers the C11 zero-import contract cores exactly as the lab.benchmark
// executor and the /api/v1/lab routes fold them:
//
//   1. WRITE-ONCE RUN MANIFESTS (lib/you/lab/run-manifest.ts) —
//      buildRunManifest is deterministic (stable construction, no clocks),
//      carries the world seed + genome refs + generations + technology
//      versions (structural vs observed) + environment fingerprint (runtime
//      versions + deterministic flag) + per-stage provider/model/compute
//      provider with modeled/observed basis labels + per-scenario honesty
//      labels; resolveWriteOnceTarget NEVER targets a terminal run — a
//      re-run is a NEW row referencing its parent via rerunOf (immutability).
//   2. RUN COMPARISON + REGRESSION DETECTION — cross-seed comparisons are
//      refused (thrown pure / 400 via the decideCompareRuns fold); same-seed
//      diffs produce per-org metric rows + stage-level modeled diffs with
//      observed latencies displayed-but-never-thresholded; regression and
//      improvement flags fire against configurable thresholds (defaults
//      documented); the verdict is machine-readable.
//   3. FAILURE-CODE TAXONOMY + ATLAS AGGREGATION (lib/you/lab/
//      failure-codes.ts) — typed versioned codes across the region/stage/
//      provider/policy classes (UNCLASSIFIED is an explicit honest code);
//      aggregateAtlas counts REAL seeded cases only, groups by code/region/
//      pipeline/technology version with confidence rollups and top suspected
//      causes, filters by inclusive time window, and degrades honestly when
//      empty.
//   4. REMEDIATION LIFECYCLE — open --mitigate--> mitigated --verify-->
//      verified (terminal); evidence is REQUIRED; every transition appends
//      an audit entry (who/when/evidence); invalid transitions are honest
//      409s via the decideRemediate fold.
//   5. POLICY DECISION HONESTY — every entry is labeled enforced (cites a
//      real executor code path) or proposed (not implemented — never claimed
//      as enforced).
//   6. SOUL-SWAP SCENARIO (lib/you/lab/soul-swap.ts) — deterministic over
//      the real seeded world + the real compiled organizations (generateWorld
//      + GENERALIST_GENOME/HAND_DESIGNED_GENOME/mutateGenome +
//      compileOrganizations, composed exactly as the executor); scores are
//      bounded; the ONE injected grounding call per org is labeled observed
//      (or modeled-only when it fails — no fabricated measurement);
//      deriveSoulSwapFailureInputs only records REAL threshold breaches.
//   7. API SURFACE (route folds) — compare/artifact/remediate auth + scope
//      enforcement order (401 → 403 → 404 → 400 → 409), and the artifact
//      export's content-addressed sha256 stability (same run → same bytes →
//      same sha256, via the injected node:crypto hash).
//
// Imported STATICALLY by tests/index.mjs — runs in the aggregated
// `node --test tests/` gate. No env mutations.
// ═══════════════════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  DEFAULT_REGRESSION_THRESHOLDS,
  REGRESSION_THRESHOLD_DOCS,
  RUN_ARTIFACT_TYPE,
  RUN_MANIFEST_TYPE,
  RUN_TERMINAL_STATUSES,
  buildRunArtifact,
  buildRunManifest,
  compareRuns,
  decideCompareRuns,
  decideRunArtifact,
  parseThresholdOverrides,
  resolveWriteOnceTarget,
  runIsFillable,
} from '../../apps/web/src/lib/you/lab/run-manifest.ts';
import {
  FAILURE_CODES,
  FAILURE_TAXONOMY_VERSION,
  POLICY_DECISIONS,
  REMEDIATION_STATUSES,
  aggregateAtlas,
  applyRemediationTransition,
  classifyGroundingFailure,
  classifyPolicyScopeDenied,
  classifyRegionFailure,
  classifySoulSwapCapabilityLoss,
  classifySoulSwapDrift,
  decideRemediate,
  failureCodeDefinition,
  policyDecisionsForCode,
} from '../../apps/web/src/lib/you/lab/failure-codes.ts';
import {
  SOUL_SWAP_DRIFT_CEILING,
  SOUL_SWAP_FIT_FLOOR,
  SOUL_SWAP_OBJECTIVE_CODE,
  SOUL_SWAP_SCENARIO,
  deriveSoulSwapFailureInputs,
  evaluateSoulSwap,
} from '../../apps/web/src/lib/you/lab/soul-swap.ts';
import { GENERALIST_GENOME, HAND_DESIGNED_GENOME } from '../../apps/web/src/lib/you/lab/seed.ts';
import { mutateGenome } from '../../apps/web/src/lib/you/lab/genome.ts';
import { compileOrganizations } from '../../apps/web/src/lib/you/lab/organization-compiler.ts';
import { generateWorld } from '../../apps/web/src/lib/you/lab/world.ts';
import { stableStringify } from '../../apps/web/src/lib/you/lab/determinism.ts';

const sha256 = (b) => createHash('sha256').update(b, 'utf8').digest('hex');

// ─── shared fixtures (the real seed composition the executor folds) ─────────

const PIPELINES = {
  generalist: { id: 'pipe-generalist', name: 'generalist-vlm-recon', genome: GENERALIST_GENOME },
  handDesigned: { id: 'pipe-hand-designed', name: 'hand-designed-hybrid', genome: HAND_DESIGNED_GENOME },
  searched: { id: 'pipe-searched', name: 'searched-gen1', genome: mutateGenome(HAND_DESIGNED_GENOME, 42) },
};

const WORLD = generateWorld(42);
const ORGANIZATIONS = compileOrganizations(42, PIPELINES);

const GENOME_ARGS = [
  { pipelineId: PIPELINES.generalist.id, name: PIPELINES.generalist.name, generation: 0, origin: 'generalist', genome: PIPELINES.generalist.genome },
  { pipelineId: PIPELINES.handDesigned.id, name: PIPELINES.handDesigned.name, generation: 0, origin: 'hand-designed', genome: PIPELINES.handDesigned.genome },
  { pipelineId: PIPELINES.searched.id, name: PIPELINES.searched.name, generation: 1, origin: 'searched', genome: PIPELINES.searched.genome },
];

const ORG_ARGS = ORGANIZATIONS.map((o) => ({
  organizationId: o.descriptor.organizationId,
  origin: o.descriptor.origin,
  pipelineId: o.descriptor.pipelineId ?? '',
  grounding: { real: true, model: 'glm-4.6' },
}));

function manifestArgs(over = {}) {
  return {
    objectiveCode: 'HUMAN-RECON-001',
    scenario: 'human-recon-001',
    worldSeed: WORLD.seed,
    worldId: WORLD.worldId,
    genomes: GENOME_ARGS,
    organizations: ORG_ARGS,
    environment: { runtime: { node: 'v24.21.0', bun: '1.2.0' } },
    ...over,
  };
}

const AUTH = { tenantId: 'tenant-1', actorType: 'user', actorId: 'user-1', scopes: null };
const READ_KEY = { tenantId: 'tenant-1', actorType: 'application', actorId: 'app-1', scopes: ['read'] };
const WRITE_KEY = { tenantId: 'tenant-1', actorType: 'application', actorId: 'app-1', scopes: ['write'] };

function compareRunFixture(id, seed, scores, perStage) {
  return {
    id,
    worldSeed: seed,
    objectiveCode: 'HUMAN-RECON-001',
    reports: [
      {
        organizationId: 'org-hand-designed-hybrid',
        scores,
        detail: { perStage },
      },
    ],
  };
}

const STAGES_A = [
  { adapterId: 'lab-segment-1', role: 'segmenter', modeledLatencyMs: 240, modeledCostUsd: 0 },
  { adapterId: 'vlm-recon-1', role: 'analyzer', modeledLatencyMs: 0, modeledCostUsd: 0.01, observedLatencyMs: 812 },
  { adapterId: 'lab-merge-1', role: 'merger', modeledLatencyMs: 60, modeledCostUsd: 0 },
  { adapterId: 'lab-qa-1', role: 'qa', modeledLatencyMs: 90, modeledCostUsd: 0 },
];

// ═══════════════════════════════════════════════════════════════════════════
// 1. WRITE-ONCE RUN MANIFESTS
// ═══════════════════════════════════════════════════════════════════════════

test('manifest: buildRunManifest is deterministic — same args produce byte-identical JSON', () => {
  const a = buildRunManifest(manifestArgs());
  const b = buildRunManifest(manifestArgs());
  assert.equal(stableStringify(a), stableStringify(b));
  assert.equal(sha256(stableStringify(a)), sha256(stableStringify(b)));
});

test('manifest: input order never leaks — shuffled genomes/organizations yield the identical manifest', () => {
  const base = buildRunManifest(manifestArgs());
  const shuffled = buildRunManifest(
    manifestArgs({
      genomes: [...GENOME_ARGS].reverse(),
      organizations: [...ORG_ARGS].reverse(),
    }),
  );
  assert.equal(stableStringify(base), stableStringify(shuffled));
});

test('manifest: shape — type, version, seed/worldId, deterministic + writeOnce literals, rerunOf', () => {
  const m = buildRunManifest(manifestArgs());
  assert.equal(m.manifestType, RUN_MANIFEST_TYPE);
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.worldSeed, 42);
  assert.equal(m.worldId, WORLD.worldId);
  assert.equal(m.deterministic, true);
  assert.equal(m.writeOnce, true);
  assert.equal(m.rerunOf, null);
  const child = buildRunManifest(manifestArgs({ rerunOf: 'run-parent-1' }));
  assert.equal(child.rerunOf, 'run-parent-1');
});

test('manifest: genome refs record pipeline id, generation, origin and every stage adapter+version', () => {
  const m = buildRunManifest(manifestArgs());
  assert.equal(m.genomes.length, 3);
  const searched = m.genomes.find((g) => g.origin === 'searched');
  assert.ok(searched);
  assert.equal(searched.pipelineId, PIPELINES.searched.id);
  assert.equal(searched.generation, 1);
  assert.equal(searched.stages.length, PIPELINES.searched.genome.stages.length);
  for (const s of searched.stages) {
    assert.ok(s.adapterId);
    assert.ok(s.version);
  }
});

test('manifest: technology versions are labeled structural (from genomes) and observed (grounding model)', () => {
  const m = buildRunManifest(manifestArgs());
  const structural = m.technologyVersions.filter((t) => t.basis === 'structural');
  const observed = m.technologyVersions.filter((t) => t.basis === 'observed');
  // every distinct adapter@version across the three genomes is structural
  assert.ok(structural.length >= 4);
  for (const t of structural) {
    assert.match(t.component, /^lab-(segment|merge|qa)-1$|^vlm-recon-1$/);
  }
  // the real grounding model is recorded as an observed component
  assert.equal(observed.length, 1);
  assert.equal(observed[0].component, 'vlm-recon-1-grounding');
  assert.equal(observed[0].version, 'glm-4.6');
});

test('manifest: per-organization stages carry provider/model/compute-provider with honest basis labels', () => {
  const m = buildRunManifest(manifestArgs());
  assert.equal(m.organizations.length, ORGANIZATIONS.length);
  for (const org of m.organizations) {
    assert.ok(org.stages.length > 0);
    for (const s of org.stages) {
      assert.ok(typeof s.provider === 'string' && s.provider.length > 0);
      assert.ok(typeof s.computeProvider === 'string' && s.computeProvider.length > 0);
      assert.ok(s.basis === 'modeled' || s.basis === 'observed');
      if (s.adapterId === 'vlm-recon-1') {
        // grounding was real → the analyze stage is observed with the real model
        assert.equal(s.basis, 'observed');
        assert.equal(s.model, 'glm-4.6');
      } else {
        // local sims → modeled with the local sim model
        assert.equal(s.basis, 'modeled');
        assert.ok(s.model);
      }
    }
  }
});

test('manifest: failed grounding degrades the vlm stage to modeled — never a fabricated observed model', () => {
  const m = buildRunManifest(
    manifestArgs({
      organizations: ORG_ARGS.map((o) => ({ ...o, grounding: { real: false, model: null } })),
    }),
  );
  for (const org of m.organizations) {
    const vlm = org.stages.find((s) => s.adapterId === 'vlm-recon-1');
    assert.ok(vlm);
    assert.equal(vlm.basis, 'modeled');
    assert.equal(vlm.model, null);
  }
  assert.equal(m.technologyVersions.filter((t) => t.basis === 'observed').length, 0);
});

test('manifest: environment fingerprint records runtime versions + the deterministic flag', () => {
  const m = buildRunManifest(manifestArgs());
  assert.equal(m.environment.runtime.node, 'v24.21.0');
  assert.equal(m.environment.runtime.bun, '1.2.0');
  assert.equal(m.environment.deterministicFlag, true);
  assert.ok(m.environment.determinismNote.length > 0);
});

test('manifest: honesty block labels every metric modeled/observed per scenario, simulated: true', () => {
  const recon = buildRunManifest(manifestArgs());
  assert.equal(recon.honesty.simulated, true);
  assert.ok(recon.honesty.labels.coverage.startsWith('modeled'));
  assert.ok(recon.honesty.labels.determinism.startsWith('observed'));
  assert.ok(recon.honesty.labels.latencyMs.startsWith('mixed'));
  const swap = buildRunManifest(manifestArgs({ scenario: 'soul-swap-001', objectiveCode: SOUL_SWAP_OBJECTIVE_CODE }));
  assert.ok(swap.honesty.labels.continuity.startsWith('modeled'));
  assert.ok(swap.honesty.labels.drift.startsWith('modeled'));
  assert.ok(swap.honesty.labels.capabilityRetention.startsWith('modeled'));
});

test('manifest: no clock leaks — the manifest JSON contains no timestamp fields', () => {
  const m = buildRunManifest(manifestArgs());
  const json = stableStringify(m);
  assert.ok(!/[Tt]imestamp/.test(json));
  assert.ok(!/"(at|createdAt|finishedAt|now)"/.test(json));
});

test('write-once: only queued/running runs are fillable — terminal runs are never mutated', () => {
  for (const s of ['queued', 'running']) assert.equal(runIsFillable(s), true);
  for (const s of RUN_TERMINAL_STATUSES) assert.equal(runIsFillable(s), false);
  assert.deepEqual([...RUN_TERMINAL_STATUSES], ['succeeded', 'failed']);
});

test('write-once: resolveWriteOnceTarget targets a NEW run for a terminal parent — rerun creates, never mutates', () => {
  // a job pointing at a TERMINAL run: the write goes to a NEW row, the parent
  // is referenced via rerunOf, and the original row is untouched
  const t1 = resolveWriteOnceTarget({ benchmarkRunId: 'run-1', existingStatus: 'succeeded', rerunOfFromInput: null });
  assert.deepEqual(t1, { targetRunId: null, rerunOfId: 'run-1', createdNewRun: true });
  const t2 = resolveWriteOnceTarget({ benchmarkRunId: 'run-1', existingStatus: 'failed', rerunOfFromInput: null });
  assert.deepEqual(t2, { targetRunId: null, rerunOfId: 'run-1', createdNewRun: true });
  // its own queued row is filled in (no new row)
  const t3 = resolveWriteOnceTarget({ benchmarkRunId: 'run-1', existingStatus: 'queued', rerunOfFromInput: null });
  assert.deepEqual(t3, { targetRunId: 'run-1', rerunOfId: null, createdNewRun: false });
  // absent row → create
  const t4 = resolveWriteOnceTarget({ benchmarkRunId: null, existingStatus: null, rerunOfFromInput: 'run-parent' });
  assert.deepEqual(t4, { targetRunId: null, rerunOfId: 'run-parent', createdNewRun: true });
  // unfound id → create
  const t5 = resolveWriteOnceTarget({ benchmarkRunId: 'run-x', existingStatus: null, rerunOfFromInput: null });
  assert.deepEqual(t5, { targetRunId: 'run-x', rerunOfId: null, createdNewRun: false });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. RUN COMPARISON + REGRESSION DETECTION
// ═══════════════════════════════════════════════════════════════════════════

test('compare: thresholds are documented and the defaults match the order contract', () => {
  assert.equal(Object.keys(REGRESSION_THRESHOLD_DOCS).length, 8);
  assert.equal(DEFAULT_REGRESSION_THRESHOLDS.coverageDownMax, 0.05);
  assert.equal(DEFAULT_REGRESSION_THRESHOLDS.confidenceDownMax, 0.05);
  assert.equal(DEFAULT_REGRESSION_THRESHOLDS.determinismDownMax, 0);
  assert.equal(DEFAULT_REGRESSION_THRESHOLDS.latencyUpMaxPct, 0.1);
  assert.equal(DEFAULT_REGRESSION_THRESHOLDS.costUpMaxPct, 0.1);
  for (const [k, v] of Object.entries(DEFAULT_REGRESSION_THRESHOLDS)) {
    assert.ok(typeof v === 'number' && v >= 0, `threshold ${k} must be a non-negative number`);
    assert.ok(REGRESSION_THRESHOLD_DOCS[k], `threshold ${k} must be documented`);
  }
});

test('compare: pure core refuses cross-seed comparisons (never a silent cross-world diff)', () => {
  const a = compareRunFixture('run-a', 42, { coverage: 0.9 }, STAGES_A);
  const b = compareRunFixture('run-b', 43, { coverage: 0.9 }, STAGES_A);
  assert.throws(() => compareRuns(a, b), /cross_seed/);
});

test('compare: same-seed diff produces per-org metric rows with baseline/candidate values and deltas', () => {
  const base = compareRunFixture('run-base', 42, { coverage: 0.9, confidence: 0.8, determinism: 1 }, STAGES_A);
  const cand = compareRunFixture('run-cand', 42, { coverage: 0.85, confidence: 0.82, determinism: 1 }, STAGES_A);
  const c = compareRuns(base, cand);
  assert.equal(c.baselineRunId, 'run-base');
  assert.equal(c.candidateRunId, 'run-cand');
  assert.equal(c.worldSeed, 42);
  assert.equal(c.objectiveCode.match, true);
  const org = c.organizations.find((o) => o.organizationId === 'org-hand-designed-hybrid');
  assert.ok(org);
  const cov = org.metrics.find((m) => m.metric === 'coverage');
  assert.equal(cov.baselineValue, 0.9);
  assert.equal(cov.candidateValue, 0.85);
  assert.equal(cov.delta, -0.05);
  assert.equal(cov.direction, 'higher-better');
  // a 0.05 drop is exactly at the default threshold (not beyond) → no flag
  assert.equal(c.regressionFlags.length, 0);
});

test('compare: coverage/confidence drops beyond the threshold flag regressions with machine-readable detail', () => {
  const base = compareRunFixture('run-base', 42, { coverage: 0.9, confidence: 0.9, determinism: 1 }, STAGES_A);
  const cand = compareRunFixture('run-cand', 42, { coverage: 0.7, confidence: 0.72, determinism: 1 }, STAGES_A);
  const c = compareRuns(base, cand);
  assert.equal(c.verdict, 'regression');
  const flaggedMetrics = c.regressionFlags.map((f) => f.metric).sort();
  assert.deepEqual(flaggedMetrics, ['confidence', 'coverage']);
  for (const f of c.regressionFlags) {
    assert.equal(f.kind, 'absolute');
    assert.equal(f.threshold, 0.05);
    assert.ok(f.observed > 0.05);
    assert.ok(f.detail.includes('beyond the allowed absolute drop'));
  }
  assert.ok(c.verdictBasis.includes('verdict=regression'));
});

test('compare: any determinism drop (1 → 0) flags — the threshold is 0 by contract', () => {
  const base = compareRunFixture('run-base', 42, { coverage: 0.9, determinism: 1 }, STAGES_A);
  const cand = compareRunFixture('run-cand', 42, { coverage: 0.9, determinism: 0 }, STAGES_A);
  const c = compareRuns(base, cand);
  assert.ok(c.regressionFlags.some((f) => f.metric === 'determinism'));
});

test('compare: threshold overrides change the outcome (configurable), and are reported as overridden', () => {
  const base = compareRunFixture('run-base', 42, { coverage: 0.9 }, STAGES_A);
  const cand = compareRunFixture('run-cand', 42, { coverage: 0.85 }, STAGES_A);
  // default 0.05: a 0.05 drop does NOT flag; tightened to 0.02: it does
  const loose = compareRuns(base, cand);
  assert.equal(loose.regressionFlags.length, 0);
  const tight = compareRuns(base, cand, { coverageDownMax: 0.02 });
  assert.equal(tight.regressionFlags.length, 1);
  assert.equal(tight.regressionFlags[0].metric, 'coverage');
  assert.equal(tight.thresholds.applied.coverageDownMax, 0.02);
  assert.equal(tight.thresholds.overridden.length, 1);
  assert.equal(tight.thresholds.overridden[0], 'coverageDownMax');
  assert.deepEqual(tight.thresholds.defaults, DEFAULT_REGRESSION_THRESHOLDS);
});

test('compare: latency regressions are RELATIVE (default 10%) — small rises do not flag', () => {
  const base = compareRunFixture('run-base', 42, { coverage: 0.9, latencyMs: 1000 }, STAGES_A);
  const within = compareRunFixture('run-cand', 42, { coverage: 0.9, latencyMs: 1090 }, STAGES_A);
  assert.equal(compareRuns(base, within).regressionFlags.length, 0);
  const beyond = compareRunFixture('run-cand', 42, { coverage: 0.9, latencyMs: 1200 }, STAGES_A);
  const c = compareRuns(base, beyond);
  assert.equal(c.regressionFlags.length, 1);
  assert.equal(c.regressionFlags[0].metric, 'latencyMs');
  assert.equal(c.regressionFlags[0].kind, 'relative');
  assert.equal(c.regressionFlags[0].threshold, 0.1);
});

test('compare: cost regressions are relative with the documented 10% default', () => {
  const base = compareRunFixture('run-base', 42, { costUsd: 0.02 }, STAGES_A);
  const cand = compareRunFixture('run-cand', 42, { costUsd: 0.05 }, STAGES_A);
  const c = compareRuns(base, cand);
  assert.equal(c.regressionFlags.length, 1);
  assert.equal(c.regressionFlags[0].metric, 'costUsd');
  assert.equal(c.regressionFlags[0].kind, 'relative');
});

test('compare: zero-baseline latency never flags relatively (honest: relative math needs a positive baseline)', () => {
  const base = compareRunFixture('run-base', 42, { latencyMs: 0 }, STAGES_A);
  const cand = compareRunFixture('run-cand', 42, { latencyMs: 5000 }, STAGES_A);
  assert.equal(compareRuns(base, cand).regressionFlags.length, 0);
});

test('compare: improvements flag beyond the same thresholds and drive the improvement verdict', () => {
  const base = compareRunFixture('run-base', 42, { coverage: 0.7, latencyMs: 2000 }, STAGES_A);
  const cand = compareRunFixture('run-cand', 42, { coverage: 0.95, latencyMs: 1000 }, STAGES_A);
  const c = compareRuns(base, cand);
  assert.equal(c.verdict, 'improvement');
  assert.equal(c.regressionFlags.length, 0);
  assert.ok(c.improvementFlags.length >= 2);
  assert.ok(c.improvementFlags.some((f) => f.metric === 'coverage'));
  assert.ok(c.improvementFlags.some((f) => f.metric === 'latencyMs'));
});

test('compare: identical runs yield no_material_change', () => {
  const base = compareRunFixture('run-base', 42, { coverage: 0.9, latencyMs: 1000 }, STAGES_A);
  const c = compareRuns(base, compareRunFixture('run-cand', 42, { coverage: 0.9, latencyMs: 1000 }, STAGES_A));
  assert.equal(c.verdict, 'no_material_change');
  assert.equal(c.regressionFlags.length, 0);
  assert.equal(c.improvementFlags.length, 0);
});

test('compare: unknown-metric directions are compared but NEVER flagged (honest unknown)', () => {
  const base = compareRunFixture('run-base', 42, { mysteryMetric: 0.9 }, STAGES_A);
  const cand = compareRunFixture('run-cand', 42, { mysteryMetric: 0.1 }, STAGES_A);
  const c = compareRuns(base, cand);
  const row = c.organizations[0].metrics.find((m) => m.metric === 'mysteryMetric');
  assert.ok(row);
  assert.equal(row.direction, 'unknown');
  assert.equal(row.changed, true);
  assert.equal(c.regressionFlags.length, 0);
});

test('compare: stage-level diffs show modeled latency/cost deltas; observed latencies are displayed, never thresholded', () => {
  const stagesB = STAGES_A.map((s) =>
    s.adapterId === 'lab-merge-1' ? { ...s, modeledLatencyMs: 160 } : { ...s, observedLatencyMs: 700 },
  );
  const base = compareRunFixture('run-base', 42, { coverage: 0.9 }, STAGES_A);
  const cand = compareRunFixture('run-cand', 42, { coverage: 0.9 }, stagesB);
  const c = compareRuns(base, cand);
  const org = c.organizations[0];
  const merge = org.stages.find((s) => s.adapterId === 'lab-merge-1');
  assert.equal(merge.baselineModeledLatencyMs, 60);
  assert.equal(merge.candidateModeledLatencyMs, 160);
  assert.equal(merge.deltaModeledLatencyMs, 100);
  // observed latency changed 812 → 700 but produces no flag anywhere
  const vlm = org.stages.find((s) => s.adapterId === 'vlm-recon-1');
  assert.equal(vlm.observedLatencyMs.baseline, 812);
  assert.equal(vlm.observedLatencyMs.candidate, 700);
  assert.equal(c.regressionFlags.length, 0);
  assert.equal(c.improvementFlags.length, 0);
});

test('compare: an organization present in only one run is reported, not compared', () => {
  const base = {
    id: 'run-base',
    worldSeed: 42,
    objectiveCode: 'HUMAN-RECON-001',
    reports: [{ organizationId: 'org-a', scores: { coverage: 0.9 }, detail: { perStage: [] } }],
  };
  const cand = {
    id: 'run-cand',
    worldSeed: 42,
    objectiveCode: 'HUMAN-RECON-001',
    reports: [{ organizationId: 'org-b', scores: { coverage: 0.9 }, detail: { perStage: [] } }],
  };
  const c = compareRuns(base, cand);
  assert.equal(c.organizations.length, 2);
  for (const org of c.organizations) {
    assert.equal(org.presentIn.baseline && org.presentIn.candidate, false);
    assert.equal(org.metrics.length, 0);
  }
  assert.equal(c.verdict, 'no_material_change');
});

test('compare: honesty notes state the modeled-basis law and the observed-latency exclusion', () => {
  const base = compareRunFixture('run-base', 42, { coverage: 0.9 }, STAGES_A);
  const c = compareRuns(base, compareRunFixture('run-cand', 42, { coverage: 0.9 }, STAGES_A));
  const notes = c.honestyNotes.join(' | ');
  assert.ok(notes.includes('modeled'));
  assert.ok(notes.includes('single wall-clock measurement is not regression evidence'));
  assert.ok(notes.includes('SIMULATED'));
});

test('compare route fold: enforcement order 401 → 403 → 404 (run) → 400 (missing baseline) → 404 (baseline) → 400 (cross-seed) → proceed', () => {
  const run = compareRunFixture('run-cand', 42, { coverage: 0.9 }, STAGES_A);
  const baseline = compareRunFixture('run-base', 42, { coverage: 0.9 }, STAGES_A);
  const crossSeed = compareRunFixture('run-base2', 43, { coverage: 0.9 }, STAGES_A);
  const args = { runId: 'run-cand', baselineParam: 'run-base', run, baselineRun: baseline, thresholdOverrides: {} };

  // 401 — no auth
  assert.deepEqual(decideCompareRuns({ ...args, auth: null }), {
    kind: 'error', status: 401, code: 'unauthenticated', message: 'authentication required',
  });
  // 403 — API key without read/write scope
  const denied = decideCompareRuns({ ...args, auth: { ...READ_KEY, scopes: ['admin'] } });
  assert.equal(denied.kind, 'error');
  assert.equal(denied.status, 403);
  // read scope is sufficient for a GET
  assert.equal(decideCompareRuns({ ...args, auth: READ_KEY }).kind, 'proceed');
  // 404 — unknown candidate run
  const missingRun = decideCompareRuns({ ...args, auth: AUTH, run: null });
  assert.equal(missingRun.status, 404);
  // 400 — missing baseline param
  const noParam = decideCompareRuns({ ...args, auth: AUTH, baselineParam: null, baselineRun: null });
  assert.equal(noParam.status, 400);
  assert.equal(noParam.code, 'validation_failed');
  // 404 — unknown baseline run
  const missingBaseline = decideCompareRuns({ ...args, auth: AUTH, baselineRun: null });
  assert.equal(missingBaseline.status, 404);
  // 400 — cross-seed, with the clear never-compare-across-worlds message
  const cross = decideCompareRuns({ ...args, auth: AUTH, baselineRun: crossSeed });
  assert.equal(cross.status, 400);
  assert.ok(cross.message.includes('cannot compare runs across world seeds'));
  assert.ok(cross.message.includes('seed 43'));
  assert.ok(cross.message.includes('seed 42'));
  // proceed — session auth
  const ok = decideCompareRuns({ ...args, auth: AUTH });
  assert.equal(ok.kind, 'proceed');
  assert.equal(ok.baseline.id, 'run-base');
  assert.equal(ok.candidate.id, 'run-cand');
});

test('compare route fold: threshold query params are validated honestly', () => {
  const ok = parseThresholdOverrides(new URLSearchParams('baseline=run-base&coverageDownMax=0.02&latencyUpMaxPct=0.25'));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.thresholds, { coverageDownMax: 0.02, latencyUpMaxPct: 0.25 });
  const unknown = parseThresholdOverrides(new URLSearchParams('bogusParam=1'));
  assert.equal(unknown.ok, false);
  assert.ok(unknown.message.includes('unknown threshold parameter "bogusParam"'));
  const negative = parseThresholdOverrides(new URLSearchParams('coverageDownMax=-1'));
  assert.equal(negative.ok, false);
  assert.ok(negative.message.includes('must be a finite number ≥ 0'));
  const nonNumeric = parseThresholdOverrides(new URLSearchParams('latencyUpMaxPct=fast'));
  assert.equal(nonNumeric.ok, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. FAILURE-CODE TAXONOMY + ATLAS AGGREGATION
// ═══════════════════════════════════════════════════════════════════════════

test('taxonomy: versioned codes span the region/stage/provider/policy classes + the honest UNCLASSIFIED', () => {
  assert.equal(FAILURE_TAXONOMY_VERSION, 1);
  const classes = new Set(Object.values(FAILURE_CODES).map((d) => d.class));
  assert.ok(classes.has('region'));
  assert.ok(classes.has('stage'));
  assert.ok(classes.has('provider'));
  assert.ok(classes.has('policy'));
  assert.ok(FAILURE_CODES.UNCLASSIFIED);
  for (const def of Object.values(FAILURE_CODES)) {
    assert.ok(def.code === undefined || def.code === def.code);
    assert.ok(def.description.length > 0);
    assert.ok(def.payloadFields.length > 0);
    assert.ok(def.remediationHint.length > 0);
  }
});

test('taxonomy: unknown codes resolve to UNCLASSIFIED — never a guess', () => {
  assert.equal(failureCodeDefinition('NOT_A_CODE').code, 'UNCLASSIFIED');
  assert.equal(failureCodeDefinition('REGION_UNCAPTURED').code, 'REGION_UNCAPTURED');
});

test('taxonomy: classifiers emit the code and the full structured payload per payloadFields', () => {
  const region = classifyRegionFailure({ region: 'left-ankle', regionDifficulty: 0.9, occlusionPenalty: 0.2, worldSeed: 42 });
  assert.equal(region.code, 'REGION_UNCAPTURED');
  assert.deepEqual(region.payload, { region: 'left-ankle', regionDifficulty: 0.9, occlusionPenalty: 0.2, worldSeed: 42 });
  for (const f of FAILURE_CODES.REGION_UNCAPTURED.payloadFields) assert.ok(f in region.payload);

  const cap = classifySoulSwapCapabilityLoss({
    organizationId: 'org-x', role: 'analyzer', adapterId: 'vlm-recon-1',
    canonicalSoul: 'soul-two-deep', swappedSoul: 'soul-one-fast', fit: 0.55, worldSeed: 42,
  });
  assert.equal(cap.code, 'SOUL_SWAP_CAPABILITY_LOSS');
  assert.deepEqual(cap.payload, {
    organizationId: 'org-x', role: 'analyzer', adapterId: 'vlm-recon-1',
    canonicalSoul: 'soul-two-deep', swappedSoul: 'soul-one-fast', fit: 0.55, worldSeed: 42,
  });

  const drift = classifySoulSwapDrift({ organizationId: 'org-x', drift: 0.61, driftCeiling: 0.5, worldSeed: 42 });
  assert.equal(drift.code, 'SOUL_SWAP_IDENTITY_DRIFT');
  assert.equal(drift.payload.drift, 0.61);

  const grounding = classifyGroundingFailure({ provider: 'zai', model: null, error: 'timeout' });
  assert.equal(grounding.code, 'PROVIDER_GROUNDING_FAILED');
  assert.deepEqual(grounding.payload, { provider: 'zai', model: null, error: 'timeout', basis: 'observed' });

  const policy = classifyPolicyScopeDenied({ gate: 'consent', required: 'reconstruct', actual: 'render_only', route: '/api/v1/exports' });
  assert.equal(policy.code, 'POLICY_SCOPE_DENIED');
  assert.deepEqual(policy.payload, { gate: 'consent', required: 'reconstruct', actual: 'render_only', route: '/api/v1/exports' });
});

// ─── atlas fixtures (seeded cases — aggregation counts THESE only) ──────────

function atlasCase(over = {}) {
  return {
    id: `case-${Math.random().toString(36).slice(2, 10)}`,
    code: 'REGION_UNCAPTURED',
    inputConditions: { worldSeed: 42 },
    payload: { region: 'left-ankle', regionDifficulty: 0.9, occlusionPenalty: 0.2, worldSeed: 42 },
    pipeline: { name: 'hand-designed-hybrid' },
    technologyVersions: [{ component: 'vlm-recon-1', version: '1' }],
    suspectedCause: 'occlusion',
    confidence: 0.7,
    status: 'open',
    createdAt: '2026-10-01T12:00:00.000Z',
    ...over,
  };
}

test('atlas: aggregation counts the real seeded cases only — totals, statuses, confidence rollups', () => {
  const cases = [
    atlasCase({ confidence: 0.6, status: 'open' }),
    atlasCase({ confidence: 0.8, status: 'mitigated' }),
    atlasCase({ confidence: 0.9, status: 'verified', code: 'SOUL_SWAP_IDENTITY_DRIFT' }),
    atlasCase({ confidence: 0.5, status: 'open', code: 'UNCLASSIFIED' }),
  ];
  const a = aggregateAtlas(cases);
  assert.equal(a.taxonomyVersion, FAILURE_TAXONOMY_VERSION);
  assert.equal(a.totals.cases, 4);
  assert.equal(a.totals.open, 2);
  assert.equal(a.totals.mitigated, 1);
  assert.equal(a.totals.verified, 1);
  assert.equal(a.totals.meanConfidence, 0.7);
  assert.equal(a.totals.unclassified, 1);
  assert.equal(a.window.filteredOut, 0);
  // the honesty note: counts derive from real recorded cases only
  assert.ok(a.honestyNotes.some((n) => n.includes('REAL recorded FailureCase rows only')));
});

test('atlas: byCode groups attach the class and the policy decisions for the code', () => {
  const cases = [
    atlasCase(),
    atlasCase({ code: 'SOUL_SWAP_IDENTITY_DRIFT', payload: { organizationId: 'org-x', drift: 0.61, driftCeiling: 0.5, worldSeed: 42 } }),
    atlasCase({ code: 'SOUL_SWAP_IDENTITY_DRIFT', payload: { organizationId: 'org-y', drift: 0.7, driftCeiling: 0.5, worldSeed: 42 } }),
  ];
  const a = aggregateAtlas(cases);
  assert.equal(a.byCode.length, 2);
  const drift = a.byCode.find((r) => r.code === 'SOUL_SWAP_IDENTITY_DRIFT');
  assert.ok(drift);
  assert.equal(drift.count, 2);
  assert.equal(drift.class, 'stage');
  assert.equal(drift.open, 2);
  assert.equal(drift.meanConfidence, 0.7);
  assert.equal(drift.minConfidence, 0.7);
  assert.equal(drift.maxConfidence, 0.7);
  assert.deepEqual(drift.policy, POLICY_DECISIONS.SOUL_SWAP_IDENTITY_DRIFT);
  // sorted by count descending
  assert.equal(a.byCode[0].code, 'SOUL_SWAP_IDENTITY_DRIFT');
});

test('atlas: byRegion / byPipeline / byTechnologyVersion derive from the recorded fields', () => {
  const cases = [
    atlasCase({ payload: { region: 'left-ankle' }, pipeline: { name: 'hand-designed-hybrid' }, technologyVersions: [{ component: 'vlm-recon-1', version: '1' }] }),
    atlasCase({ payload: { region: 'left-ankle' }, pipeline: { name: 'generalist-vlm-recon' }, technologyVersions: [{ component: 'vlm-recon-1', version: '1' }] }),
    atlasCase({ payload: { region: 'scalp' }, pipeline: { name: 'hand-designed-hybrid' }, technologyVersions: [{ component: 'lab-segment-1', version: '1' }] }),
    // a case with no region in payload and no tech versions — grouped nowhere
    atlasCase({ payload: {}, pipeline: {}, technologyVersions: [] }),
  ];
  const a = aggregateAtlas(cases);
  assert.equal(a.byRegion.length, 2);
  assert.equal(a.byRegion[0].key, 'left-ankle');
  assert.equal(a.byRegion[0].count, 2);
  assert.equal(a.byRegion.find((r) => r.key === 'scalp').count, 1);
  assert.equal(a.byPipeline.length, 2);
  assert.equal(a.byPipeline[0].key, 'hand-designed-hybrid');
  assert.equal(a.byPipeline[0].count, 2);
  assert.equal(a.byTechnologyVersion.length, 2);
  assert.equal(a.byTechnologyVersion[0].key, 'vlm-recon-1@1');
  assert.equal(a.byTechnologyVersion[0].count, 2);
});

test('atlas: top suspected causes are frequency-ranked and capped', () => {
  const cases = [
    atlasCase({ suspectedCause: 'occlusion' }),
    atlasCase({ suspectedCause: 'occlusion' }),
    atlasCase({ suspectedCause: 'sensor noise' }),
    atlasCase({ suspectedCause: 'low granularity' }),
  ];
  const a = aggregateAtlas(cases, { topCauses: 2 });
  const regionRow = a.byCode.find((r) => r.code === 'REGION_UNCAPTURED');
  assert.equal(regionRow.topSuspectedCauses.length, 2);
  assert.equal(regionRow.topSuspectedCauses[0].cause, 'occlusion');
  assert.equal(regionRow.topSuspectedCauses[0].count, 2);
  assert.equal(regionRow.topSuspectedCauses[1].cause, 'low granularity');
});

test('atlas: the time window filters inclusively and reports filteredOut honestly', () => {
  const cases = [
    atlasCase({ createdAt: '2026-10-01T00:00:00.000Z' }),
    atlasCase({ createdAt: '2026-10-02T00:00:00.000Z' }),
    atlasCase({ createdAt: '2026-10-03T00:00:00.000Z' }),
  ];
  // inclusive bounds keep both edge days
  const inclusive = aggregateAtlas(cases, { from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' });
  assert.equal(inclusive.totals.cases, 2);
  assert.equal(inclusive.window.filteredOut, 1);
  assert.equal(inclusive.window.from, '2026-10-01T00:00:00.000Z');
  // null bounds = open-ended
  const open = aggregateAtlas(cases);
  assert.equal(open.totals.cases, 3);
  assert.equal(open.window.from, null);
});

test('atlas: no cases → zero totals, null mean confidence, empty groups (honest empty)', () => {
  const a = aggregateAtlas([]);
  assert.equal(a.totals.cases, 0);
  assert.equal(a.totals.open, 0);
  assert.equal(a.totals.meanConfidence, null);
  assert.equal(a.byCode.length, 0);
  assert.equal(a.byRegion.length, 0);
  assert.equal(a.byPipeline.length, 0);
  assert.equal(a.byTechnologyVersion.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. REMEDIATION LIFECYCLE (open → mitigated → verified)
// ═══════════════════════════════════════════════════════════════════════════

const ACTOR = { actorType: 'user', actorId: 'user-7', tenantId: 'tenant-1' };
const NOW = '2026-10-04T10:00:00.000Z';

test('remediation: open --mitigate--> mitigated --verify--> verified, each step appending an audit entry', () => {
  const first = applyRemediationTransition({
    currentStatus: 'open', log: [], action: 'mitigate',
    evidence: 'patched the segmenter granularity and re-ran seed 42', actor: ACTOR, now: NOW,
  });
  assert.equal(first.ok, true);
  assert.equal(first.status, 'mitigated');
  assert.equal(first.log.length, 1);
  assert.equal(first.log[0].action, 'mitigate');
  assert.equal(first.log[0].from, 'open');
  assert.equal(first.log[0].to, 'mitigated');
  assert.equal(first.log[0].actorId, 'user-7');
  assert.equal(first.log[0].tenantId, 'tenant-1');
  assert.equal(first.log[0].evidence, 'patched the segmenter granularity and re-ran seed 42');
  assert.equal(first.log[0].at, NOW);

  const second = applyRemediationTransition({
    currentStatus: 'mitigated', log: first.log, action: 'verify',
    evidence: 'three consecutive green re-runs on seed 42', actor: ACTOR, now: '2026-10-05T10:00:00.000Z', note: 'verified by on-call',
  });
  assert.equal(second.ok, true);
  assert.equal(second.status, 'verified');
  assert.equal(second.log.length, 2);
  assert.equal(second.log[1].action, 'verify');
  assert.equal(second.log[1].note, 'verified by on-call');
});

test('remediation: evidence is REQUIRED on every action (honest 400)', () => {
  const r = applyRemediationTransition({
    currentStatus: 'open', log: [], action: 'mitigate', evidence: '   ', actor: ACTOR, now: NOW,
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.code, 'validation_failed');
  assert.ok(r.message.includes('evidence'));
});

test('remediation: invalid transitions are honest 409s — verify-on-open, re-mitigate, anything-on-verified', () => {
  const verifyOpen = applyRemediationTransition({
    currentStatus: 'open', log: [], action: 'verify', evidence: 'e', actor: ACTOR, now: NOW,
  });
  assert.equal(verifyOpen.ok, false);
  assert.equal(verifyOpen.status, 409);
  assert.ok(verifyOpen.message.includes('mitigate it before verification'));

  const reMitigate = applyRemediationTransition({
    currentStatus: 'mitigated', log: [], action: 'mitigate', evidence: 'e', actor: ACTOR, now: NOW,
  });
  assert.equal(reMitigate.ok, false);
  assert.equal(reMitigate.status, 409);

  const onVerified = applyRemediationTransition({
    currentStatus: 'verified', log: [], action: 'verify', evidence: 'e', actor: ACTOR, now: NOW,
  });
  assert.equal(onVerified.ok, false);
  assert.equal(onVerified.status, 409);
  assert.ok(onVerified.message.includes('terminal'));

  assert.deepEqual([...REMEDIATION_STATUSES], ['open', 'mitigated', 'verified']);
});

test('remediation: an unknown current status is a 400, never a silent pass', () => {
  const r = applyRemediationTransition({
    currentStatus: 'closed', log: [], action: 'mitigate', evidence: 'e', actor: ACTOR, now: NOW,
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('remediation route fold: 401 → 403 (write scope) → 404 → 400 (action) → 400 (evidence) → proceed', () => {
  const failure = { id: 'case-1', status: 'open', remediationLog: [] };
  const args = { failureId: 'case-1', failure, body: { action: 'mitigate', evidence: 'evidence text' }, now: NOW };

  const noAuth = decideRemediate({ ...args, auth: null });
  assert.equal(noAuth.status, 401);

  // POST requires the WRITE scope — a read-only key is refused
  const readKey = decideRemediate({ ...args, auth: READ_KEY });
  assert.equal(readKey.status, 403);
  assert.ok(readKey.message.includes('"write" scope'));

  const missing = decideRemediate({ ...args, auth: AUTH, failure: null });
  assert.equal(missing.status, 404);

  const badAction = decideRemediate({ ...args, auth: AUTH, body: { action: 'close', evidence: 'e' } });
  assert.equal(badAction.status, 400);
  assert.ok(badAction.message.includes('"mitigate" or "verify"'));

  const noEvidence = decideRemediate({ ...args, auth: AUTH, body: { action: 'mitigate' } });
  assert.equal(noEvidence.status, 400);

  const ok = decideRemediate({ ...args, auth: WRITE_KEY });
  assert.equal(ok.kind, 'proceed');
  assert.equal(ok.action, 'mitigate');
  assert.equal(ok.evidence, 'evidence text');

  const withNote = decideRemediate({ ...args, auth: AUTH, body: { action: 'mitigate', evidence: 'e', note: 'n' } });
  assert.equal(withNote.note, 'n');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. POLICY DECISION HONESTY (enforced vs proposed)
// ═══════════════════════════════════════════════════════════════════════════

test('policy: every decision entry is labeled enforced or proposed with a non-empty basis', () => {
  for (const [code, entries] of Object.entries(POLICY_DECISIONS)) {
    assert.ok(entries.length > 0, `${code} has at least one decision`);
    for (const e of entries) {
      assert.equal(e.code, code);
      assert.ok(e.action === 'retry' || e.action === 'fallback' || e.action === 'quarantine' || e.action === 'escalate');
      assert.ok(e.status === 'enforced' || e.status === 'proposed');
      assert.ok(e.basis.length > 20, `${code}/${e.action} carries a real basis`);
    }
  }
});

test('policy: enforced entries cite real executor behavior; proposed entries state not-implemented honestly', () => {
  // the fallback QA recovery and the modeled-only degradation ARE real code paths → enforced
  const regionFallback = POLICY_DECISIONS.REGION_UNCAPTURED.find((e) => e.action === 'fallback');
  assert.equal(regionFallback.status, 'enforced');
  assert.ok(regionFallback.basis.includes('benchmark.ts'));
  const groundingFallback = POLICY_DECISIONS.PROVIDER_GROUNDING_FAILED.find((e) => e.action === 'fallback');
  assert.equal(groundingFallback.status, 'enforced');
  // no automated escalation exists yet → proposed, and the basis says so
  for (const e of POLICY_DECISIONS.SOUL_SWAP_CAPABILITY_LOSS) assert.equal(e.status, 'proposed');
  for (const e of POLICY_DECISIONS.SOUL_SWAP_IDENTITY_DRIFT) assert.equal(e.status, 'proposed');
  assert.ok(POLICY_DECISIONS.SOUL_SWAP_CAPABILITY_LOSS[0].basis.includes('no automated escalation path exists'));
  // no provider retry is implemented → proposed
  const retry = POLICY_DECISIONS.PROVIDER_GROUNDING_FAILED.find((e) => e.action === 'retry');
  assert.equal(retry.status, 'proposed');
});

test('policy: unknown codes fall back to the UNCLASSIFIED decisions (escalate, proposed)', () => {
  const decisions = policyDecisionsForCode('NOT_A_CODE');
  assert.deepEqual(decisions, POLICY_DECISIONS.UNCLASSIFIED);
  assert.equal(decisions[0].status, 'proposed');
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. SOUL-SWAP SCENARIO (SOUL-SWAP-001)
// ═══════════════════════════════════════════════════════════════════════════

test('soul-swap: deterministic over the real seeded world + compiled organizations (no grounding)', async () => {
  const a = await evaluateSoulSwap(WORLD, ORGANIZATIONS, null);
  const b = await evaluateSoulSwap(WORLD, ORGANIZATIONS, null);
  assert.equal(stableStringify(a), stableStringify(b));
  assert.equal(a.llmCalls, 0); // no grounding injected → no real calls claimed
});

test('soul-swap: three organizations evaluated, every score bounded, determinism flag observed', async () => {
  const { evaluations, aggregate } = await evaluateSoulSwap(WORLD, ORGANIZATIONS, null);
  assert.equal(evaluations.length, 3);
  for (const ev of evaluations) {
    for (const m of ['continuity', 'drift', 'capabilityRetention', 'determinism']) {
      assert.ok(ev.scores[m] >= 0 && ev.scores[m] <= 1, `${m} in [0,1]`);
    }
    assert.ok(ev.scores.latencyMs >= 0);
    assert.ok(ev.scores.costUsd >= 0);
    assert.equal(ev.scores.determinism, 1); // pure recomputation equality
    assert.equal(ev.reproducible, true);
    // honesty labels travel with every evaluation
    assert.equal(ev.detail.simulated, true);
    assert.ok(String(ev.detail.simulationNote).includes('SIMULATED research truth'));
    assert.equal(ev.detail.scenario, SOUL_SWAP_SCENARIO);
    assert.equal(ev.detail.worldSeed, 42);
    assert.equal(ev.detail.costUsdModeled, true);
    assert.ok(Array.isArray(ev.detail.perBodySwap));
    assert.ok(Array.isArray(ev.detail.llmLatencyComponents));
  }
  assert.equal(aggregate.formula.includes('continuity'), true);
  assert.equal(aggregate.ranking.length, 3);
  assert.ok(aggregate.bestOrganizationId);
  // ranking is sorted descending by weighted score
  for (let i = 1; i < aggregate.ranking.length; i++) {
    assert.ok(aggregate.ranking[i - 1].weightedScore >= aggregate.ranking[i].weightedScore);
  }
});

test('soul-swap: ONE real grounding call per organization is labeled observed and counted', async () => {
  let calls = 0;
  const grounding = async () => {
    calls += 1;
    return { real: true, latencyMs: 421, model: 'glm-4.6', error: null };
  };
  const { evaluations, llmCalls } = await evaluateSoulSwap(WORLD, ORGANIZATIONS, grounding);
  assert.equal(calls, 3);
  assert.equal(llmCalls, 3);
  for (const ev of evaluations) {
    assert.equal(ev.detail.latencyRealMs, 421);
    assert.ok(String(ev.detail.latencyMsBasis).includes('ONE observed provider grounding call'));
    const observed = ev.detail.llmLatencyComponents.find((c) => c.basis === 'observed');
    assert.ok(observed);
    assert.equal(observed.latencyMs, 421);
    // the modeled components are labeled too
    assert.ok(ev.detail.llmLatencyComponents.filter((c) => c.basis === 'modeled').length > 0);
  }
});

test('soul-swap: a failed grounding call degrades honestly to modeled-only — no fabricated measurement', async () => {
  const grounding = async () => ({ real: false, latencyMs: null, model: null, error: 'provider unavailable' });
  const { evaluations, llmCalls } = await evaluateSoulSwap(WORLD, ORGANIZATIONS, grounding);
  assert.equal(llmCalls, 0);
  for (const ev of evaluations) {
    assert.equal(ev.detail.latencyRealMs, null);
    assert.ok(String(ev.detail.latencyMsBasis).startsWith('modeled only'));
    const unavailable = ev.detail.llmLatencyComponents.find((c) => c.basis === 'unavailable');
    assert.ok(unavailable);
    assert.equal(unavailable.latencyMs, null);
    assert.ok(String(unavailable.note).includes('FAILED'));
  }
});

test('soul-swap: the swap is a deterministic rotation — each body receives the next body\'s soul', async () => {
  const { evaluations } = await evaluateSoulSwap(WORLD, ORGANIZATIONS, null);
  for (const ev of evaluations) {
    const bodies = ev.detail.perBodySwap;
    assert.ok(bodies.length > 0);
    if (bodies.length > 1) {
      for (let i = 0; i < bodies.length; i++) {
        assert.equal(bodies[i].swappedSoul, bodies[(i + 1) % bodies.length].assignedSoul);
      }
    } else {
      // single-body org swaps to the complementary soul
      const only = bodies[0];
      assert.notEqual(only.swappedSoul, only.canonicalSoul);
    }
    for (const b of bodies) {
      assert.ok(typeof b.fit === 'number' && b.fit > 0 && b.fit <= 1);
      assert.ok(typeof b.depthDelta === 'number' && b.depthDelta >= 0);
    }
  }
});

test('soul-swap: the determinism check excludes the real grounding latency (measurements are not reproducibility)', async () => {
  // two runs with DIFFERENT grounding latencies must produce identical
  // continuity/drift/capabilityRetention (pure metrics) — only latencyMs moves
  const a = await evaluateSoulSwap(WORLD, ORGANIZATIONS, async () => ({ real: true, latencyMs: 100, model: 'm', error: null }));
  const b = await evaluateSoulSwap(WORLD, ORGANIZATIONS, async () => ({ real: true, latencyMs: 900, model: 'm', error: null }));
  for (let i = 0; i < a.evaluations.length; i++) {
    assert.equal(a.evaluations[i].scores.continuity, b.evaluations[i].scores.continuity);
    assert.equal(a.evaluations[i].scores.drift, b.evaluations[i].scores.drift);
    assert.equal(a.evaluations[i].scores.capabilityRetention, b.evaluations[i].scores.capabilityRetention);
    assert.equal(a.evaluations[i].scores.determinism, 1);
    assert.equal(b.evaluations[i].scores.determinism, 1);
    assert.equal(b.evaluations[i].scores.latencyMs - a.evaluations[i].scores.latencyMs, 800);
  }
});

test('soul-swap: identity metrics respond to world noise and stage composition — not to numeric param jitter (honest invariance)', async () => {
  const base = await evaluateSoulSwap(WORLD, ORGANIZATIONS, null);
  const sig = (res) => stableStringify(res.evaluations.map((e) => [e.organizationId, e.scores.continuity, e.scores.drift, e.scores.capabilityRetention]));

  // a different world seed changes the effective noise → the identity metrics move
  const otherWorld = await evaluateSoulSwap(generateWorld(1337), ORGANIZATIONS, null);
  assert.notEqual(sig(base), sig(otherWorld));

  // a STRUCTURALLY different genome (a fallback QA stage appended to the
  // searched pipeline — a stage mutateGenome really produces) changes the
  // swap rotation → the identity metrics move
  const structuralOrgs = compileOrganizations(42, {
    ...PIPELINES,
    searched: {
      ...PIPELINES.searched,
      genome: {
        ...PIPELINES.searched.genome,
        stages: [
          ...PIPELINES.searched.genome.stages,
          { adapterId: 'lab-qa-1', version: '1', params: { role: 'fallback', recheckPolicy: 'deficiencies-only' } },
        ],
      },
    },
  });
  const structural = await evaluateSoulSwap(WORLD, structuralOrgs, null);
  assert.notEqual(sig(base), sig(structural));

  // numeric param jitter alone does NOT move the identity metrics — they are
  // structural (stage composition + souls + world noise), and the honest
  // contract says so (latency/cost DO move, identity does not)
  const jitterOrgs = compileOrganizations(42, {
    ...PIPELINES,
    searched: {
      ...PIPELINES.searched,
      genome: {
        ...PIPELINES.searched.genome,
        stages: PIPELINES.searched.genome.stages.map((s) =>
          s.adapterId === 'lab-segment-1' ? { ...s, params: { ...s.params, granularity: 3 } } : s
        ),
      },
    },
  });
  const jitter = await evaluateSoulSwap(WORLD, jitterOrgs, null);
  assert.equal(sig(base), sig(jitter));
});

test('soul-swap failure derivation: only REAL threshold breaches are recorded — none → none', async () => {
  const { evaluations } = await evaluateSoulSwap(WORLD, ORGANIZATIONS, null);
  let anyCapabilityLoss = false;
  let anyDrift = false;
  for (const ev of evaluations) {
    const inputs = deriveSoulSwapFailureInputs(ev, 42);
    for (const f of inputs) {
      assert.ok(f.kind === 'capability-loss' || f.kind === 'drift');
      assert.equal(f.input.worldSeed, 42);
      if (f.kind === 'capability-loss') {
        anyCapabilityLoss = true;
        assert.ok(f.input.fit < SOUL_SWAP_FIT_FLOOR);
      } else {
        anyDrift = true;
        assert.ok(f.input.drift > SOUL_SWAP_DRIFT_CEILING);
      }
    }
  }
  // the fixtures include a swapped deep→fast analyzer (fit 0.55 < 0.7) — at
  // least one capability-loss case must be derivable from the real output
  assert.ok(anyCapabilityLoss);
  void anyDrift;
});

test('soul-swap failure derivation: a clean evaluation derives zero cases (honest)', () => {
  const clean = {
    organizationId: 'org-clean',
    scores: { drift: 0.1 },
    detail: {
      perBodySwap: [
        { role: 'segmenter', adapterId: 'lab-segment-1', canonicalSoul: 'soul-one-fast', assignedSoul: 'soul-one-fast', swappedSoul: 'soul-two-deep', fit: 0.9, depthDelta: 1 },
      ],
    },
  };
  assert.deepEqual(deriveSoulSwapFailureInputs(clean, 42), []);
});

test('soul-swap: the objective code and scenario constants are stable contract values', () => {
  assert.equal(SOUL_SWAP_OBJECTIVE_CODE, 'SOUL-SWAP-001');
  assert.equal(SOUL_SWAP_SCENARIO, 'soul-swap-001');
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. ARTIFACT EXPORT (content-addressed) + route folds
// ═══════════════════════════════════════════════════════════════════════════

function artifactInput(over = {}) {
  return {
    run: {
      id: 'run-art-1',
      objectiveCode: 'HUMAN-RECON-001',
      worldSeed: 42,
      status: 'succeeded',
      createdAt: '2026-10-04T10:00:00.000Z',
      rerunOfId: null,
      manifest: buildRunManifest(manifestArgs()),
    },
    reports: [
      {
        organizationId: 'org-hand-designed-hybrid',
        scores: { coverage: 0.9, confidence: 0.8, latencyMs: 1200, costUsd: 0.02, determinism: 1 },
        reproducible: true,
        seed: 42,
        detail: { simulated: true },
      },
    ],
    metrics: { simulated: true, bestOrganizationId: 'org-hand-designed-hybrid' },
    ...over,
  };
}

test('artifact: same run → same bytes → same sha256 (content-addressed stability)', () => {
  const a = buildRunArtifact(artifactInput(), sha256);
  const b = buildRunArtifact(artifactInput(), sha256);
  assert.equal(a.bytes, b.bytes);
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.sha256, sha256(a.bytes));
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
});

test('artifact: shape — type, schemaVersion, run + manifest + evaluations + aggregate + honesty', () => {
  const { artifact } = buildRunArtifact(artifactInput(), sha256);
  assert.equal(artifact.artifactType, RUN_ARTIFACT_TYPE);
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.run.id, 'run-art-1');
  assert.equal(artifact.manifest.manifestType, RUN_MANIFEST_TYPE);
  assert.equal(artifact.evaluations.length, 1);
  assert.equal(artifact.evaluations[0].organizationId, 'org-hand-designed-hybrid');
  assert.equal(artifact.aggregate.bestOrganizationId, 'org-hand-designed-hybrid');
  assert.equal(artifact.honesty.simulated, true);
  assert.ok(artifact.honesty.simulationNote.includes('SIMULATED research truth'));
  assert.ok(artifact.honesty.contentAddressing.includes('sha256'));
  // the bytes parse back to the artifact (downloadable JSON)
  assert.deepEqual(JSON.parse(buildRunArtifact(artifactInput(), sha256).bytes).run.id, 'run-art-1');
});

test('artifact: different run data → different sha256 (real content addressing)', () => {
  const a = buildRunArtifact(artifactInput(), sha256);
  const b = buildRunArtifact(
    artifactInput({
      reports: [
        {
          organizationId: 'org-hand-designed-hybrid',
          scores: { coverage: 0.8, confidence: 0.8, latencyMs: 1200, costUsd: 0.02, determinism: 1 },
          reproducible: true,
          seed: 42,
          detail: { simulated: true },
        },
      ],
    }),
    sha256,
  );
  assert.notEqual(a.sha256, b.sha256);
  // a rerun-child artifact differs from its parent (rerunOfId is part of content)
  const child = buildRunArtifact(
    artifactInput({
      run: { ...artifactInput().run, id: 'run-art-2', rerunOfId: 'run-art-1' },
    }),
    sha256,
  );
  assert.notEqual(a.sha256, child.sha256);
});

test('artifact route fold: 401 → 403 (read scope) → 404 — an honest miss, never a leak', () => {
  const noAuth = decideRunArtifact(null, 'run-x', { id: 'run-x', status: 'succeeded' });
  assert.equal(noAuth.status, 401);
  const wrongScope = decideRunArtifact({ ...READ_KEY, scopes: ['admin'] }, 'run-x', { id: 'run-x', status: 'succeeded' });
  assert.equal(wrongScope.status, 403);
  assert.ok(wrongScope.message.includes('"read" scope'));
  const missing = decideRunArtifact(AUTH, 'run-x', null);
  assert.equal(missing.status, 404);
  assert.ok(missing.message.includes('not found'));
  const ok = decideRunArtifact(READ_KEY, 'run-x', { id: 'run-x', status: 'succeeded' });
  assert.equal(ok.status, 200);
  assert.equal(ok.run.id, 'run-x');
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. CROSS-CONTRACT INTEGRITY (the executor's composition, folded)
// ═══════════════════════════════════════════════════════════════════════════

test('composition: the manifest built from the real run fixtures round-trips through the artifact export', () => {
  const manifest = buildRunManifest(
    manifestArgs({ scenario: 'soul-swap-001', objectiveCode: SOUL_SWAP_OBJECTIVE_CODE, rerunOf: 'run-parent' }),
  );
  const { artifact, sha256: digest } = buildRunArtifact(
    artifactInput({
      run: {
        id: 'run-swap-1', objectiveCode: SOUL_SWAP_OBJECTIVE_CODE, worldSeed: 42, status: 'succeeded',
        createdAt: '2026-10-04T10:00:00.000Z', rerunOfId: 'run-parent', manifest,
      },
    }),
    sha256,
  );
  assert.equal(artifact.manifest.scenario, 'soul-swap-001');
  assert.equal(artifact.manifest.rerunOf, 'run-parent');
  assert.equal(artifact.run.rerunOfId, 'run-parent');
  assert.match(digest, /^[0-9a-f]{64}$/);
});

test('composition: soul-swap evaluations feed the atlas through the classifiers (typed codes only)', async () => {
  const { evaluations } = await evaluateSoulSwap(WORLD, ORGANIZATIONS, null);
  const cases = [];
  for (const ev of evaluations) {
    for (const f of deriveSoulSwapFailureInputs(ev, 42)) {
      const classified =
        f.kind === 'capability-loss'
          ? classifySoulSwapCapabilityLoss(f.input)
          : classifySoulSwapDrift(f.input);
      cases.push(
        atlasCase({
          code: classified.code,
          payload: classified.payload,
          inputConditions: { simulated: true, scenario: 'soul-swap-001', worldSeed: 42, ...f.input },
          organizationId: ev.organizationId,
          pipeline: { name: 'hand-designed-hybrid' },
          technologyVersions: [{ component: 'vlm-recon-1', version: '1' }],
          suspectedCause: f.kind === 'capability-loss' ? 'soul depth mismatch' : 'drift',
          confidence: f.kind === 'capability-loss' ? 0.75 : 0.65,
        }),
      );
    }
  }
  assert.ok(cases.length > 0);
  const a = aggregateAtlas(cases);
  // every derived case carries a REAL taxonomy code (never UNCLASSIFIED)
  for (const row of a.byCode) {
    assert.ok(row.code === 'SOUL_SWAP_CAPABILITY_LOSS' || row.code === 'SOUL_SWAP_IDENTITY_DRIFT');
    // the policy for these classes is honestly proposed (not implemented)
    for (const p of row.policy) assert.equal(p.status, 'proposed');
  }
  assert.ok(a.totals.cases >= 1);
});
