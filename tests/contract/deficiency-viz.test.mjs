// ═══════════════════════════════════════════════════════════════════════════
// YOU deficiency-visualization tests (P6.B4, Worker B lane) — node:test.
//
// Covers the honest quality-deficiency surface end to end:
//
// PURE UNIT half (imports lib/you/core/deficiency.ts directly — Node ≥ 23.6
// type stripping, same law as the f1-recon / ux-states suites; no network,
// no db, no React):
//   1. HONEST EMPTY STATE — no captures, no version → every capability is
//      `unknown` with an honest reason; NEVER coerced into ok; disclosures
//      carry the no-captures note; remedies exist for unknown rows.
//   2. UNKNOWN STAYS UNKNOWN — pending steps, optional skips, unanalyzed
//      assets without a version, and pending checklist items produce NO
//      positive signal; only done+passed / provided / usable / observed
//      evidence can produce `ok` (with an honest declared-vs-observed basis).
//   3. DEFICIENT ONLY WITH A REAL SOURCE — skipped required steps, persisted
//      failed checkpoints (incl. the B3 step-stays-current shape), HTIR
//      deficiency entries, waived checklist items, unusable analyzed assets;
//      every deficient row cites at least one source signal.
//   4. COMPLEMENT COVERAGE — regions ABSENT from a reconstruction's
//      deficiencies list are machine-observed positives (the C-lane
//      aggregation emits one entry per unobserved canonical region).
//   5. CROSS-SESSION SLOT RESOLUTION — newer done+passed evidence supersedes
//      an older skip for the same step (state resolves, history disclosed);
//      per-region usable assets supersede unusable siblings.
//   6. REMEDY PAYLOAD SHAPE — ready-to-POST EvidenceRequest payloads
//      (reason/capability/instructions/expectedSignal/scope/twinVersionId)
//      on deficient/unknown rows; null on ok rows.
//   7. VERSION DELTA — improved / regressed / unchanged / unknown per
//      capability, severity transitions inside deficient, honest `unknown`
//      for transitions involving unknown, summary counts.
//   8. DETERMINISM — same inputs (fixed clock, SHUFFLED captures order) →
//      byte-identical report JSON.
//
// API half (boots/reuses the shared app server like the W4.A/B3 suites;
// no network beyond 127.0.0.1; direct Prisma seeding mirrors the persisted
// row shapes):
//   9.  honest empty state + envelope shape on a fresh twin (200).
//   10. auth + tenant isolation: 401 anonymous; 404 unknown twin; a second
//       tenant (Prisma-seeded API key) gets 404 for tenant A's twin while
//       the owner gets 200; 404 for foreign/nonexistent versionId.
//   11. aggregation over SEEDED persisted state (protocol steps, failed
//       checkpoint, checkpoints summary, assets with quality, two versions
//       with different confidence summaries): default = latest version,
//       ?versionId= selects a specific one, ?baselineVersionId= returns the
//       delta; sources cite the real session/version ids.
//   12. remedy round-trip — POSTing a report's remedy payload to the existing
//       /evidence-requests route creates the targeted request (201).
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
  DEFICIENCY_CAPABILITIES,
  DEFICIENCY_REPORT_VERSION,
  buildDeficiencyReport,
  diffDeficiencyReports,
} from '../../apps/web/src/lib/you/core/deficiency.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const APP_DIR = path.join(REPO_ROOT, 'apps', 'web');

const stamp = `${Date.now()}-${process.pid}`;
const NOW = new Date('2026-10-04T12:00:00.000Z'); // fixed clock for determinism

// ─── pure fixtures ───────────────────────────────────────────────────────────

/** One guided F1 protocol step (the persisted F1GuidedStep shape). */
function gstep(id, state, extra = {}) {
  return {
    step: 1, id, label: id, instruction: `Capture: ${id}.`, regions: [],
    required: true, state, ...extra,
  };
}

function passedCheckpoint(stepId, score = 1) {
  return {
    stepId, passed: true,
    checks: { filePresent: true, plausibleSize: true, decodable: true, plausibleAspect: true, requiredRegionsCovered: 'declared' },
    issues: [], score,
  };
}

function failedCheckpoint(stepId) {
  return {
    stepId, passed: false,
    checks: { filePresent: true, plausibleSize: false, decodable: false, plausibleAspect: null, requiredRegionsCovered: 'none' },
    refusal: { code: 'evidence_undecodable', message: 'bytes match no recognized container signature' },
    issues: ['evidence_undecodable: bytes match no recognized container signature'],
    score: 0,
  };
}

/** A guided capture session fixture (persisted shapes). */
function session(id, steps, overrides = {}) {
  return {
    id, status: 'complete',
    createdAt: '2026-10-03T00:00:00.000Z', completedAt: '2026-10-03T01:00:00.000Z',
    error: null,
    protocol: { version: 'f1-operator-capture/v1', source: 'docs/F1_OPERATOR_CAPTURE.md', steps, currentStepId: null },
    checkpoints: { stepsChecked: steps.length, stepsPassed: steps.filter((s) => s.checkpoint?.passed !== false).length, stepsDone: steps.filter((s) => s.state === 'done').length, averageStepScore: 0.9, manifestVerified: true },
    checklist: [],
    assets: [],
    ...overrides,
  };
}

function version(id, num, deficiencies, overrides = {}) {
  return {
    id, version: num, createdAt: '2026-10-03T02:00:00.000Z',
    confidenceSummary: { overall: 0.55, byDomain: { morphology: 0.6, appearance: 0.5 }, deficiencies },
    ...overrides,
  };
}

const row = (report, capability) => report.capabilities.find((r) => r.capability === capability);
const states = (report) => Object.fromEntries(report.capabilities.map((r) => [r.capability, r.state]));

