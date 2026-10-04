// ═══════════════════════════════════════════════════════════════════════════
// Virtual try-on contract tests (P6.C8 — Worker C lane) — node:test.
//
// PURE UNIT TESTS — no server boot, no network, no real keys, no database.
// Covers the try-on adapter's pure contract core (lib/you/adapters/try-on.ts)
// composed exactly the way the executor folds it (runTryOnPipeline with
// injected deps — the same composition lab/executors.ts wires with the real
// seams), plus a tenant-isolation harness that mirrors the routes'
// findFirst({ id, tenantId }) scoping law:
//
//   1. the DISCLAIMER CONTRACT — visualOnlyDisclaimer is a required,
//      verbatim constant: altered/missing disclaimers are rejected by
//      assertTryOnSuccess; every pipeline result carries it intact;
//   2. fail-closed provider resolution — unset/none → honest unavailable;
//      the hosted path without its credentials → unavailable with the
//      precise missing-key list; unknown values throw (never a guess);
//   3. garment upload validation — the evidence-upload laws (mime allow-list,
//      non-empty ≤10MB, displayName/productRef/productUrl bounds);
//   4. identity-report honesty — unverified checks carry score null with the
//      reason (unknown is unknown); real scores only from real comparisons;
//      product-reference preservation is a structural invariant whose failure
//      refuses the whole result (identity_check_failed);
//   5. the diff manifest — provider-reported changes map verbatim; no report
//      → the single honest unknown-source entry, never an invented list;
//   6. the vision-comparison parser — strict JSON score parse, unparseable
//      answers NEVER become guessed scores;
//   7. the hosted Vertex call (injected fetch) — request shape, honest error
//      taxonomy (verbatim status/body), the no-image refusal, the API-key
//      header flow, real-latency measurement of the (fake) HTTP boundary;
//   8. the pipeline fold — provider gate fires BEFORE any provider spend;
//      progress only on real signals; success composes the full contract
//      result; a mismatched artifactProductRef refuses at the contract;
//   9. the HTTP taxonomy — TryOnRefusal → standard envelope spec;
//  10. tenant isolation — the route-fold harness: another tenant's try-on
//      jobs and garments are honestly not_found, never a leak.
//
// Imported STATICALLY by tests/index.mjs — runs in the aggregated
// `node --test tests/` gate. No env mutations (env is passed explicitly to
// every resolution call).
// ═══════════════════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GARMENT_ALLOWED_MIMES,
  GARMENT_MAX_BYTES,
  NO_PROVIDER_DIFF,
  TRYON_ADAPTER,
  TRYON_STYLES,
  TryOnRefusal,
  VISUAL_ONLY_DISCLAIMER,
  assertTryOnSuccess,
  buildIdentityReport,
  buildVertexTryOnRequest,
  diffManifestFromProvider,
  disclaimerIsIntact,
  executeVertexTryOnCall,
  isAcceptableProductUrl,
  parseVisionComparison,
  resolveTryOnProvider,
  runTryOnPipeline,
  tryOnHttpSpec,
  validateGarmentUpload,
  validateTryOnInput,
  vertexTryOnUrl,
} from '../../apps/web/src/lib/you/adapters/try-on.ts';

const PNG = 'image/png';
const RESOLUTION = { provider: 'vertex-virtual-try-on', project: 'proj-1', location: 'us-central1', available: true };

function refusalOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof TryOnRefusal, `expected TryOnRefusal, got ${err?.constructor?.name}`);
    return err;
  }
  assert.fail('expected a refusal but the call succeeded');
}

// ─── 1. The disclaimer contract ──────────────────────────────────────────────

test('disclaimer: the constant states BOTH halves (visual simulation AND no physical-fit claim)', () => {
  assert.ok(VISUAL_ONLY_DISCLAIMER.length > 80, 'a substantive disclaimer, not a token');
  assert.match(VISUAL_ONLY_DISCLAIMER, /visual/i);
  assert.match(VISUAL_ONLY_DISCLAIMER, /not a physical-fit/i);
  assert.match(VISUAL_ONLY_DISCLAIMER, /size|measurements/i);
  assert.match(VISUAL_ONLY_DISCLAIMER, /drape|comfort|fabric/i);
});

