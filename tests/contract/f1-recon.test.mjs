// ═══════════════════════════════════════════════════════════════════════════
// F1 reconstruction tests (P6.C4 — Worker C lane) — node:test.
//
// PURE UNIT TESTS — no server boot, no network, no real keys, no database.
// Covers the F1 pipeline's pure half (lab/f1-recon.ts) composed with the REAL
// AI registry (ai/registry.ts — the same resolution the recon seam performs):
//
//   1. consent-gated entry — no active reconstruct grant → typed refusal
//      BEFORE any evidence byte is loaded (mock deps assert zero calls);
//      revoked / expired / wrong-scope / invalid-date grants all refuse;
//   2. liveness/quality checkpoints — the full typed refusal taxonomy
//      (missing/empty/size-mismatch/undecodable/mime-mismatch/wrong-aspect)
//      against real PNG bytes, hand-crafted PNG/JPEG/GIF headers, and
//      video/audio container magic; boundary aspect ratios;
//   3. pipeline-level refusals — session_incomplete, no_analyzable_evidence
//      (all refused OR all analysis-failed), with every per-asset refusal
//      carried in the typed error's details;
//   4. failure disclosure (no synthetic-claim laundering) — mixed outcomes:
//      refused/failed/skipped assets are recorded verbatim in failures +
//      the evidence manifest + the disclosure, while per-region confidence
//      comes ONLY from honestly-analyzed evidence;
//   5. aggregation + TwinVersion linkage — protocol coverage vs the 8-step
//      law (covered/partial/missing), declared-vs-observed tiers, per-region
//      confidence math, honest overall confidence, usage accounting, and the
//      F1 provenance block (manifest hashes in order, consent grant id,
//      model + provider, per-region confidences, disclosure);
//   6. registry resolution through the recon seam — the exact resolution the
//      seam performs per call (precedence: YOU_AI_PROVIDERS pin > registry
//      default; legacy YOU_RECON_MODEL passthrough; fail-closed on missing
//      key / unknown provider);
//   7. determinism — same inputs (fixed clock, fixed mock analyses) →
//      byte-identical report JSON.
//
// Imported STATICALLY by tests/index.mjs — runs in the aggregated
// `node --test tests/` gate. Env mutations are scoped INSIDE each test
// (snapshot → set → run → restore): file-level hooks would be process-wide
// in the aggregated runner and this suite must clear OPENROUTER_API_KEY,
// which sibling suites set — so no beforeEach/afterEach at all.
// ═══════════════════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  F1_MAX_ASPECT_RATIO,
  F1_MIN_ASPECT_RATIO,
  F1_PROTOCOL_STEPS,
  F1_RECON_ADAPTER,
  F1_REGIONS,
  F1_REPORT_SCHEMA,
  F1_RECONSTRUCT_JOB_KIND,
  F1TypedRefusal,
  buildF1ProvenanceBlock,
  f1AssetContextNote,
  f1ConsentGate,
  f1LivenessCheckpoint,
  runF1Reconstruction,
  sniffEvidenceContainer,
} from '../../apps/web/src/lib/you/lab/f1-recon.ts';
import {
  RegistryResolutionError,
  resolveModel,
} from '../../apps/web/src/lib/you/ai/registry.ts';

// ─── fixtures ────────────────────────────────────────────────────────────────

// a real 8×8 PNG (the P6.C1 test fixture — valid signature, IHDR, dims 8×8)
const REAL_PNG = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dwn4GBgYGJgQoAAF9vAgOZcDyHAAAAAElFTkSuQmCC',
  'base64',
));

/** hand-crafted PNG header (signature + IHDR chunk with the given dims) */
function pngHeaderBytes(width, height) {
  const b = Buffer.alloc(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0x00, 0x00, 0x00, 0x0d], 8); // IHDR length = 13
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return new Uint8Array(b);
}

/** hand-crafted JPEG stream: SOI + APP0(len 4) + SOF0 with the given dims */
function jpegHeaderBytes(width, height) {
  const b = Buffer.alloc(32);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00], 0);
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08], 8); // SOF0 marker + len + precision
  b.writeUInt16BE(height, 13);
  b.writeUInt16BE(width, 15);
  return new Uint8Array(b);
}

function gifHeaderBytes(width, height) {
  const b = Buffer.alloc(24);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return new Uint8Array(b);
}

function magicBytes(lead, total = 24) {
  const b = Buffer.alloc(total);
  b.write(lead, 0, 'ascii');
  return new Uint8Array(b);
}

const MP4_BYTES = new Uint8Array(Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70].concat(new Array(24).fill(0))));
const WEBM_BYTES = new Uint8Array(Buffer.from([0x1a, 0x45, 0xdf, 0xa3].concat(new Array(28).fill(0))));
const GARBAGE_BYTES = new Uint8Array(Buffer.from([0xde, 0xad, 0xbe, 0xef].concat(new Array(28).fill(0x55))));

const GRANT = {
  id: 'grant-1',
  scopes: ['capture', 'reconstruct'],
  revokedAt: null,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
};

function makeAsset(id, over = {}) {
  return {
    assetId: id,
    storageKey: `ev/${id}`,
    kind: 'image',
    mime: 'image/png',
    contentHash: `sha256-${id}`,
    declaredBytes: REAL_PNG.length,
    regions: [],
    ...over,
  };
}