// ─── 1. honest empty state ───────────────────────────────────────────────────

test('deficiency pure: honest empty state — no captures, no version, all unknown', () => {
  const report = buildDeficiencyReport({ twinId: 't-empty', version: null, captures: [] }, NOW);
  assert.equal(report.version, DEFICIENCY_REPORT_VERSION);
  assert.equal(report.twinVersionId, null);
  assert.equal(report.twinVersionNumber, null);
  assert.deepEqual(report.capabilities.map((r) => r.capability), [...DEFICIENCY_CAPABILITIES]);
  for (const r of report.capabilities) {
    assert.equal(r.state, 'unknown', `${r.capability} must be unknown (never coerced to ok)`);
    assert.equal(r.severity, null);
    assert.equal(r.basis, 'none');
    assert.match(r.reason, /no capture sessions exist/);
    assert.ok(r.sources.length === 0);
    assert.ok(r.remedy, 'unknown rows still carry a ready-to-POST remedy');
    assert.equal(r.remedy.twinVersionId, null);
  }
  assert.deepEqual(report.summary, { ok: 0, deficient: 0, unknown: 6, total: 6 });
  assert.ok(report.disclosures.some((d) => d.includes('no capture sessions exist')));
  assert.ok(report.disclosures.some((d) => d.includes('no TwinVersion exists')));
});

// ─── 2. unknown stays unknown ────────────────────────────────────────────────

test('deficiency pure: unknown stays unknown — pending steps and optional skips are never positives', () => {
  // a session in progress: every step pending, no assets, no checklist progress
  const inProgress = session('cs-ip', [
    gstep('face-front', 'current'), gstep('face-turn', 'pending'), gstep('upper-body', 'pending'),
    gstep('full-body', 'pending'), gstep('hands', 'pending'), gstep('turn-around', 'pending'),
    gstep('walking', 'pending'), gstep('speech', 'pending', { required: false }),
  ], { status: 'pending', completedAt: null });
  const report = buildDeficiencyReport({ twinId: 't-ip', version: null, captures: [inProgress] }, NOW);
  const s = states(report);
  assert.equal(s.face, 'unknown');
  assert.equal(s.hair, 'unknown');
  assert.equal(s.hands, 'unknown');
  assert.equal(s.silhouette, 'unknown');
  assert.equal(s.motion, 'unknown');
  assert.equal(s.speech, 'unknown');
  assert.equal(report.summary.unknown, 6);
  // pending checklist items are neutral too — never a positive
  const legacyPending = session('cs-legacy', [], {
    protocol: null, checkpoints: null,
    checklist: [
      { item: 'Frontal face', capability: 'face', region: 'face.front', instructions: 'x', status: 'pending', expectedSignal: 'y' },
      { item: 'Hands', capability: 'hands', region: 'hands', instructions: 'x', status: 'pending', expectedSignal: 'y' },
    ],
  });
  const report2 = buildDeficiencyReport({ twinId: 't-legacy', version: null, captures: [legacyPending] }, NOW);
  assert.equal(row(report2, 'face').state, 'unknown');
  assert.equal(row(report2, 'hands').state, 'unknown');
});

test('deficiency pure: done+passed steps are ok at the DECLARED tier (basis honesty)', () => {
  const s = session('cs-ok', [
    gstep('face-front', 'done', { checkpoint: passedCheckpoint('face-front'), assetId: 'a1' }),
    gstep('face-turn', 'done', { checkpoint: passedCheckpoint('face-turn'), assetId: 'a2' }),
    gstep('upper-body', 'done', { checkpoint: passedCheckpoint('upper-body'), assetId: 'a3' }),
    gstep('full-body', 'done', { checkpoint: passedCheckpoint('full-body'), assetId: 'a4' }),
    gstep('hands', 'done', { checkpoint: passedCheckpoint('hands'), assetId: 'a5' }),
    gstep('turn-around', 'done', { checkpoint: passedCheckpoint('turn-around'), assetId: 'a6' }),
    gstep('walking', 'done', { checkpoint: passedCheckpoint('walking'), assetId: 'a7' }),
    gstep('speech', 'skipped', { required: false, skipReason: 'prefers not to' }),
  ]);
  // no version → no machine-observed tier available anywhere
  const report = buildDeficiencyReport({ twinId: 't-declared', version: null, captures: [s] }, NOW);
  assert.equal(row(report, 'face').state, 'ok');
  assert.equal(row(report, 'face').basis, 'declared', 'byte-level checkpoints are declared-tier, not observed');
  assert.match(row(report, 'face').reason, /declared-level evidence only/);
  assert.equal(row(report, 'speech').state, 'unknown', 'optional skip without a version listing it stays unknown');
  assert.match(row(report, 'speech').reason, /optional step "speech" skipped/);
});

// ─── 3. deficient only with a real source signal ─────────────────────────────