test('disclaimer: intact only for the verbatim constant', () => {
  assert.equal(disclaimerIsIntact(VISUAL_ONLY_DISCLAIMER), true);
  assert.equal(disclaimerIsIntact(`${VISUAL_ONLY_DISCLAIMER} `), false, 'trailing space breaks it');
  assert.equal(disclaimerIsIntact(VISUAL_ONLY_DISCLAIMER.toUpperCase()), false, 'case changes break it');
  assert.equal(disclaimerIsIntact(''), false);
  assert.equal(disclaimerIsIntact(undefined), false);
  assert.equal(disclaimerIsIntact(42), false);
});

test('disclaimer: assertTryOnSuccess rejects an altered/missing disclaimer (contract, not UI text)', () => {
  const base = validResult();
  const altered = refusalOf(() => assertTryOnSuccess({ ...base, visualOnlyDisclaimer: 'looks great on you!' }));
  assert.equal(altered.code, 'validation_failed');
  assert.match(altered.message, /visualOnlyDisclaimer/);
  const missing = refusalOf(() => assertTryOnSuccess({ ...base, visualOnlyDisclaimer: undefined }));
  assert.equal(missing.code, 'validation_failed');
});

// ─── 2. Fail-closed provider resolution ─────────────────────────────────────

test('provider: unset / empty / "none" → honest unavailable (fail-closed default)', () => {
  for (const provider of [undefined, '', '  ', 'none', 'NONE', ' None ']) {
    const status = resolveTryOnProvider({ provider });
    assert.equal(status.available, false, `provider=${JSON.stringify(provider)} must be unavailable`);
    assert.match(status.reason, /YOU_TRYON_PROVIDER is not configured/);
    assert.match(status.reason, /fail-closed/i);
    assert.match(status.reason, /never a stub image/i);
  }
});

test('provider: hosted id without credentials → unavailable with the precise missing-key list', () => {
  const none = resolveTryOnProvider({ provider: 'vertex-virtual-try-on' });
  assert.equal(none.available, false);
  assert.match(none.reason, /YOU_TRYON_VERTEX_PROJECT/);
  assert.match(none.reason, /YOU_TRYON_VERTEX_LOCATION/);
  assert.match(none.reason, /YOU_TRYON_VERTEX_KEY/);

  const partial = resolveTryOnProvider({
    provider: 'vertex-virtual-try-on',
    vertexProject: 'proj-1',
    vertexLocation: 'us-central1',
  });
  assert.equal(partial.available, false);
  assert.match(partial.reason, /missing YOU_TRYON_VERTEX_KEY/);
  assert.doesNotMatch(partial.reason, /PROJECT/);
});

test('provider: full credentials → available with the resolution', () => {
  const status = resolveTryOnProvider({
    provider: ' Vertex-Virtual-Try-On ',
    vertexProject: ' proj-1 ',
    vertexLocation: ' us-central1 ',
    vertexKey: ' key-1 ',
  });
  assert.deepEqual(status, RESOLUTION);
});

test('provider: unknown value → throws (the platform never guesses)', () => {
  assert.throws(
    () => resolveTryOnProvider({ provider: 'magic-tryon' }),
    /YOU_TRYON_PROVIDER must be "vertex-virtual-try-on"/,
  );
  assert.throws(() => resolveTryOnProvider({ provider: 'local' }), /refusing to guess/);
});

// ─── 3. Garment upload validation (the evidence-upload laws) ────────────────

test('garment validation: mime allow-list (png/jpeg/webp only)', () => {
  for (const mime of GARMENT_ALLOWED_MIMES) {
    assert.deepEqual(validateGarmentUpload(makeGarment({ mime })), normalizedGarment({ mime }));
  }
  for (const mime of ['image/gif', 'image/svg+xml', 'video/mp4', 'application/octet-stream', '', 'PNG']) {
    const r = refusalOf(() => validateGarmentUpload(makeGarment({ mime })));
    assert.equal(r.code, 'validation_failed');
    assert.match(r.message, /unsupported garment mime/);
  }
});