function makeVideoAsset(id, bytes, over = {}) {
  return makeAsset(id, {
    kind: 'video',
    mime: 'video/mp4',
    declaredBytes: bytes.length,
    storageKey: `ev/${id}`,
    contentHash: `sha256-${id}`,
    regions: [],
    ...over,
  });
}

function mockAnalysis(assetId, over = {}) {
  return {
    assetId,
    usable: true,
    blur: 'none',
    lighting: 'good',
    issues: [],
    observedRegions: [],
    score: 0.8,
    latencyMs: 40,
    descriptors: {
      build: 'average', ageEstimate: null, presentation: null, hair: 'short',
      hairColorTone: 'dark brown', hairColorHex: '#3b2a20', skinToneTone: 'medium',
      skinToneHex: '#c8956c', eyeTone: 'brown', eyeToneHex: '#4a342a',
      clothingItems: ['t-shirt'], clothingStyle: 'casual', clothingColorHexes: ['#565a64'],
      distinguishing: [], facialHair: null, glasses: false,
    },
    geometryHints: { shoulderRatio: 2.1, headRatio: 7.5, faceShape: 'oval' },
    confidence: { overall: 0.7, morphology: 0.7, appearance: 0.7, geometry: 0.6 },
    ...over,
  };
}

function makeInput(over = {}) {
  return {
    captureSessionId: 'sess-1',
    twinId: 'twin-1',
    subjectId: 'subj-1',
    sessionStatus: 'complete',
    grants: [GRANT],
    assets: [],
    ...over,
  };
}

/** deps mock with call recording; bytes = { storageKey: Uint8Array|null } */
function makeDeps(over = {}) {
  const calls = { loadBytes: [], analyze: [], resolveVision: 0 };
  const deps = {
    loadBytes: async (storageKey) => {
      calls.loadBytes.push(storageKey);
      const bytes = over.bytes?.[storageKey];
      return bytes === undefined ? null : bytes;
    },
    analyzeAsset: async (asset, context) => {
      calls.analyze.push({ assetId: asset.assetId, context });
      if (over.failAssetIds?.includes(asset.assetId)) {
        throw new Error(over.failMessage ?? `mock provider error 502 (asset ${asset.assetId})`);
      }
      const analysis = over.analyses?.[asset.assetId] ?? mockAnalysis(asset.assetId);
      const usage = over.usages?.[asset.assetId] ?? { llmCalls: 1, totalLatencyMs: 40 };
      return { analysis, usage };
    },
    resolveVision: () => {
      calls.resolveVision += 1;
      return over.vision ?? { provider: 'zai', modelId: 'glm-5v-turbo', source: 'registry-default' };
    },
  };
  return { deps, calls };
}

const FIXED_NOW = new Date('2026-10-04T12:00:00.000Z');

// ─── env isolation (scoped INSIDE each resolution test) ──────────────────────
// NOTE: in the aggregated runner (tests/index.mjs) every imported file's
// top-level beforeEach/afterEach hooks apply to the WHOLE process — sibling
// suites would see this suite's env mutations mid-flight. The established
// convention (ai-render.test.mjs) is disjoint per-suite key sets; this suite
// touches OPENROUTER_API_KEY, which the ai-registry suite's own hooks SET —
// so isolation here is scoped INSIDE each test: snapshot → set → run →
// restore, never process-wide.

const F1_ENV_KEYS = ['YOU_AI_PROVIDERS', 'YOU_AI_VISION_MODEL', 'YOU_RECON_MODEL', 'OPENROUTER_API_KEY'];

function snapshotEnv() {
  const snap = {};
  for (const key of F1_ENV_KEYS) snap[key] = process.env[key];
  return snap;
}