test('deficiency pure: deficient only with a real source — skip, failed checkpoint, htir, waived, unusable asset', () => {
  // (a) skipped REQUIRED step
  const skipped = buildDeficiencyReport({
    twinId: 't-a', version: null,
    captures: [session('cs-a', [gstep('face-turn', 'skipped', { skipReason: 'headset worn' })])],
  }, NOW);
  const faceA = row(skipped, 'face');
  assert.equal(faceA.state, 'deficient');
  assert.equal(faceA.severity, 'high'); // face.profile is a high-importance region
  assert.ok(faceA.sources.some((s) => s.kind === 'capture-step' && s.signal === 'negative' && s.detail.includes('headset worn')));

  // (b) persisted FAILED checkpoint with the step still current (the B3 shape)
  const failed = buildDeficiencyReport({
    twinId: 't-b', version: null,
    captures: [session('cs-b', [gstep('hands', 'current', { checkpoint: failedCheckpoint('hands'), assetId: 'a-garbage' })])],
  }, NOW);
  const handsB = row(failed, 'hands');
  assert.equal(handsB.state, 'deficient');
  assert.equal(handsB.severity, 'high');
  assert.ok(handsB.sources.some((s) => s.kind === 'capture-checkpoint' && s.signal === 'negative' && s.detail.includes('step remains current')));

  // (c) HTIR deficiency entry from the reconstruction
  const htir = buildDeficiencyReport({
    twinId: 't-c',
    version: version('v1', 1, [{ capability: 'hair.back', severity: 'high', reason: 'No evidence asset observes the "hair.back" region.', remediation: 'Capture a rear-view photo.' }]),
    captures: [],
  }, NOW);
  const hairC = row(htir, 'hair');
  assert.equal(hairC.state, 'deficient');
  assert.equal(hairC.severity, 'high');
  assert.ok(hairC.sources.some((s) => s.kind === 'htir-deficiency' && s.twinVersionId === 'v1'));

  // (d) waived checklist item — a real, persisted deliberate gap
  const waived = buildDeficiencyReport({
    twinId: 't-d', version: null,
    captures: [session('cs-d', [], {
      protocol: null, checkpoints: null,
      checklist: [{ item: 'Back of hair', capability: 'hair', region: 'hair.back', instructions: 'x', status: 'waived', expectedSignal: 'y' }],
    })],
  }, NOW);
  const hairD = row(waived, 'hair');
  assert.equal(hairD.state, 'deficient');
  assert.equal(hairD.severity, 'low');
  assert.ok(hairD.sources.some((s) => s.kind === 'checklist-item' && s.signal === 'negative' && s.detail.includes('waived')));

  // (e) analyzed UNUSABLE asset
  const unusable = buildDeficiencyReport({
    twinId: 't-e', version: null,
    captures: [session('cs-e', [], {
      protocol: null, checkpoints: null, checklist: [],
      assets: [{ id: 'a-blurry', regions: ['face.front'], quality: { usable: false, blur: 'heavy', lighting: 'poor', coverage: ['face.front'], issues: ['heavy blur'], score: 0.1 } }],
    })],
  }, NOW);
  const faceE = row(unusable, 'face');
  assert.equal(faceE.state, 'deficient');
  assert.equal(faceE.severity, 'high');
  assert.ok(faceE.sources.some((s) => s.kind === 'asset-quality' && s.signal === 'negative' && s.detail.includes('UNUSABLE')));
});

// ─── 4. complement coverage ──────────────────────────────────────────────────

test('deficiency pure: complement coverage — unlisted regions are machine-observed positives', () => {
  const report = buildDeficiencyReport({
    twinId: 't-cc',
    version: version('v1', 1, [{ capability: 'face.profile', severity: 'high', reason: 'not observed', remediation: 'capture profile' }]),
    captures: [],
  }, NOW);
  const face = row(report, 'face');
  assert.equal(face.state, 'deficient'); // face.profile listed
  assert.ok(face.sources.some((s) => s.kind === 'htir-coverage' && s.region === 'face.front' && s.signal === 'positive'));
  const hair = row(report, 'hair');
  assert.equal(hair.state, 'ok');
  assert.equal(hair.basis, 'observed');
  assert.ok(hair.sources.every((s) => s.signal === 'positive'));
  assert.equal(report.summary.deficient, 1);
  assert.equal(report.summary.ok, 5);
});

// ─── 5. cross-session slot resolution ────────────────────────────────────────

test('deficiency pure: cross-session resolution — newer done evidence supersedes an older skip (history disclosed)', () => {
  const older = session('cs-old', [
    gstep('face-front', 'done', { checkpoint: passedCheckpoint('face-front'), assetId: 'a1' }),
    gstep('face-turn', 'skipped', { skipReason: 'operator missed it' }),
  ], { createdAt: '2026-10-01T00:00:00.000Z', completedAt: '2026-10-01T01:00:00.000Z' });
  const newer = session('cs-new', [
    gstep('face-front', 'done', { checkpoint: passedCheckpoint('face-front'), assetId: 'a2' }),
    gstep('face-turn', 'done', { checkpoint: passedCheckpoint('face-turn'), assetId: 'a3' }),
  ], { createdAt: '2026-10-02T00:00:00.000Z', completedAt: '2026-10-02T01:00:00.000Z' });
  const report = buildDeficiencyReport({ twinId: 't-x', version: null, captures: [newer, older] }, NOW);
  const face = row(report, 'face');
  assert.equal(face.state, 'ok', 'the newer session captured face-turn — the older skip cannot un-capture it');
  // history is still disclosed: the skip remains a citable negative source
  assert.ok(face.sources.some((s) => s.signal === 'negative' && s.detail.includes('operator missed it')));
  // and the newest done is cited first
  assert.equal(face.sources.find((s) => s.signal === 'positive' && s.stepId === 'face-front').captureSessionId, 'cs-new');
});

test('deficiency pure: per-region asset resolution — a usable asset beats an unusable sibling', () => {
  const report = buildDeficiencyReport({
    twinId: 't-asset', version: null,
    captures: [session('cs-assets', [], {
      protocol: null, checkpoints: null, checklist: [],
      assets: [
        { id: 'a-bad', regions: ['face.front'], quality: { usable: false, blur: 'heavy', lighting: 'poor', coverage: ['face.front'], issues: ['heavy blur'], score: 0.1 } },
        { id: 'a-good', regions: ['face.front'], quality: { usable: true, blur: 'none', lighting: 'good', coverage: ['face.front'], issues: [], score: 0.95 } },
      ],
    })],
  }, NOW);
  const face = row(report, 'face');
  assert.equal(face.state, 'ok', 'usable evidence exists for face.front');
  assert.equal(face.basis, 'observed');
  assert.ok(face.sources.some((s) => s.signal === 'negative' && s.assetId === 'a-bad'), 'the unusable sibling is still disclosed');
});