test('garment validation: size laws — empty and >10MB refuse', () => {
  assert.equal(refusalOf(() => validateGarmentUpload(makeGarment({ bytes: 0 }))).code, 'validation_failed');
  const over = refusalOf(() => validateGarmentUpload(makeGarment({ bytes: GARMENT_MAX_BYTES + 1 })));
  assert.equal(over.code, 'validation_failed');
  assert.match(over.message, /10MB/);
  assert.deepEqual(validateGarmentUpload(makeGarment({ bytes: GARMENT_MAX_BYTES })), normalizedGarment({ bytes: GARMENT_MAX_BYTES }));
});

test('garment validation: displayName required, bounded', () => {
  assert.equal(refusalOf(() => validateGarmentUpload(makeGarment({ displayName: '  ' }))).code, 'validation_failed');
  const long = refusalOf(() => validateGarmentUpload(makeGarment({ displayName: 'x'.repeat(121) })));
  assert.match(long.message, /120 characters/);
});

test('garment validation: productRef bounded, productUrl must be absolute http(s)', () => {
  const refLong = refusalOf(() => validateGarmentUpload(makeGarment({ productRef: 'r'.repeat(129) })));
  assert.match(refLong.message, /productRef exceeds 128/);
  for (const bad of ['ftp://shop.example/p', 'not-a-url', 'http://', '//example.com/p']) {
    assert.equal(isAcceptableProductUrl(bad), false, `${bad} must not pass`);
    const r = refusalOf(() => validateGarmentUpload(makeGarment({ productUrl: bad })));
    assert.equal(r.code, 'validation_failed');
    assert.match(r.message, /http\(s\) URL/);
  }
  const ok = validateGarmentUpload(makeGarment({ productUrl: 'https://shop.example.com/p/4821' }));
  assert.equal(ok.productUrl, 'https://shop.example.com/p/4821');
  // absent optional fields normalize to null
  assert.deepEqual(validateGarmentUpload(makeGarment({})), normalizedGarment({}));
});

function makeGarment(overrides = {}) {
  return {
    mime: PNG,
    bytes: 1024,
    displayName: 'Aurora Wool Coat',
    productRef: undefined,
    productUrl: undefined,
    ...overrides,
  };
}

/** the normalized shape validateGarmentUpload returns for a makeGarment input */
function normalizedGarment(overrides = {}) {
  const g = makeGarment(overrides);
  return {
    mime: g.mime,
    bytes: g.bytes,
    displayName: g.displayName,
    productRef: g.productRef ?? null,
    productUrl: g.productUrl ?? null,
  };
}

// ─── 4. validateTryOnInput (route body shape) ───────────────────────────────