function setEnv(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Deterministic env for one test body: snapshot → set → run → restore. */
async function withEnv(vars, fn) {
  const snap = snapshotEnv();
  setEnv(vars);
  try {
    return await fn();
  } finally {
    setEnv(snap);
  }
}

const CLEAN = {
  YOU_AI_PROVIDERS: undefined,
  YOU_AI_VISION_MODEL: undefined,
  YOU_RECON_MODEL: undefined,
  OPENROUTER_API_KEY: undefined,
};
const PLACEHOLDER_KEY = 'test-placeholder-key-never-real';

// ─── protocol model sanity ───────────────────────────────────────────────────

test('protocol: the 8-step F1 law maps onto canonical regions with disclosed coarse graining', () => {
  assert.equal(F1_PROTOCOL_STEPS.length, 8);
  const steps = F1_PROTOCOL_STEPS.map((s) => s.step);
  assert.deepEqual(steps, [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const s of F1_PROTOCOL_STEPS) {
    assert.ok(s.regions.length > 0, `step ${s.step} maps to at least one region`);
    for (const r of s.regions) assert.ok(F1_REGIONS.includes(r), `step ${s.step} region ${r} is canonical`);
  }
  // steps 3/4 share silhouette.front — and say so honestly
  const upper = F1_PROTOCOL_STEPS.find((s) => s.step === 3);
  const full = F1_PROTOCOL_STEPS.find((s) => s.step === 4);
  assert.deepEqual([...upper.regions], [...full.regions]);
  assert.ok(upper.coarseGrainingNote && full.coarseGrainingNote);
  assert.equal(F1_RECONSTRUCT_JOB_KIND, 'f1.reconstruct');
  assert.equal(F1_RECON_ADAPTER.adapterId, 'f1-recon-1');
  assert.equal(F1_RECON_ADAPTER.inferenceOnly, true);
  assert.equal(F1_REPORT_SCHEMA, 'f1-reconstruction-report/v1');
});

test('context note: declared regions map to protocol steps; undeclared assets say so', () => {
  const note = f1AssetContextNote(makeAsset('a1', { regions: ['face.front', 'face.hairline'] }));
  assert.match(note, /\[face\.front, face\.hairline\]/);
  assert.match(note, /1 \(face\/front\)/);
  const bare = f1AssetContextNote(makeAsset('a2'));
  assert.match(bare, /none declared/);
  assert.doesNotMatch(bare, /protocol step/);
});

// ─── 1. consent-gated entry ──────────────────────────────────────────────────

test('consent: a valid active reconstruct grant passes the gate', () => {
  const decision = f1ConsentGate([GRANT], 'subj-1', FIXED_NOW);
  assert.equal(decision.grantId, 'grant-1');
});

test('consent: no grants → typed refusal', () => {
  assert.throws(() => f1ConsentGate([], 'subj-1', FIXED_NOW), (err) => {
    assert.ok(err instanceof F1TypedRefusal);
    assert.equal(err.code, 'consent_required');
    assert.match(err.message, /reconstruct/);
    return true;
  });
});

test('consent: revoked / expired / wrong-scope / invalid-date grants all refuse (fail-closed)', () => {
  const revoked = { ...GRANT, revokedAt: new Date().toISOString() };
  assert.throws(() => f1ConsentGate([revoked], 'subj-1', FIXED_NOW), (e) => e.code === 'consent_required');
  const expired = { ...GRANT, expiresAt: new Date(FIXED_NOW.getTime() - 1000).toISOString() };
  assert.throws(() => f1ConsentGate([expired], 'subj-1', FIXED_NOW), (e) => e.code === 'consent_required');
  const wrongScope = { ...GRANT, scopes: ['capture', 'render'] };
  assert.throws(() => f1ConsentGate([wrongScope], 'subj-1', FIXED_NOW), (e) => e.code === 'consent_required');
  const invalidDate = { ...GRANT, expiresAt: 'not-a-date' };
  assert.throws(() => f1ConsentGate([invalidDate], 'subj-1', FIXED_NOW), (e) => e.code === 'consent_required');
});

test('consent (pipeline): no grant → typed refusal BEFORE any evidence byte is loaded', async () => {
  const a1 = makeAsset('a1');
  const { deps, calls } = makeDeps({ bytes: { 'ev/a1': REAL_PNG } });
  const input = makeInput({ grants: [], assets: [a1] });
  await assert.rejects(
    () => runF1Reconstruction(input, deps, { now: () => FIXED_NOW }),
    (err) => {
      assert.ok(err instanceof F1TypedRefusal);
      assert.equal(err.code, 'consent_required');
      return true;
    },
  );
  assert.equal(calls.loadBytes.length, 0, 'fail-closed entry: zero storage reads without consent');
  assert.equal(calls.analyze.length, 0, 'fail-closed entry: zero vision calls without consent');
});

// ─── 2. liveness/quality checkpoints ─────────────────────────────────────────

test('checkpoint: missing object → evidence_missing', () => {
  const v = f1LivenessCheckpoint(makeAsset('a1'), null);
  assert.equal(v.passed, false);
  assert.equal(v.refusal.code, 'evidence_missing');
});

test('checkpoint: zero bytes → evidence_empty', () => {
  const v = f1LivenessCheckpoint(makeAsset('a1', { declaredBytes: 0 }), new Uint8Array(0));
  assert.equal(v.passed, false);
  assert.equal(v.refusal.code, 'evidence_empty');
});

test('checkpoint: manifest bytes ≠ actual bytes → evidence_size_mismatch', () => {
  const v = f1LivenessCheckpoint(makeAsset('a1', { declaredBytes: 100 }), REAL_PNG);
  assert.equal(v.passed, false);
  assert.equal(v.refusal.code, 'evidence_size_mismatch');
  assert.match(v.refusal.message, /declares 100 bytes/);
});

test('checkpoint: unknown magic → evidence_undecodable', () => {
  const v = f1LivenessCheckpoint(makeAsset('a1', { declaredBytes: GARBAGE_BYTES.length }), GARBAGE_BYTES);
  assert.equal(v.passed, false);
  assert.equal(v.refusal.code, 'evidence_undecodable');
});

test('checkpoint: declared kind contradicts the sniffed container → evidence_mime_mismatch', () => {
  const v = f1LivenessCheckpoint(
    makeAsset('a1', { kind: 'video', mime: 'video/mp4', declaredBytes: REAL_PNG.length }),
    REAL_PNG,
  );
  assert.equal(v.passed, false);
  assert.equal(v.refusal.code, 'evidence_mime_mismatch');
  assert.match(v.refusal.message, /sniff as a image container/);
});

test('checkpoint: declared mime contradicts the sniffed container (same family) → evidence_mime_mismatch', () => {
  const v = f1LivenessCheckpoint(
    makeAsset('a1', { mime: 'image/jpeg', declaredBytes: REAL_PNG.length }),
    REAL_PNG,
  );
  assert.equal(v.passed, false);
  assert.equal(v.refusal.code, 'evidence_mime_mismatch');
  assert.match(v.refusal.message, /declares mime "image\/jpeg".*sniff as image\/png/);
});

test('checkpoint: empty declared mime → evidence_mime_mismatch', () => {
  const v = f1LivenessCheckpoint(makeAsset('a1', { mime: '' }), REAL_PNG);
  assert.equal(v.passed, false);
  assert.equal(v.refusal.code, 'evidence_mime_mismatch');
});

test('checkpoint: a real 8×8 PNG passes with decoded dimensions', () => {
  const v = f1LivenessCheckpoint(makeAsset('a1'), REAL_PNG);
  assert.equal(v.passed, true);
  assert.equal(v.refusal, undefined);
  assert.equal(v.sniffed.container, 'png');
  assert.equal(v.sniffed.canonicalMime, 'image/png');
  assert.equal(v.sniffed.width, 8);
  assert.equal(v.sniffed.height, 8);
});

test('checkpoint: extreme aspect ratio (80:1) → evidence_wrong_aspect', () => {
  const bytes = pngHeaderBytes(800, 10);
  const v = f1LivenessCheckpoint(makeAsset('a1', { declaredBytes: bytes.length }), bytes);
  assert.equal(v.passed, false);
  assert.equal(v.refusal.code, 'evidence_wrong_aspect');
  assert.match(v.refusal.message, /800×10/);
});

test('checkpoint: the 4:1 boundary itself passes (inclusive bounds)', () => {
  assert.equal(F1_MIN_ASPECT_RATIO, 0.25);
  assert.equal(F1_MAX_ASPECT_RATIO, 4);
  const wide = pngHeaderBytes(800, 200); // exactly 4:1
  assert.equal(f1LivenessCheckpoint(makeAsset('a1', { declaredBytes: wide.length }), wide).passed, true);
  const tall = pngHeaderBytes(200, 800); // exactly 1:4
  assert.equal(f1LivenessCheckpoint(makeAsset('a2', { declaredBytes: tall.length }), tall).passed, true);
});

test('checkpoint: zero or absurd decoded dimensions → evidence_undecodable', () => {
  const zero = pngHeaderBytes(0, 100);
  assert.equal(f1LivenessCheckpoint(makeAsset('a1', { declaredBytes: zero.length }), zero).refusal.code, 'evidence_undecodable');
  const huge = pngHeaderBytes(200_000, 1);
  assert.equal(f1LivenessCheckpoint(makeAsset('a2', { declaredBytes: huge.length }), huge).refusal.code, 'evidence_undecodable');
});

test('checkpoint: JPEG SOF scan decodes dimensions; extreme JPEG aspect refused', () => {
  const normal = jpegHeaderBytes(320, 240);
  const v = f1LivenessCheckpoint(makeAsset('a1', { mime: 'image/jpeg', declaredBytes: normal.length }), normal);
  assert.equal(v.passed, true);
  assert.equal(v.sniffed.container, 'jpeg');
  assert.equal(v.sniffed.width, 320);
  assert.equal(v.sniffed.height, 240);

  const wide = jpegHeaderBytes(4000, 100); // 40:1
  const refused = f1LivenessCheckpoint(makeAsset('a2', { mime: 'image/jpeg', declaredBytes: wide.length }), wide);
  assert.equal(refused.passed, false);
  assert.equal(refused.refusal.code, 'evidence_wrong_aspect');
});

test('checkpoint: GIF dimensions decode (little-endian)', () => {
  const gif = gifHeaderBytes(32, 32);
  const v = f1LivenessCheckpoint(makeAsset('a1', { mime: 'image/gif', declaredBytes: gif.length }), gif);
  assert.equal(v.passed, true);
  assert.equal(v.sniffed.container, 'gif');
  assert.equal(v.sniffed.width, 32);
  assert.equal(v.sniffed.height, 32);
});

test('sniff: container magic table (webp / wav / mp4 / webm / ogg / mp3-ID3) and the alias map', () => {
  assert.equal(sniffEvidenceContainer(magicBytes('RIFF0000WEBPVP8 '))?.container, 'webp');
  assert.equal(sniffEvidenceContainer(magicBytes('RIFF0000WAVEfmt '))?.container, 'wav');
  assert.equal(sniffEvidenceContainer(MP4_BYTES)?.container, 'mp4');
  assert.equal(sniffEvidenceContainer(WEBM_BYTES)?.container, 'webm');
  assert.equal(sniffEvidenceContainer(magicBytes('OggSxxxxdataxx'))?.container, 'ogg');
  assert.equal(sniffEvidenceContainer(magicBytes('ID3\x03\x00\x00\x00\x00\x00\x00'))?.container, 'mp3');
  assert.equal(sniffEvidenceContainer(REAL_PNG)?.mimeFamily, 'image');
  assert.equal(sniffEvidenceContainer(MP4_BYTES)?.mimeFamily, 'video');
  assert.equal(sniffEvidenceContainer(magicBytes('OggSxxxxdataxx'))?.mimeFamily, 'audio');
  assert.equal(sniffEvidenceContainer(GARBAGE_BYTES), null);
});

// ─── 3. pipeline-level refusals ──────────────────────────────────────────────

test('pipeline: incomplete session → typed session_incomplete refusal', async () => {
  const { deps } = makeDeps({ bytes: { 'ev/a1': REAL_PNG } });
  const input = makeInput({ sessionStatus: 'analyzing', assets: [makeAsset('a1')] });
  await assert.rejects(
    () => runF1Reconstruction(input, deps, { now: () => FIXED_NOW }),
    (err) => err instanceof F1TypedRefusal && err.code === 'session_incomplete',
  );
});

test('pipeline: zero analyzable evidence (all refused) → typed refusal carrying EVERY per-asset refusal', async () => {
  const corrupt = GARBAGE_BYTES;
  const a1 = makeAsset('a1', { declaredBytes: corrupt.length });
  const a2 = makeAsset('a2', { declaredBytes: REAL_PNG.length });
  const { deps, calls } = makeDeps({ bytes: { 'ev/a1': corrupt, 'ev/a2': null } });
  const input = makeInput({ assets: [a1, a2] });
  await assert.rejects(
    () => runF1Reconstruction(input, deps, { now: () => FIXED_NOW }),
    (err) => {
      assert.equal(err.code, 'no_analyzable_evidence');
      assert.equal(err.details.perAsset.length, 2);
      assert.equal(err.details.perAsset[0].refusal.code, 'evidence_undecodable');
      assert.equal(err.details.perAsset[1].refusal.code, 'evidence_missing');
      return true;
    },
  );
  assert.equal(calls.analyze.length, 0, 'refused assets never reach the vision model');
});

test('pipeline: zero analyzable evidence (all analysis failed) → typed refusal with verbatim failures', async () => {
  const a1 = makeAsset('a1');
  const { deps, calls } = makeDeps({
    bytes: { 'ev/a1': REAL_PNG },
    failAssetIds: ['a1'],
    failMessage: 'zai provider error during vision: mock 500',
  });
  const input = makeInput({ assets: [a1] });
  await assert.rejects(
    () => runF1Reconstruction(input, deps, { now: () => FIXED_NOW }),
    (err) => {
      assert.equal(err.code, 'no_analyzable_evidence');
      assert.equal(err.details.perAsset[0].analysisStatus, 'failed');
      assert.equal(err.details.perAsset[0].analysisMessage, 'zai provider error during vision: mock 500');
      return true;
    },
  );
  assert.equal(calls.analyze.length, 1, 'the analysis was attempted and its failure recorded — never retried silently here');
});

// ─── 4. failure disclosure (no synthetic-claim laundering) ────────────────────

test('disclosure: mixed outcomes are ALL recorded verbatim; only honest analyses count', async () => {
  const corrupt = GARBAGE_BYTES;
  const video = MP4_BYTES;
  const a1 = makeAsset('a1'); // good image
  const a2 = makeAsset('a2', { declaredBytes: corrupt.length }); // corrupt image
  const a3 = makeAsset('a3'); // provider-failing image
  const a4 = makeVideoAsset('a4', video, { regions: ['walking'] }); // non-image skip
  const { deps, calls } = makeDeps({
    bytes: { 'ev/a1': REAL_PNG, 'ev/a2': corrupt, 'ev/a3': REAL_PNG, 'ev/a4': video },
    failAssetIds: ['a3'],
    failMessage: 'openrouter 502 bad gateway (mock)',
    analyses: {
      a1: mockAnalysis('a1', { observedRegions: ['face.front'], confidence: { overall: 0.7, morphology: 0.7, appearance: 0.7, geometry: 0.6 } }),
    },
  });
  const input = makeInput({ assets: [a1, a2, a3, a4] });
  const { report, analyzedAssets } = await runF1Reconstruction(input, deps, { now: () => FIXED_NOW });

  assert.equal(analyzedAssets.length, 1);
  assert.equal(analyzedAssets[0].assetId, 'a1');
  assert.equal(report.overall.assetsTotal, 4);
  assert.equal(report.overall.assetsAnalyzed, 1);
  assert.equal(report.overall.assetsRefused, 1);
  assert.equal(report.overall.assetsFailed, 1);
  assert.equal(report.overall.assetsSkippedNonImage, 1);

  // every failure disclosed with its typed code + verbatim message
  const failureCodes = report.failures.map((f) => f.code);
  assert.deepEqual(failureCodes.sort(), ['analysis_failed', 'analysis_skipped_non_image', 'evidence_undecodable']);
  const failedEntry = report.failures.find((f) => f.assetId === 'a3');
  assert.equal(failedEntry.message, 'openrouter 502 bad gateway (mock)');
  const skippedEntry = report.failures.find((f) => f.assetId === 'a4');
  assert.match(skippedEntry.message, /no vision adapter is wired for video evidence in wave-1/);

  // the manifest mirrors the same honesty
  const byId = new Map(report.evidenceManifest.map((e) => [e.assetId, e]));
  assert.equal(byId.get('a1').analysis.status, 'analyzed');
  assert.equal(byId.get('a2').analysis.status, 'refused');
  assert.equal(byId.get('a2').analysis.code, 'evidence_undecodable');
  assert.equal(byId.get('a3').analysis.status, 'failed');
  assert.equal(byId.get('a4').analysis.status, 'skipped');

  // declared-only coverage from the skipped video (declared walking) is the
  // weaker tier; refused a2's declared regions contribute NOTHING
  assert.equal(report.regionCoverage['walking'], 'declared-only');
  assert.equal(report.perRegionConfidence['walking'], null);

  // the disclosure names names
  assert.match(report.overall.disclosure, /a2 \(evidence_undecodable\)/);
  assert.match(report.overall.disclosure, /FAILED analysis.*a3/);
  assert.match(report.overall.disclosure, /no vision adapter in wave-1/);
  assert.match(report.overall.disclosure, /walking/);

  // per-region confidence comes ONLY from a1's honest analysis
  assert.equal(report.perRegionConfidence['face.front'], 0.7);
  assert.equal(report.perRegionConfidence['face.profile'], null);
  assert.equal(calls.analyze.length, 2, 'a1 analyzed, a3 attempted (failed); a2/a4 never sent');
});

test('disclosure: the analyze dep receives the F1 capture-context note', async () => {
  const a1 = makeAsset('a1', { regions: ['face.front'] });
  const { deps, calls } = makeDeps({ bytes: { 'ev/a1': REAL_PNG } });
  await runF1Reconstruction(makeInput({ assets: [a1] }), deps, { now: () => FIXED_NOW });
  assert.equal(calls.analyze.length, 1);
  assert.match(calls.analyze[0].context, /F1 capture context/);
  assert.match(calls.analyze[0].context, /face\.front/);
  assert.match(calls.analyze[0].context, /1 \(face\/front\)/);
});

// ─── 5. aggregation + TwinVersion linkage ────────────────────────────────────

function coverageFixture() {
  const assets = [
    makeAsset('a1', { regions: ['face.front', 'teeth'] }),
    makeAsset('a2'),
    makeAsset('a3'),
    makeAsset('a4'),
  ];
  const analyses = {
    a1: mockAnalysis('a1', { observedRegions: ['face.front', 'face.hairline'] }),
    a2: mockAnalysis('a2', { observedRegions: ['face.profile'] }),
    a3: mockAnalysis('a3', { observedRegions: ['silhouette.front', 'hands'] }),
    a4: mockAnalysis('a4', { observedRegions: ['hair.back'] }),
  };
  const usages = {
    a1: { llmCalls: 2, totalLatencyMs: 120 }, // a JSON-retry call, honestly counted
    a2: { llmCalls: 1, totalLatencyMs: 40 },
    a3: { llmCalls: 1, totalLatencyMs: 40 },
    a4: { llmCalls: 1, totalLatencyMs: 40 },
  };
  return { assets, analyses, usages };
}

test('aggregation: protocol coverage vs the 8-step law (covered/partial/missing + ratio)', async () => {
  const { assets, analyses, usages } = coverageFixture();
  const { deps } = makeDeps({
    bytes: Object.fromEntries(assets.map((a) => [`ev/${a.assetId}`, REAL_PNG])),
    analyses,
    usages,
  });
  const input = makeInput({ assets });
  const { report } = await runF1Reconstruction(input, deps, { now: () => FIXED_NOW });

  const byStep = new Map(report.protocolCoverage.map((s) => [s.step, s]));
  assert.equal(byStep.get(1).status, 'covered');
  assert.equal(byStep.get(2).status, 'covered');
  assert.equal(byStep.get(3).status, 'covered');
  assert.equal(byStep.get(4).status, 'covered');
  assert.equal(byStep.get(5).status, 'covered');
  assert.equal(byStep.get(6).status, 'partial'); // hair.back observed, silhouette.side not
  assert.deepEqual(byStep.get(6).missingRegions, ['silhouette.side']);
  assert.equal(byStep.get(7).status, 'missing');
  assert.equal(byStep.get(8).status, 'missing');

  assert.equal(report.overall.protocolStepsCovered, 5);
  assert.equal(report.overall.protocolStepsPartial, 1);
  assert.equal(report.overall.protocolStepsMissing, 2);
  assert.equal(report.overall.protocolCoverageRatio, 0.688); // (5 + 0.5)/8

  // declared teeth (a1 declares it; no VLM observation) is the weaker tier
  assert.equal(report.regionCoverage['teeth'], 'declared-only');
  assert.equal(report.perRegionConfidence['teeth'], null);
  assert.ok(report.qualityFindings.some((f) => f.includes('"teeth"') && f.includes('DECLARED evidence only')));

  // usage accounting (the JSON-retry call on a1 is counted)
  assert.equal(report.usage.llmCalls, 5);
  assert.equal(report.usage.totalLatencyMs, 240);

  // honest overall confidence: raw weighted self-confidence × coverage factor
  // (all four analyses share score 0.8 / overall 0.7 → raw = 0.7)
  assert.equal(report.overall.confidenceOverall, 0.602); // 0.7 × (0.55 + 0.45×0.688)

  // coarse-graining disclosed on the shared front-silhouette steps
  assert.ok(byStep.get(3).coarseGrainingNote.includes('not distinguishable'));
  assert.match(report.overall.disclosure, /silhouette\.front/);
});

test('aggregation: per-region confidence is a weighted mean over observing assets only', async () => {
  const { assets } = coverageFixture();
  const analyses = {
    a1: mockAnalysis('a1', {
      observedRegions: ['face.front'],
      score: 0.9,
      confidence: { overall: 0.8, morphology: 0.8, appearance: 0.8, geometry: 0.8 },
    }),
    a2: mockAnalysis('a2', {
      observedRegions: ['face.front'],
      score: 0.5,
      confidence: { overall: 0.4, morphology: 0.4, appearance: 0.4, geometry: 0.4 },
    }),
    a3: mockAnalysis('a3', { observedRegions: ['hands'] }),
    a4: mockAnalysis('a4', { observedRegions: ['hair.back'] }),
  };
  const { deps } = makeDeps({
    bytes: Object.fromEntries(assets.map((a) => [`ev/${a.assetId}`, REAL_PNG])),
    analyses,
  });
  const { report } = await runF1Reconstruction(makeInput({ assets }), deps, { now: () => FIXED_NOW });

  // weights: a1 = 0.9×0.8 = 0.72, a2 = max(0.05, 0.5×0.4) = 0.2
  // weighted mean = (0.72×0.8 + 0.2×0.4) / 0.92 = 0.6560/0.92 → 0.713 → 0.713
  assert.equal(report.perRegionConfidence['face.front'], 0.713);
  assert.equal(report.perRegionConfidence['hands'], 0.7);
  assert.equal(report.perRegionConfidence['face.profile'], null);
});

test('linkage: the F1 provenance block carries manifest hashes, grant id, model+provider, per-region confidences', async () => {
  const { assets, analyses, usages } = coverageFixture();
  const vision = { provider: 'zai', modelId: 'glm-5v-turbo', source: 'registry-default' };
  const { deps } = makeDeps({
    bytes: Object.fromEntries(assets.map((a) => [`ev/${a.assetId}`, REAL_PNG])),
    analyses,
    usages,
    vision,
  });
  const input = makeInput({ assets });
  const { report } = await runF1Reconstruction(input, deps, { now: () => FIXED_NOW });

  const block = buildF1ProvenanceBlock(input, report);
  assert.equal(block.reportSchema, F1_REPORT_SCHEMA);
  assert.equal(block.consentGrantId, 'grant-1');
  assert.deepEqual(block.evidenceManifestHashes, ['sha256-a1', 'sha256-a2', 'sha256-a3', 'sha256-a4']);
  assert.deepEqual(block.reconstructionOf, { captureSessionId: 'sess-1', twinId: 'twin-1', subjectId: 'subj-1' });
  assert.deepEqual(block.vision, {
    provider: 'zai', modelId: 'glm-5v-turbo', resolutionSource: 'registry-default', adapterId: 'vlm-recon-1',
  });
  assert.deepEqual(block.perRegionConfidence, report.perRegionConfidence);
  assert.deepEqual(
    block.protocolCoverage.map((s) => s.status),
    ['covered', 'covered', 'covered', 'covered', 'covered', 'partial', 'missing', 'missing'],
  );
  assert.equal(block.protocolCoverageRatio, report.overall.protocolCoverageRatio);
  assert.equal(block.confidenceOverall, report.overall.confidenceOverall);
  assert.equal(block.disclosure, report.overall.disclosure);
  assert.deepEqual(block.reportRepresentation, { kind: 'f1-recon-report', adapterId: 'f1-recon-1' });
  assert.deepEqual(block.refusedAssetIds, []);
  assert.deepEqual(block.failedAssetIds, []);
  assert.deepEqual(block.skippedNonImageAssetIds, []);

  // the report itself records the registry-resolved vision resolution
  assert.equal(report.vision.provider, 'zai');
  assert.equal(report.vision.modelId, 'glm-5v-turbo');
  assert.equal(report.vision.resolutionSource, 'registry-default');
  assert.equal(report.vision.inferenceOnly, true);
  assert.equal(report.schema, F1_REPORT_SCHEMA);
  assert.equal(report.consent.grantId, 'grant-1');
  assert.equal(report.consent.verifiedAt, FIXED_NOW.toISOString());
});

test('determinism: fixed clock + fixed mock analyses → byte-identical report JSON', async () => {
  const { assets, analyses, usages } = coverageFixture();
  const bytes = Object.fromEntries(assets.map((a) => [`ev/${a.assetId}`, REAL_PNG]));
  const run = () => {
    const { deps } = makeDeps({ bytes, analyses, usages });
    return runF1Reconstruction(makeInput({ assets }), deps, { now: () => FIXED_NOW });
  };
  const r1 = await run();
  const r2 = await run();
  assert.equal(JSON.stringify(r1.report), JSON.stringify(r2.report));
});

// ─── 6. registry resolution through the recon seam ───────────────────────────

test('resolution: the seam default — zai resolves the registry vision default', async () => {
  await withEnv(CLEAN, () => {
    const resolved = resolveModel('vision', { provider: 'zai' });
    assert.equal(resolved.provider, 'zai');
    assert.equal(resolved.modelId, 'glm-5v-turbo');
    assert.equal(resolved.source, 'registry-default');
  });
});

test('resolution: YOU_AI_PROVIDERS pin wins for openrouter (with the key present)', async () => {
  await withEnv(
    { ...CLEAN, YOU_AI_PROVIDERS: 'openrouter:google/gemini-2.5-flash', OPENROUTER_API_KEY: PLACEHOLDER_KEY },
    () => {
      const resolved = resolveModel('vision', { provider: 'openrouter' });
      assert.equal(resolved.modelId, 'google/gemini-2.5-flash');
      assert.equal(resolved.source, 'provider-override');
    },
  );
});

test('resolution: fail-closed — openrouter without OPENROUTER_API_KEY refuses to guess', async () => {
  await withEnv(CLEAN, () => {
    assert.throws(
      () => resolveModel('vision', { provider: 'openrouter' }),
      (err) => err instanceof RegistryResolutionError && /OPENROUTER_API_KEY/.test(err.message),
    );
  });
});

test('resolution: unknown provider fail-closed; legacy YOU_RECON_MODEL passthrough honored', async () => {
  await withEnv(CLEAN, () => {
    assert.throws(
      () => resolveModel('vision', { provider: 'banana' }),
      (err) => err instanceof RegistryResolutionError && /unknown AI provider/.test(err.message),
    );
  });
  await withEnv(
    { ...CLEAN, OPENROUTER_API_KEY: PLACEHOLDER_KEY, YOU_RECON_MODEL: 'vendor/private-vision-1' },
    () => {
      const legacy = resolveModel('vision', { provider: 'openrouter' });
      assert.equal(legacy.modelId, 'vendor/private-vision-1');
      assert.equal(legacy.source, 'legacy-env');
      assert.equal(legacy.entry, null); // unvalidated passthrough by the PR #4 contract
    },
  );
});

test('resolution: the pipeline records exactly what the seam resolves (registry-default → provenance)', async () => {
  await withEnv(CLEAN, async () => {
    // the REAL resolution the seam performs for the default provider…
    const real = resolveModel('vision', { provider: 'zai' });
    // …is what the executor wires into deps.resolveVision, and what the report
    // must carry (provider + model verbatim — never fabricated)
    const a1 = makeAsset('a1');
    const { deps } = makeDeps({
      bytes: { 'ev/a1': REAL_PNG },
      vision: { provider: 'zai', modelId: real.modelId, source: real.source },
      analyses: { a1: mockAnalysis('a1', { observedRegions: ['face.front'] }) },
    });
    const { report } = await runF1Reconstruction(makeInput({ assets: [a1] }), deps, { now: () => FIXED_NOW });
    assert.equal(report.vision.modelId, real.modelId);
    assert.equal(report.vision.provider, 'zai');
    assert.equal(report.vision.resolutionSource, real.source);
    const block = buildF1ProvenanceBlock(makeInput({ assets: [a1] }), report);
    assert.equal(block.vision.modelId, real.modelId);
  });
});

// ─── 7. non-image honesty ────────────────────────────────────────────────────

test('non-image: video passes byte-level checkpoints but is analysis-skipped (declared-only coverage)', async () => {
  const video = MP4_BYTES;
  const a1 = makeVideoAsset('a1', video, { regions: ['walking'] });
  const a2 = makeAsset('a2');
  const { deps, calls } = makeDeps({
    bytes: { 'ev/a1': video, 'ev/a2': REAL_PNG },
    analyses: { a2: mockAnalysis('a2', { observedRegions: ['face.front'] }) },
  });
  const { report } = await runF1Reconstruction(makeInput({ assets: [a1, a2] }), deps, { now: () => FIXED_NOW });

  // the video was checkpointed but never analyzed
  assert.equal(calls.analyze.length, 1);
  assert.equal(calls.analyze[0].assetId, 'a2');
  const manifest = report.evidenceManifest.find((e) => e.assetId === 'a1');
  assert.equal(manifest.checkpoint.passed, true);
  assert.equal(manifest.checkpoint.sniffed.container, 'mp4');
  assert.equal(manifest.analysis.status, 'skipped');
  assert.equal(manifest.analysis.code, 'analysis_skipped_non_image');

  // walking: declared-only, step 7 missing at the OBSERVED tier
  assert.equal(report.regionCoverage['walking'], 'declared-only');
  assert.equal(report.protocolCoverage.find((s) => s.step === 7).status, 'missing');
  assert.equal(report.perRegionConfidence['walking'], null);
  assert.equal(report.overall.assetsSkippedNonImage, 1);
});

test('non-image: a refused video contributes NO coverage at all (unverifiable claims)', async () => {
  const video = GARBAGE_BYTES; // wrong magic for the declared mp4
  const a1 = makeVideoAsset('a1', video, { regions: ['walking'] });
  const a2 = makeAsset('a2');
  const { deps } = makeDeps({
    bytes: { 'ev/a1': video, 'ev/a2': REAL_PNG },
    analyses: { a2: mockAnalysis('a2', { observedRegions: ['face.front'] }) },
  });
  const { report } = await runF1Reconstruction(makeInput({ assets: [a1, a2] }), deps, { now: () => FIXED_NOW });
  assert.equal(report.regionCoverage['walking'], 'none');
  assert.equal(report.overall.assetsRefused, 1);
});