// ─── 6. remedy payload shape ─────────────────────────────────────────────────

test('deficiency pure: remedy payload shape — ready-to-POST, ok rows null', () => {
  const report = buildDeficiencyReport({
    twinId: 't-remedy',
    version: version('v9', 3, [{ capability: 'hands', severity: 'high', reason: 'not observed', remediation: 'capture hands' }]),
    captures: [session('cs-r', [gstep('hands', 'current', { checkpoint: failedCheckpoint('hands'), assetId: 'a-g' })])],
  }, NOW);
  const hands = row(report, 'hands');
  assert.equal(hands.state, 'deficient');
  const remedy = hands.remedy;
  assert.ok(remedy, 'deficient rows carry a remedy');
  // the exact POST /api/v1/evidence-requests field set
  assert.deepEqual(Object.keys(remedy).sort(), ['capability', 'expectedSignal', 'instructions', 'reason', 'scope', 'twinVersionId']);
  assert.equal(typeof remedy.reason, 'string');
  assert.ok(remedy.reason.length > 0 && remedy.reason.length <= 1000);
  assert.ok(remedy.capability.length > 0 && remedy.capability.length <= 60);
  assert.ok(remedy.instructions.trim().length > 0);
  assert.ok(remedy.expectedSignal.trim().length > 0);
  assert.equal(remedy.scope, 'single additional capture for the stated deficiency; derived outputs only');
  assert.equal(remedy.twinVersionId, 'v9');
  // ok rows never carry a remedy
  const okRows = report.capabilities.filter((r) => r.state === 'ok');
  for (const r of okRows) assert.equal(r.remedy, null, `${r.capability} is ok — no remedy`);
  // unknown rows do (establish-the-capability wording)
  const unknownRows = report.capabilities.filter((r) => r.state === 'unknown');
  for (const r of unknownRows) {
    assert.ok(r.remedy);
    assert.match(r.remedy.reason, /Establish the/);
  }
});

// ─── 7. version delta ────────────────────────────────────────────────────────

test('deficiency pure: version delta — improved / regressed / unchanged / unknown + severity transitions', () => {
  const mk = (deficiencies) => buildDeficiencyReport({
    twinId: 't-delta',
    version: version('vx', 1, deficiencies),
    captures: [session('cs-delta', [
      gstep('face-front', 'done', { checkpoint: passedCheckpoint('face-front'), assetId: 'a1' }),
      gstep('face-turn', 'done', { checkpoint: passedCheckpoint('face-turn'), assetId: 'a2' }),
      gstep('upper-body', 'done', { checkpoint: passedCheckpoint('upper-body'), assetId: 'a3' }),
      gstep('full-body', 'done', { checkpoint: passedCheckpoint('full-body'), assetId: 'a4' }),
      gstep('hands', 'done', { checkpoint: passedCheckpoint('hands'), assetId: 'a5' }),
      gstep('turn-around', 'done', { checkpoint: passedCheckpoint('turn-around'), assetId: 'a6' }),
      gstep('walking', 'done', { checkpoint: passedCheckpoint('walking'), assetId: 'a7' }),
      gstep('speech', 'skipped', { required: false, skipReason: 'prefers not to' }),
    ])],
  }, NOW);

  const d = (capability, severity) => ({ capability, severity, reason: `not observed: ${capability}`, remediation: 'capture it' });
  // baseline: hands deficient HIGH, hair deficient LOW; comparison: hands ok, hair deficient HIGH
  const baseline = mk([d('hands', 'high'), d('hair.back', 'low')]);
  const comparison = mk([d('hair.back', 'high')]);
  const delta = diffDeficiencyReports(baseline, comparison);
  assert.equal(delta.version, 'deficiency-delta/v1');

  const hands = delta.rows.find((r) => r.capability === 'hands');
  assert.equal(hands.delta, 'improved');
  assert.deepEqual(hands.from, { state: 'deficient', severity: 'high' });
  assert.deepEqual(hands.to, { state: 'ok', severity: null });

  const hair = delta.rows.find((r) => r.capability === 'hair');
  assert.equal(hair.delta, 'regressed', 'deficient low → deficient high is a regression');
  assert.equal(hair.from.severity, 'low');
  assert.equal(hair.to.severity, 'high');

  const face = delta.rows.find((r) => r.capability === 'face');
  assert.equal(face.delta, 'unchanged', 'ok → ok');

  const speech = delta.rows.find((r) => r.capability === 'speech');
  assert.equal(speech.delta, 'unchanged', 'ok → ok (speech was complement-covered in both reports)');

  assert.deepEqual(delta.summary, { improved: 1, regressed: 1, unchanged: 4, unknown: 0 }, 'every capability is complement-covered in both reports');

  // severity easing inside deficient is an improvement
  const a2 = mk([d('hands', 'high')]);
  const b2 = mk([d('hands', 'low')]);
  assert.equal(diffDeficiencyReports(a2, b2).rows.find((r) => r.capability === 'hands').delta, 'improved');
  assert.equal(diffDeficiencyReports(b2, a2).rows.find((r) => r.capability === 'hands').delta, 'regressed');
  assert.equal(diffDeficiencyReports(a2, mk([d('hands', 'high')])).rows.find((r) => r.capability === 'hands').delta, 'unchanged');

  // no-version baseline → every delta row involving unknown stays unknown
  const noVersion = buildDeficiencyReport({ twinId: 't-delta', version: null, captures: [] }, NOW);
  const delta2 = diffDeficiencyReports(noVersion, comparison);
  assert.equal(delta2.summary.unknown, 6);
});