test('try-on input: ids required, style union enforced, default photorealistic', () => {
  const missing = refusalOf(() => validateTryOnInput({}));
  assert.equal(missing.code, 'validation_failed');
  assert.match(missing.message, /twinId, twinVersionId and garmentAssetId/);
  const badStyle = refusalOf(() => validateTryOnInput({ twinId: 't', twinVersionId: 'v', garmentAssetId: 'g', style: 'gothic' }));
  assert.match(badStyle.message, new RegExp(TRYON_STYLES.join(', ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const input = validateTryOnInput({ twinId: ' t ', twinVersionId: 'v', garmentAssetId: 'g' });
  assert.deepEqual(input, { twinId: 't', twinVersionId: 'v', garmentAssetId: 'g', style: 'photorealistic' });
  assert.deepEqual(validateTryOnInput({ twinId: 't', twinVersionId: 'v', garmentAssetId: 'g', style: 'anime' }).style, 'anime');
});

// ─── 5. Identity-report honesty ──────────────────────────────────────────────

test('identity report: no vision ran → unverified with score null and the reason (never invented)', () => {
  const report = buildReport({});
  assert.equal(report.productRefPreserved, true);
  assert.equal(report.garmentIdentity.status, 'unverified');
  assert.equal(report.garmentIdentity.method, 'none');
  assert.equal(report.garmentIdentity.score, null);
  assert.match(report.garmentIdentity.reason, /no vision comparison ran/);
  assert.equal(report.twinIdentity.status, 'unverified');
  assert.equal(report.twinIdentity.score, null);
  assert.equal(report.checksPassed, false, 'unverified checks do not pass');
  assert.deepEqual(report.failures, []);
});

test('identity report: real vision scores flow through; a low score is an honest FAILED check', () => {
  const report = buildReport({
    garmentVsOutput: { score: 0.82, note: 'same coat, same drape direction' },
    baselineVsOutput: { score: 0.91, note: 'same person presentation' },
  });
  assert.equal(report.garmentIdentity.status, 'verified');
  assert.equal(report.garmentIdentity.score, 0.82);
  assert.equal(report.garmentIdentity.method, 'vision-comparison');
  assert.match(report.garmentIdentity.reason, /0\.820/);
  assert.equal(report.twinIdentity.status, 'verified');
  assert.equal(report.checksPassed, true);

  const failed = buildReport({ garmentVsOutput: { score: 0.3, note: 'different garment' } });
  assert.equal(failed.garmentIdentity.status, 'failed');
  assert.equal(failed.garmentIdentity.score, 0.3);
  assert.match(failed.garmentIdentity.reason, /below the 0\.6 threshold/);
  assert.ok(failed.failures.some((f) => /garment identity check failed/.test(f)));
  assert.equal(failed.checksPassed, false);
});

test('identity report: a non-finite vision score is refused, not reported', () => {
  const report = buildReport({ garmentVsOutput: { score: Number.NaN, note: 'x' } });
  assert.equal(report.garmentIdentity.status, 'unverified');
  assert.equal(report.garmentIdentity.score, null);
  assert.match(report.garmentIdentity.reason, /non-finite score/);
});

test('identity report: product-reference preservation is structural — a mismatch fails honestly', () => {
  const report = buildReport({ garmentProductRef: 'SKU-4821', artifactProductRef: 'SKU-9999' });
  assert.equal(report.productRefPreserved, false);
  assert.ok(report.failures.some((f) => /not preserved/.test(f)));
  assert.equal(report.checksPassed, false);
  // and the contract refuses to compose a result over a lost product ref
  const r = refusalOf(() => assertTryOnSuccess(validResult({ identityReport: report })));
  assert.equal(r.code, 'identity_check_failed');
});

test('identity report: threshold is honored when provided', () => {
  const strict = buildReport({ garmentVsOutput: { score: 0.65, note: '' }, threshold: 0.9 });
  assert.equal(strict.garmentIdentity.status, 'failed');
});

function buildReport(input) {
  return buildIdentityReport(input);
}

// ─── 5. Diff manifest (provider-reported or honestly unknown) ───────────────

test('diff manifest: no provider report → the single honest unknown entry', () => {
  for (const reported of [null, undefined, [], 'not-an-array', [{ region: '', description: 'x' }], [{ region: 'torso' }]]) {
    assert.deepEqual(diffManifestFromProvider(reported), NO_PROVIDER_DIFF, `${JSON.stringify(reported)} → the honest unknown`);
  }
  assert.equal(NO_PROVIDER_DIFF.providerReportedNothing, true);
  assert.equal(NO_PROVIDER_DIFF.changes.length, 1);
  assert.equal(NO_PROVIDER_DIFF.changes[0].source, 'unknown');
  assert.match(NO_PROVIDER_DIFF.changes[0].description, /unknown/);
});

test('diff manifest: provider-reported changes map verbatim (source: provider)', () => {
  const manifest = diffManifestFromProvider([
    { region: 'torso', description: 'coat applied over base layer' },
    { region: 'arms', description: 'sleeves rendered' },
  ]);
  assert.equal(manifest.providerReportedNothing, false);
  assert.deepEqual(manifest.changes, [
    { region: 'torso', description: 'coat applied over base layer', source: 'provider' },
    { region: 'arms', description: 'sleeves rendered', source: 'provider' },
  ]);
});

test('diff manifest: bounds applied (region 64, description 400); malformed items dropped', () => {
  const manifest = diffManifestFromProvider([
    { region: 'r'.repeat(100), description: 'd'.repeat(500) },
    { region: 'legs', description: 'ok entry' },
    42,
    null,
  ]);
  assert.equal(manifest.changes.length, 2);
  assert.equal(manifest.changes[0].region.length, 64);
  assert.equal(manifest.changes[0].description.length, 400);
  assert.equal(manifest.changes[1].region, 'legs');
});

// ─── 6. The vision-comparison parser (strict — no guessed scores) ───────────

test('vision parser: strict JSON score parse (bare and fenced)', () => {
  assert.deepEqual(parseVisionComparison('{"score":0.82,"note":"same garment"}'), { score: 0.82, note: 'same garment' });
  assert.deepEqual(parseVisionComparison('```json\n{"score":0.4}\n```'), { score: 0.4, note: '' });
  assert.deepEqual(parseVisionComparison('  {"score":1,"note":""}  '), { score: 1, note: '' });
});

test('vision parser: unparseable or invalid answers → null (never a guess)', () => {
  for (const bad of [
    '', '   ', 'looks like the same coat to me', '{"score":"0.8"}', '{"score":1.4}', '{"score":-0.2}',
    '{"score":NaN}', '[{"score":0.5}]', 'null', '{"note":"no score"}', '```text\nnope\n```',
  ]) {
    assert.equal(parseVisionComparison(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});

test('vision parser: the note is bounded', () => {
  const parsed = parseVisionComparison('{"score":0.5,"note":"' + 'y'.repeat(500) + '"}');
  assert.equal(parsed.note.length, 200);
});

// ─── 7. The hosted Vertex call (injected fetch — no network) ────────────────

const PERSON = new Uint8Array([1, 2, 3, 4]);
const GARMENT = new Uint8Array([9, 8, 7]);
const OUT_B64 = Buffer.from('fake-tryon-bytes').toString('base64');

function okFetch(body) {
  return async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
}

test('vertex call: request shape (person + garment base64, mime-typed) and URL', () => {
  const req = JSON.parse(buildVertexTryOnRequest({ personImage: PERSON, garmentImage: GARMENT }, 'image/png', 'image/jpeg'));
  assert.deepEqual(req, {
    personImage: { bytesBase64Encoded: Buffer.from(PERSON).toString('base64'), mimeType: 'image/png' },
    productImage: { bytesBase64Encoded: Buffer.from(GARMENT).toString('base64'), mimeType: 'image/jpeg' },
  });
  assert.equal(
    vertexTryOnUrl('proj-1', 'us-central1'),
    'https://us-central1-aiplatform.googleapis.com/v1/projects/proj-1/locations/us-central1/endpoints/open-api/api/v1/multimodal:predict',
  );
});

test('vertex call: happy path — image bytes, modelVersion, reportedChanges, measured latency', async () => {
  let sawUrl;
  let sawInit;
  const result = await executeVertexTryOnCall(
    RESOLUTION,
    { personImage: PERSON, garmentImage: GARMENT },
    {
      personMime: 'image/png',
      garmentMime: 'image/jpeg',
      apiKey: 'key-1',
      fetchImpl: async (url, init) => {
        sawUrl = url;
        sawInit = init;
        return okFetch({
          candidates: [{ content: { parts: [{ inlineData: { data: OUT_B64, mimeType: 'image/png' } }] } }],
          modelVersion: 'tryon-v2',
          reportedChanges: [{ region: 'torso', description: 'coat applied over base layer' }],
        })();
      },
    },
  );
  assert.equal(sawUrl, vertexTryOnUrl('proj-1', 'us-central1'));
  assert.equal(sawInit.method, 'POST');
  assert.equal(sawInit.headers['x-goog-api-key'], 'key-1');
  assert.equal(sawInit.headers['content-type'], 'application/json');
  assert.deepEqual(result.imageBytes, new Uint8Array(Buffer.from('fake-tryon-bytes')));
  assert.equal(result.modelVersion, 'tryon-v2');
  assert.deepEqual(result.reportedChanges, [{ region: 'torso', description: 'coat applied over base layer' }]);
  assert.equal(result.taskId, null);
  assert.ok(result.latencyMs >= 0, 'latency measured at the HTTP boundary');
});

test('vertex call: non-2xx → provider_error with the verbatim status + body excerpt', async () => {
  const err = await rejectsRefusal(() =>
    executeVertexTryOnCall(RESOLUTION, { personImage: PERSON, garmentImage: GARMENT }, {
      personMime: 'image/png',
      garmentMime: 'image/jpeg',
      apiKey: 'key-1',
      fetchImpl: async () => ({ ok: false, status: 403, text: async () => '{"error":"PERMISSION_DENIED on project proj-1"}' }),
    }),
  );
  assert.equal(err.code, 'provider_error');
  assert.match(err.message, /HTTP 403/);
  assert.match(err.message, /PERMISSION_DENIED on project proj-1/);
});

test('vertex call: a response with no generated image refuses honestly (never a placeholder)', async () => {
  const err = await rejectsRefusal(() =>
    executeVertexTryOnCall(RESOLUTION, { personImage: PERSON, garmentImage: GARMENT }, {
      personMime: 'image/png',
      garmentMime: 'image/jpeg',
      apiKey: 'key-1',
      fetchImpl: okFetch({ candidates: [{ content: { parts: [{ text: 'sorry' }] } }] }),
    }),
  );
  assert.equal(err.code, 'provider_error');
  assert.match(err.message, /no generated image/);
  assert.match(err.message, /never.*placeholder|refusing to substitute/i);
});

test('vertex call: network failure and non-JSON bodies surface verbatim', async () => {
  const network = await rejectsRefusal(() =>
    executeVertexTryOnCall(RESOLUTION, { personImage: PERSON, garmentImage: GARMENT }, {
      personMime: 'image/png',
      garmentMime: 'image/jpeg',
      apiKey: 'key-1',
      fetchImpl: async () => { throw new Error('ECONNRESET mid-flight'); },
    }),
  );
  assert.equal(network.code, 'provider_error');
  assert.match(network.message, /ECONNRESET mid-flight/);

  const badJson = await rejectsRefusal(() =>
    executeVertexTryOnCall(RESOLUTION, { personImage: PERSON, garmentImage: GARMENT }, {
      personMime: 'image/png',
      garmentMime: 'image/jpeg',
      apiKey: 'key-1',
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>gateway error</html>' }),
    }),
  );
  assert.equal(badJson.code, 'provider_error');
  assert.match(badJson.message, /not valid JSON/);
});

async function rejectsRefusal(fn) {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof TryOnRefusal, `expected TryOnRefusal, got ${err?.constructor?.name}`);
    return err;
  }
  assert.fail('expected a refusal but the call succeeded');
}

// ─── 8. The pipeline fold (the executor's exact composition) ────────────────

function makeDeps(overrides = {}) {
  const calls = { loadGarment: 0, renderBaseline: 0, callProvider: 0, store: 0, compare: 0 };
  const deps = {
    resolveProvider: () => RESOLUTION,
    loadGarmentBytes: async () => {
      calls.loadGarment += 1;
      return GARMENT;
    },
    renderBaseline: async () => {
      calls.renderBaseline += 1;
      return {
        storageKey: 'render/base-hash.png',
        contentHash: 'base-hash',
        bytes: 2048,
        mime: 'image/png',
        latencyMs: 1200,
        provider: 'station',
        providerModel: null,
      };
    },
    storeTryOnImage: async (bytes) => {
      calls.store += 1;
      return { storageKey: `tryon/${bytes.length}`, contentHash: `hash-${bytes.length}`, bytes: bytes.byteLength };
    },
    callProvider: async () => {
      calls.callProvider += 1;
      return {
        imageBytes: new Uint8Array(Buffer.from('fake-tryon-bytes')),
        reportedChanges: [{ region: 'torso', description: 'coat applied' }],
        taskId: null,
        modelVersion: 'tryon-v2',
        latencyMs: 2100,
      };
    },
    compareImages: async () => {
      calls.compare += 1;
      return { score: 0.9, note: 'looks preserved' };
    },
    garmentProductRef: 'SKU-4821',
    artifactProductRef: 'SKU-4821',
    ...overrides,
  };
  return { deps, calls };
}

test('pipeline: provider unavailable → typed refusal BEFORE any provider spend', async () => {
  const { deps, calls } = makeDeps({
    resolveProvider: () => ({
      available: false,
      reason: 'YOU_TRYON_PROVIDER is not configured — no virtual try-on provider is selected. Try-on jobs fail honestly here (fail-closed); never a stub image. Configure a characterized provider to enable the path.',
    }),
  });
  const err = await rejectsRefusal(() =>
    runTryOnPipeline({ garmentStorageKey: 'garment/g1.png', garmentMime: PNG }, deps),
  );
  assert.equal(err.code, 'tryon_unavailable');
  assert.match(err.message, /YOU_TRYON_PROVIDER is not configured/);
  assert.deepEqual(calls, { loadGarment: 0, renderBaseline: 0, callProvider: 0, store: 0, compare: 0 });
});

test('pipeline: garment bytes missing from storage → honest validation refusal', async () => {
  const { deps } = makeDeps({ loadGarmentBytes: async () => null });
  const err = await rejectsRefusal(() =>
    runTryOnPipeline({ garmentStorageKey: 'garment/missing.png', garmentMime: PNG }, deps),
  );
  assert.equal(err.code, 'validation_failed');
  assert.match(err.message, /garment\/missing\.png/);
});

test('pipeline: success composes the full CONTRACT result', async () => {
  const { deps, calls } = makeDeps();
  const progress = [];
  const result = await runTryOnPipeline({ garmentStorageKey: 'garment/g1.png', garmentMime: PNG }, deps, (p) => {
    progress.push(p.step);
  });
  assert.equal(result.storageKey, 'tryon/16');
  assert.equal(result.contentHash, 'hash-16');
  assert.equal(result.bytes, 16);
  assert.deepEqual(result.baseline, { storageKey: 'render/base-hash.png', contentHash: 'base-hash', bytes: 2048, mime: 'image/png' });
  assert.equal(result.latencyMs, 2100, 'the hosted call latency flows through');
  assert.equal(result.provider, 'vertex-virtual-try-on');
  assert.equal(result.providerModel, 'tryon-v2');
  assert.equal(disclaimerIsIntact(result.visualOnlyDisclaimer), true, 'the disclaimer rides every result');
  assert.equal(result.identityReport.productRefPreserved, true);
  assert.equal(result.identityReport.garmentIdentity.status, 'verified');
  assert.equal(result.identityReport.garmentIdentity.score, 0.9);
  assert.equal(result.identityReport.twinIdentity.status, 'verified');
  assert.equal(result.identityReport.checksPassed, true);
  assert.deepEqual(result.diffManifest.changes, [{ region: 'torso', description: 'coat applied', source: 'provider' }]);
  assert.deepEqual(progress, ['provider', 'baseline', 'tryon', 'comparison'], 'progress only on real signals, in order');
  assert.deepEqual(calls, { loadGarment: 1, renderBaseline: 1, callProvider: 1, store: 1, compare: 2 });
});

test('pipeline: a throwing vision compare → honest unverified with the captured reason', async () => {
  const { deps } = makeDeps({
    compareImages: async () => {
      throw new Error('two-image vision comparison is not implemented on the openrouter recon path (P6.C8 v1)');
    },
    get visionUnavailableReason() {
      return 'two-image vision comparison is not implemented on the openrouter recon path (P6.C8 v1)';
    },
  });
  const result = await runTryOnPipeline({ garmentStorageKey: 'garment/g1.png', garmentMime: PNG }, deps);
  assert.equal(result.identityReport.garmentIdentity.status, 'unverified');
  assert.equal(result.identityReport.garmentIdentity.score, null);
  assert.match(result.identityReport.garmentIdentity.reason, /openrouter recon path/);
  assert.equal(result.identityReport.checksPassed, false);
});

test('pipeline: vision compare returns null without a reason → the default honest unknown', async () => {
  const { deps } = makeDeps({ compareImages: async () => null });
  const result = await runTryOnPipeline({ garmentStorageKey: 'garment/g1.png', garmentMime: PNG }, deps);
  assert.match(result.identityReport.garmentIdentity.reason, /no vision comparison ran/);
});

test('pipeline: artifact product ref mismatch → the contract refuses the result', async () => {
  const { deps } = makeDeps({ artifactProductRef: 'SKU-DIFFERENT' });
  const err = await rejectsRefusal(() =>
    runTryOnPipeline({ garmentStorageKey: 'garment/g1.png', garmentMime: PNG }, deps),
  );
  assert.equal(err.code, 'identity_check_failed');
  assert.match(err.message, /product reference not preserved/);
});

test('pipeline: provider call failure propagates verbatim through the fold', async () => {
  const { deps } = makeDeps({
    callProvider: async () => {
      throw new TryOnRefusal('provider_error', 'try-on provider returned HTTP 429: quota exceeded');
    },
  });
  const err = await rejectsRefusal(() =>
    runTryOnPipeline({ garmentStorageKey: 'garment/g1.png', garmentMime: PNG }, deps),
  );
  assert.equal(err.code, 'provider_error');
  assert.match(err.message, /HTTP 429: quota exceeded/);
});

// ─── 9. HTTP taxonomy ────────────────────────────────────────────────────────

test('http taxonomy: every refusal code maps to its envelope spec; unknown errors map to null', () => {
  const cases = [
    ['validation_failed', 400],
    ['tryon_unavailable', 503],
    ['provider_error', 502],
    ['identity_check_failed', 422],
  ];
  for (const [code, status] of cases) {
    const spec = tryOnHttpSpec(new TryOnRefusal(code, `msg-${code}`));
    assert.equal(spec.status, status);
    assert.equal(spec.code, code);
    assert.equal(spec.message, `msg-${code}`);
  }
  assert.equal(tryOnHttpSpec(new Error('plain')), null);
  assert.equal(tryOnHttpSpec(null), null);
});

// ─── 10. Tenant isolation — the route-fold harness ──────────────────────────

// Mirrors the routes' scoping law exactly: findFirst({ where: { id, tenantId } })
// over the row store; a miss is an honest not_found, never a leak.
function scopedFind(rows, { id, tenantId }) {
  const row = rows.find((r) => r.id === id && r.tenantId === tenantId) ?? null;
  return row;
}

async function getTryOnJobRouteFold(rows, auth, id) {
  const row = scopedFind(rows, { id, tenantId: auth.tenantId });
  if (!row) {
    return { status: 404, code: 'not_found', message: `try-on job "${id}" not found`, row: null };
  }
  return { status: 200, code: null, message: null, row };
}

test('tenant isolation: another tenant\'s try-on job is honestly not_found', async () => {
  const rows = [
    { id: 'tryon_a', tenantId: 'tenant_a', status: 'succeeded' },
    { id: 'tryon_b', tenantId: 'tenant_b', status: 'succeeded' },
  ];
  const asA = await getTryOnJobRouteFold(rows, { tenantId: 'tenant_a' }, 'tryon_b');
  assert.equal(asA.status, 404);
  assert.equal(asA.row, null, 'no row leaks across tenants');
  const own = await getTryOnJobRouteFold(rows, { tenantId: 'tenant_a' }, 'tryon_a');
  assert.equal(own.status, 200);
  assert.equal(own.row.id, 'tryon_a');
  const unknown = await getTryOnJobRouteFold(rows, { tenantId: 'tenant_a' }, 'tryon_zz');
  assert.equal(unknown.status, 404);
});

test('tenant isolation: garments scope the same way (upload/list/detail)', () => {
  const garments = [
    { id: 'g1', tenantId: 'tenant_a', displayName: 'Coat A', storageKey: 'garment/h1.png' },
    { id: 'g2', tenantId: 'tenant_b', displayName: 'Coat B', storageKey: 'garment/h2.png' },
  ];
  assert.equal(scopedFind(garments, { id: 'g2', tenantId: 'tenant_a' }), null);
  assert.equal(scopedFind(garments, { id: 'g1', tenantId: 'tenant_a' })?.id, 'g1');
  assert.equal(scopedFind(garments, { id: 'g1', tenantId: 'tenant_b' }), null);
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function validResult(overrides = {}) {
  return {
    storageKey: 'tryon/h.png',
    contentHash: 'h',
    bytes: 10,
    mime: 'image/png',
    baseline: { storageKey: 'render/b.png', contentHash: 'b', bytes: 5, mime: 'image/png' },
    latencyMs: 100,
    provider: 'vertex-virtual-try-on',
    providerModel: null,
    providerTaskId: null,
    diffManifest: NO_PROVIDER_DIFF,
    identityReport: buildIdentityReport({ garmentProductRef: null, artifactProductRef: null }),
    visualOnlyDisclaimer: VISUAL_ONLY_DISCLAIMER,
    ...overrides,
  };
}

// adapter descriptor sanity (the catalog-facing identity)
test('adapter descriptor: provider-neutral, visual-only, honest claims note', () => {
  assert.equal(TRYON_ADAPTER.adapterId, 'tryon-adapter-1');
  assert.equal(TRYON_ADAPTER.providerNeutral, true);
  assert.equal(TRYON_ADAPTER.visualOnly, true);
  assert.match(TRYON_ADAPTER.claimsNote, /NO physical-fit claim/);
});