// ─── 8. determinism ──────────────────────────────────────────────────────────

test('deficiency pure: determinism — fixed clock + shuffled captures → byte-identical JSON', () => {
  const s1 = session('cs-one', [gstep('face-front', 'done', { checkpoint: passedCheckpoint('face-front'), assetId: 'a1' })], {
    createdAt: '2026-10-01T00:00:00.000Z', completedAt: '2026-10-01T01:00:00.000Z',
    assets: [{ id: 'a1', regions: ['face.front'], quality: { usable: true, blur: 'none', lighting: 'good', coverage: ['face.front'], issues: [], score: 0.9 } }],
  });
  const s2 = session('cs-two', [
    gstep('face-turn', 'skipped', { skipReason: 'missed' }),
    gstep('hands', 'current', { checkpoint: failedCheckpoint('hands'), assetId: 'a2' }),
  ], {
    createdAt: '2026-10-02T00:00:00.000Z', completedAt: '2026-10-02T01:00:00.000Z',
    assets: [{ id: 'a2', regions: ['hands'], quality: { usable: false, blur: 'heavy', lighting: 'poor', coverage: ['hands'], issues: ['blur'], score: 0.1 } }],
  });
  const input = (captures) => ({
    twinId: 't-det',
    version: version('v1', 1, [{ capability: 'speech', severity: 'low', reason: 'no sample', remediation: 'record speech' }]),
    captures,
  });
  const a = JSON.stringify(buildDeficiencyReport(input([s1, s2]), NOW));
  const b = JSON.stringify(buildDeficiencyReport(input([s2, s1]), NOW)); // shuffled
  assert.equal(a, b);
});

// ═══════════════════════════════════════════════════════════════════════════
// API half — boots/reuses the shared app server (W4.A/B3 suite law)
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
          console.log(`[b4-tests] reusing suite server at ${base}`);
          return base;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(!aggregated, 'aggregated run: the sibling suite never published its server URL within 150s');
      console.log('[b4-tests] booting apps/web (next dev) on a free port…');
      await startServer();
      ownServer = true;
      console.log(`[b4-tests] server ready at ${base}`);
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
    console.log('[b4-tests] own server stopped');
  }
});

// shared state across the sequential API tests
let twinA = null;
let twinB = null;
let foreignKey = null; // tenant-B API key secret (you_sk_…)
let seeded = null; // { s1, s2, v1, v2, assetIds }

const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Seed a complete guided-session row + assets + two TwinVersions for twinA. */
async function seedDeficiencyState() {
  const db = await prisma();
  const t = await db.twin.findUnique({ where: { id: twinA.id } });
  assert.ok(t, 'twinA row exists');

  // run-unique asset ids (the SQLite db persists across runs — fixed ids
  // would collide on the unique constraint)
  const aFaceFront = `seed-a-ff-${stamp}`;
  const aUpper = `seed-a-ub-${stamp}`;
  const aFull = `seed-a-fb-${stamp}`;
  const aHandsGarbage = `seed-a-hg-${stamp}`;
  const aBack = `seed-a-bk-${stamp}`;
  const aWalk = `seed-a-wk-${stamp}`;
  const bFaceTurn = `seed-b-ft-${stamp}`;
  const bHands = `seed-b-hd-${stamp}`;
  const aUnanalyzed = `seed-a-ua-${stamp}`;

  const iso = (d) => new Date(d).toISOString();
  const stepsS1 = [
    { step: 1, id: 'face-front', label: 'face/front', instruction: 'Face the camera.', regions: ['face.front'], required: true, state: 'done', assetId: aFaceFront, checkpoint: passedCheckpoint('face-front'), submittedAt: iso('2026-10-01T00:10:00Z') },
    { step: 2, id: 'face-turn', label: 'face/turn', instruction: 'Turn left/right.', regions: ['face.profile'], required: true, state: 'skipped', skipReason: 'operator missed the profile shots' },
    { step: 3, id: 'upper-body', label: 'upper body', instruction: 'Waist up.', regions: ['silhouette.front'], required: true, state: 'done', assetId: aUpper, checkpoint: passedCheckpoint('upper-body'), submittedAt: iso('2026-10-01T00:20:00Z') },
    { step: 4, id: 'full-body', label: 'full body', instruction: 'Head to feet.', regions: ['silhouette.front'], required: true, state: 'done', assetId: aFull, checkpoint: passedCheckpoint('full-body', 0.8), submittedAt: iso('2026-10-01T00:25:00Z') },
    { step: 5, id: 'hands', label: 'hands', instruction: 'Both hands.', regions: ['hands'], required: true, state: 'current', assetId: aHandsGarbage, checkpoint: failedCheckpoint('hands') },
    { step: 6, id: 'turn-around', label: 'turn-around', instruction: 'Back to camera.', regions: ['hair.back', 'silhouette.side'], required: true, state: 'done', assetId: aBack, checkpoint: passedCheckpoint('turn-around'), submittedAt: iso('2026-10-01T00:35:00Z') },
    { step: 7, id: 'walking', label: 'walking', instruction: 'Walk naturally.', regions: ['walking'], required: true, state: 'done', assetId: aWalk, checkpoint: passedCheckpoint('walking'), submittedAt: iso('2026-10-01T00:40:00Z') },
    { step: 8, id: 'speech', label: 'speech', instruction: 'Optional speech.', regions: ['speech'], required: false, state: 'skipped', skipReason: 'prefers not to' },
  ];
  const s1 = await db.captureSession.create({
    data: {
      tenantId: t.tenantId, twinId: t.id, status: 'complete',
      checklist: '[]',
      createdAt: new Date('2026-10-01T00:00:00Z'), completedAt: new Date('2026-10-01T01:00:00Z'),
      protocol: JSON.stringify({ version: 'f1-operator-capture/v1', source: 'docs/F1_OPERATOR_CAPTURE.md', steps: stepsS1, currentStepId: 'hands' }),
      checkpoints: JSON.stringify({
        version: 'f1-checkpoint-summary/v1', stepsChecked: 6, stepsPassed: 5,
        checkpointsFailed: [{ assetId: aHandsGarbage, stepId: 'hands', refusal: { code: 'evidence_undecodable', message: 'bytes match no recognized container signature' } }],
        stepsDone: 6, stepsSkipped: [{ stepId: 'face-turn', reason: 'operator missed the profile shots', required: true }, { stepId: 'speech', reason: 'prefers not to', required: false }],
        skippedRequired: ['face-turn'], averageStepScore: 0.966, manifestVerified: true,
        consentGrantId: 'seed-grant', trainingPermitted: false, summarizedAt: iso('2026-10-01T01:00:00Z'),
      }),
      review: JSON.stringify({ status: 'none' }),
    },
  });

  const asset = (id, region, quality) => ({
    id, tenantId: t.tenantId, captureSessionId: s1.id, kind: 'image',
    storageKey: `seed/${id}`, contentHash: sha256hex(`seed-${id}-${stamp}`), bytes: 1234, mime: 'image/png',
    regions: JSON.stringify([region]), quality: quality === null ? null : JSON.stringify(quality),
  });
  await db.evidenceAsset.createMany({
    data: [
      asset(aFaceFront, 'face.front', { usable: true, blur: 'none', lighting: 'good', coverage: ['face.front'], issues: [], score: 0.95 }),
      asset(aHandsGarbage, 'hands', { usable: false, blur: 'heavy', lighting: 'poor', coverage: ['hands'], issues: ['evidence_undecodable'], score: 0 }),
      asset(aUnanalyzed, 'hair.back', null),
    ],
  });

  // S2 (newer): resolves face-turn + hands with fresh passing evidence
  const stepsS2 = [
    { step: 2, id: 'face-turn', label: 'face/turn', instruction: 'Turn left/right.', regions: ['face.profile'], required: true, state: 'done', assetId: bFaceTurn, checkpoint: passedCheckpoint('face-turn'), submittedAt: iso('2026-10-02T00:10:00Z') },
    { step: 5, id: 'hands', label: 'hands', instruction: 'Both hands.', regions: ['hands'], required: true, state: 'done', assetId: bHands, checkpoint: passedCheckpoint('hands'), submittedAt: iso('2026-10-02T00:20:00Z') },
  ];
  const s2 = await db.captureSession.create({
    data: {
      tenantId: t.tenantId, twinId: t.id, status: 'complete', checklist: '[]',
      createdAt: new Date('2026-10-02T00:00:00Z'), completedAt: new Date('2026-10-02T00:30:00Z'),
      protocol: JSON.stringify({ version: 'f1-operator-capture/v1', source: 'docs/F1_OPERATOR_CAPTURE.md', steps: stepsS2, currentStepId: null }),
      checkpoints: JSON.stringify({ version: 'f1-checkpoint-summary/v1', stepsChecked: 2, stepsPassed: 2, checkpointsFailed: [], stepsDone: 2, stepsSkipped: [], skippedRequired: [], averageStepScore: 1, manifestVerified: true, consentGrantId: 'seed-grant', trainingPermitted: false, summarizedAt: iso('2026-10-02T00:30:00Z') }),
      review: JSON.stringify({ status: 'none' }),
    },
  });
  await db.evidenceAsset.createMany({
    data: [
      { id: bFaceTurn, tenantId: t.tenantId, captureSessionId: s2.id, kind: 'image', storageKey: `seed/${bFaceTurn}`, contentHash: sha256hex(`${bFaceTurn}-${stamp}`), bytes: 1234, mime: 'image/png', regions: JSON.stringify(['face.profile']), quality: JSON.stringify({ usable: true, blur: 'none', lighting: 'good', coverage: ['face.profile'], issues: [], score: 0.9 }) },
      { id: bHands, tenantId: t.tenantId, captureSessionId: s2.id, kind: 'image', storageKey: `seed/${bHands}`, contentHash: sha256hex(`${bHands}-${stamp}`), bytes: 1234, mime: 'image/png', regions: JSON.stringify(['hands']), quality: JSON.stringify({ usable: true, blur: 'none', lighting: 'good', coverage: ['hands'], issues: [], score: 0.92 }) },
    ],
  });

  const htirStub = JSON.stringify({ twinId: t.id, version: 1, provenance: { subjectId: t.subjectId } });
  const v1 = await db.twinVersion.create({
    data: {
      twinId: t.id, version: 1, status: 'published', htir: htirStub,
      evidenceAssetIds: JSON.stringify([aFaceFront]),
      confidenceSummary: JSON.stringify({
        overall: 0.5, byDomain: { morphology: 0.6, appearance: 0.5, geometry: 0.5 },
        deficiencies: [
          { capability: 'face.profile', severity: 'high', reason: 'No evidence asset in this set observes the "face.profile" region of the subject.', remediation: 'Capture a ¾ or full side-profile photo of the face.' },
          { capability: 'hands', severity: 'high', reason: 'No evidence asset in this set observes the "hands" region of the subject.', remediation: 'Capture palms and backs of both hands.' },
          { capability: 'speech', severity: 'low', reason: 'No speech sample in this set.', remediation: 'Record a short speech clip.' },
        ],
      }),
      createdAt: new Date('2026-10-01T02:00:00Z'),
    },
  });
  const v2 = await db.twinVersion.create({
    data: {
      twinId: t.id, version: 2, status: 'published', htir: htirStub,
      evidenceAssetIds: JSON.stringify([aFaceFront, bFaceTurn, bHands]),
      confidenceSummary: JSON.stringify({
        overall: 0.7, byDomain: { morphology: 0.7, appearance: 0.6, geometry: 0.65 },
        deficiencies: [
          { capability: 'speech', severity: 'low', reason: 'No speech sample in this set.', remediation: 'Record a short speech clip.' },
        ],
      }),
      createdAt: new Date('2026-10-02T02:00:00Z'),
    },
  });
  await db.twin.update({ where: { id: t.id }, data: { currentVersion: 2, status: 'reconstructed' } });

  return { s1, s2, v1, v2 };
}

// ─── 9. honest empty state at the API level ─────────────────────────────────

test('deficiency api: honest empty state + envelope shape on a fresh twin', async () => {
  await ensureBase();
  await call('/api/v1/session', { method: 'POST', body: {} });
  const created = await call('/api/v1/twins', { method: 'POST', body: { displayName: `B4 empty ${stamp}` } });
  assert.equal(created.status, 201, `twin create → ${created.status}`);
  twinA = created.json;

  const r = await call(`/api/v1/twins/${twinA.id}/deficiencies`);
  assert.equal(r.status, 200, `GET deficiencies → ${r.status}`);
  assert.equal(r.json.report.version, 'deficiency-report/v1');
  assert.equal(r.json.report.twinId, twinA.id);
  assert.equal(r.json.report.twinVersionId, null);
  assert.equal(r.json.report.capabilities.length, 6);
  for (const cap of r.json.report.capabilities) {
    assert.equal(cap.state, 'unknown', `${cap.capability} unknown on a capture-less twin`);
    assert.ok(cap.remedy, 'unknown rows carry a remedy');
  }
  assert.deepEqual(r.json.report.summary, { ok: 0, deficient: 0, unknown: 6, total: 6 });
  assert.ok(r.json.report.disclosures.some((d) => d.includes('no capture sessions exist')));
  assert.equal(r.json.baselineReport, undefined);
  assert.equal(r.json.delta, undefined);
});

// ─── 10. auth + tenant isolation + 404s ──────────────────────────────────────

test('deficiency api: auth, tenant isolation and 404s', async () => {
  await ensureBase();

  // anonymous → 401
  const anon = await fetch(`${base}/api/v1/twins/${twinA.id}/deficiencies`);
  assert.equal(anon.status, 401, `anonymous → ${anon.status}`);

  // unknown twin id → 404 for the owner
  const missing = await call('/api/v1/twins/twin_does_not_exist/deficiencies');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'not_found');

  // seed a SECOND tenant with an API key (Prisma — the honest multi-tenant path)
  const db = await prisma();
  const slug = `b4-foreign-${stamp}`;
  const tenant = await db.tenant.create({ data: { slug, name: `B4 Foreign ${stamp}` } });
  const user = await db.user.create({ data: { tenantId: tenant.id, email: `b4-foreign-${stamp}@example.test`, name: 'B4 Foreign', role: 'owner' } });
  foreignKey = `you_sk_b4_${sha256hex(`${stamp}-foreign`).slice(0, 24)}`;
  await db.apiKey.create({
    data: { tenantId: tenant.id, name: 'b4-isolation', prefix: foreignKey.slice(0, 10), hash: sha256hex(foreignKey), scopes: JSON.stringify(['read', 'write']) },
  });
  // foreign tenant via Bearer → 404 (indistinguishable from nonexistent).
  // NOTE: the demo bootstrap reuses the SAME demo tenant for cookie sessions;
  // tenant B is the Prisma-seeded one above, exercised via the API key only.
  const foreign = await call(`/api/v1/twins/${twinA.id}/deficiencies`, {
    headers: { authorization: `Bearer ${foreignKey}` },
  });
  assert.equal(foreign.status, 404, `foreign tenant → ${foreign.status}`);
  assert.equal(foreign.json.error.code, 'not_found');
  // the foreign key itself is valid (read scope) — prove it on its own tenant
  const foreignTwins = await call('/api/v1/twins', { headers: { authorization: `Bearer ${foreignKey}` } });
  assert.equal(foreignTwins.status, 200, `foreign key on its own tenant → ${foreignTwins.status}`);
  assert.equal(foreignTwins.json.length, 0, 'tenant B has no twins yet');
  const foreignTwinCreate = await call('/api/v1/twins', {
    method: 'POST', body: { displayName: `B4 tenantB ${stamp}` }, headers: { authorization: `Bearer ${foreignKey}` },
  });
  assert.equal(foreignTwinCreate.status, 201);
  twinB = foreignTwinCreate.json;

  // owner still gets 200 on twinA
  const owner = await call(`/api/v1/twins/${twinA.id}/deficiencies`);
  assert.equal(owner.status, 200);

  // nonexistent versionId → 404
  const badVersion = await call(`/api/v1/twins/${twinA.id}/deficiencies?versionId=v_does_not_exist`);
  assert.equal(badVersion.status, 404);
  assert.equal(badVersion.json.error.code, 'not_found');

  // a version that exists but belongs to a DIFFERENT twin (tenant B's twin has
  // no versions — use a foreign twin id instead: tenant B asking for its own
  // twin is fine, but the versionId must belong to THE twin in the path)
  const ownNoVersion = await call(`/api/v1/twins/${twinB.id}/deficiencies?versionId=v_does_not_exist`);
  assert.equal(ownNoVersion.status, 404);
});

// ─── 11. aggregation over seeded persisted state + version selection + delta ─

test('deficiency api: aggregation over seeded persisted state, versionId selection and delta', async () => {
  await ensureBase();
  seeded = await seedDeficiencyState();

  // default = latest version (v2)
  const latest = await call(`/api/v1/twins/${twinA.id}/deficiencies`);
  assert.equal(latest.status, 200);
  assert.equal(latest.json.report.twinVersionNumber, 2, 'default report targets the latest version');
  assert.equal(latest.json.report.twinVersionId, seeded.v2.id);

  const statesLatest = Object.fromEntries(latest.json.report.capabilities.map((c) => [c.capability, c.state]));
  // v2 lists only speech; captures resolved face-turn (S2) and hands (S2)
  assert.equal(statesLatest.face, 'ok');
  assert.equal(statesLatest.hands, 'ok');
  assert.equal(statesLatest.hair, 'ok');
  assert.equal(statesLatest.silhouette, 'ok');
  assert.equal(statesLatest.motion, 'ok');
  assert.equal(statesLatest.speech, 'deficient', 'speech never captured and v2 lists it');

  // sources cite the REAL persisted ids
  const faceRow = latest.json.report.capabilities.find((c) => c.capability === 'face');
  assert.ok(faceRow.sources.some((s) => s.captureSessionId === seeded.s2.id && s.stepId === 'face-turn' && s.signal === 'positive'), 'S2 face-turn done is cited');
  assert.ok(faceRow.sources.some((s) => s.captureSessionId === seeded.s1.id && s.stepId === 'face-turn' && s.signal === 'negative'), 'the old skip stays disclosed');
  assert.ok(faceRow.sources.some((s) => s.twinVersionId === seeded.v2.id), 'reconstruction coverage cites the version');
  // asset analysis citations
  assert.ok(faceRow.sources.some((s) => s.assetId === `seed-a-ff-${stamp}` && s.signal === 'positive'));

  // ?versionId=v1 → the older report (face + hands deficient there)
  const v1Report = await call(`/api/v1/twins/${twinA.id}/deficiencies?versionId=${seeded.v1.id}`);
  assert.equal(v1Report.status, 200);
  assert.equal(v1Report.json.report.twinVersionNumber, 1);
  const statesV1 = Object.fromEntries(v1Report.json.report.capabilities.map((c) => [c.capability, c.state]));
  assert.equal(statesV1.face, 'deficient', 'v1 lists face.profile AND the capture pool cannot supersede a version-level deficiency');
  assert.equal(statesV1.hands, 'deficient', 'v1 lists hands (its reconstruction lacked it) — the deficiency stands with positives disclosed');
  const handsV1 = v1Report.json.report.capabilities.find((c) => c.capability === 'hands');
  assert.match(handsV1.reason, /positive signal\(s\) also exist, the deficiency stands/);
  assert.equal(handsV1.severity, 'high');

  // ?versionId=v2&baselineVersionId=v1 → the delta
  const deltaRes = await call(`/api/v1/twins/${twinA.id}/deficiencies?versionId=${seeded.v2.id}&baselineVersionId=${seeded.v1.id}`);
  assert.equal(deltaRes.status, 200);
  assert.ok(deltaRes.json.delta, 'delta present when baselineVersionId is requested');
  assert.ok(deltaRes.json.baselineReport, 'baseline report present');
  const delta = deltaRes.json.delta;
  assert.equal(delta.baseline.twinVersionNumber, 1);
  assert.equal(delta.comparison.twinVersionNumber, 2);
  const dRow = (cap) => delta.rows.find((r) => r.capability === cap);
  assert.equal(dRow('face').delta, 'improved');
  assert.equal(dRow('hands').delta, 'improved');
  assert.equal(dRow('speech').delta, 'unchanged', 'deficient low → deficient low');
  assert.equal(dRow('hair').delta, 'unchanged');
  assert.deepEqual(delta.summary, { improved: 2, regressed: 0, unchanged: 4, unknown: 0 });

  // unknown baselineVersionId → 404
  const bad = await call(`/api/v1/twins/${twinA.id}/deficiencies?versionId=${seeded.v2.id}&baselineVersionId=v_nope`);
  assert.equal(bad.status, 404);
});

// ─── 12. remedy round-trip ───────────────────────────────────────────────────

test('deficiency api: remedy round-trip — POSTing the suggested payload creates the evidence request', async () => {
  await ensureBase();
  const r = await call(`/api/v1/twins/${twinA.id}/deficiencies?versionId=${seeded.v1.id}`);
  assert.equal(r.status, 200);
  const hands = r.json.report.capabilities.find((c) => c.capability === 'hands');
  assert.equal(hands.state, 'deficient');
  const remedy = hands.remedy;
  assert.ok(remedy, 'deficient row carries a ready-to-POST remedy');
  assert.equal(remedy.twinVersionId, seeded.v1.id);

  // POST the remedy VERBATIM to the existing evidence-requests route
  const created = await call('/api/v1/evidence-requests', { method: 'POST', body: remedy });
  assert.equal(created.status, 201, `POST remedy → ${created.status}: ${created.text}`);
  assert.equal(created.json.capability, remedy.capability);
  assert.equal(created.json.twinVersionId, seeded.v1.id);
  assert.equal(created.json.reason, remedy.reason);
  assert.equal(created.json.instructions, remedy.instructions);
  assert.equal(created.json.expectedSignal, remedy.expectedSignal);
  assert.equal(created.json.status, 'open');
  assert.equal(created.json.scope, remedy.scope);
});
