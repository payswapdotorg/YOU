// ═══════════════════════════════════════════════════════════════════════════
// Game/VRM/GLB export contract tests (P6.C9 — Worker C lane) — node:test.
//
// PURE UNIT TESTS — no server boot, no network, no real keys, no database.
// Covers the game-export adapter's pure contract core (lib/you/adapters/
// game-export.ts) — the same zero-import module the export.glb/export.vrm
// executors fold with the real seams:
//
//   1. GLB BINARY VALIDITY — magic 'glTF', version 2, chunk layout (JSON
//      then BIN, 4-byte aligned, space/zero padding), JSON parses, buffer
//      covers every bufferView, every accessor fits its view, POSITION
//      accessors carry min/max;
//   2. NODE/SKIN HIERARCHY vs the HTIR — the you-generic-v1 bones as glTF
//      nodes with children chains, one shared skin, inverseBindMatrices
//      count == joints count, rest-pose translation consistency
//      (child global = parent global + local translation);
//   3. VRM EXTENSION — present only on the vrm format; VRM-0 humanoid bone
//      map covers all 19 bones with valid node indices; blendshape groups
//      ONLY for the HTIR articulation set; preset names exact only where the
//      mapping is honest (Neutral/Blink), custom-named elsewhere; morph
//      target deltas are ALL ZERO (placeholder honesty — no fabricated
//      deltas);
//   4. LOD HONESTY — three levels, strictly decimating triangle counts, and
//      the manifest counts MATCH a recount from the actual emitted GLB JSON
//      (indices accessors / primitive lists) — never claimed without being
//      emitted; LOD2 records the hands/feet omission;
//   5. DETERMINISM — byte-identical re-export (sha256-stable); different
//      options or a different HTIR produce different bytes;
//   6. FAIL-CLOSED NEGATIVES — unknown format / bad lodLevel → typed
//      validation refusal (never a guess); a TwinVersion without usable
//      geometry (missing HTIR, unknown skeleton convention, no finite
//      measurements) → honest geometry_unavailable refusal BEFORE any bytes;
//   7. MANIFEST SPLIT — the structural-vs-derived split is part of the
//      contract: structural entries carry the HTIR verbatim values; derived
//      entries carry their bases (canonical defaults, parametric mesh);
//      assertExportSuccess refuses tampered claims, empty halves,
//      non-decimating LODs;
//   8. MAPPING TABLE + PACKAGE MANIFEST — engine bone names (VRM + Unity +
//      Unreal), ARKit blendshape mapping where it maps and explicit
//      'unmapped' entries where it does not; the package README states what
//      is and is NOT included (no fake engine plugins);
//   9. API SURFACE (route folds) — create validation, twin/version 404s,
//      consent 403 (reconstruct scope — wrong scope, revoked, expired),
//      idempotent replay returning the ORIGINAL ids, GET tenant isolation
//      404; the HTTP taxonomy.
//
// Imported STATICALLY by tests/index.mjs — runs in the aggregated
// `node --test tests/` gate. No env mutations.
// ═══════════════════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  BONES,
  EXPORT_CLAIMS,
  EXPORT_FORMATS,
  EXPORT_GLB_JOB_KIND,
  EXPORT_LOD_LEVELS,
  EXPORT_VRM_JOB_KIND,
  ExportRefusal,
  GAME_EXPORT_ADAPTER,
  assertExportSuccess,
  buildPackageManifest,
  claimsAreIntact,
  decideCreateExport,
  decideGetExport,
  exportHttpSpec,
  exportJobKindFor,
  mapBlendshapes,
  parseHtirForExport,
  checkGeometryUsable,
  runExportPipeline,
  validateExportInput,
} from '../../apps/web/src/lib/you/adapters/game-export.ts';

const GLB_MAGIC = 0x46546c67;

// ─── fixtures ───────────────────────────────────────────────────────────────

function makeHtir(overrides = {}) {
  return {
    morphology: { build: 'athletic', heightEstimateCm: 178, descriptors: ['medium frame'] },
    geometry: {
      skeleton: 'you-generic-v1',
      measurements: { shoulderRatio: 0.245, headRatio: 0.128 },
      face: { landmarkSummary: 'oval', proportions: {} },
      hands: { detail: 'medium' },
    },
    appearance: {
      palette: { skin: '#c8956c', hair: '#3b2a20', eyes: '#4a342a' },
      hair: { style: 'short', length: 'short', coverage: 'low' },
      clothing: { style: 'casual', items: ['t-shirt'] },
      distinguishing: ['glasses'],
    },
    articulation: { blendshapes: ['neutral', 'smile', 'brow-raise', 'blink'], gazeModel: 'basic' },
    neuralAppearance: { enabled: false },
    motionProfile: { defaultPose: 'neutral-standing', gestureStyle: 'reserved', tempo: 'moderate' },
    confidence: { overall: 0.7, byDomain: { morphology: 0.7, appearance: 0.68, geometry: 0.62 }, deficiencies: [] },
    ...overrides,
  };
}

function makeInput(overrides = {}) {
  return validateExportInput({
    twinId: 'twin_1',
    twinVersionId: 'v_1',
    format: 'glb',
    lodLevel: 1,
    includeFacialControls: true,
    ...overrides,
  });
}

/** Parse a GLB into { header, json, bin } with structural assertions inline. */
function parseGlb(bytes, label = 'glb') {
  const b = Buffer.from(bytes);
  assert.ok(b.length >= 20, `${label}: too short for a GLB header`);
  const magic = b.readUInt32LE(0);
  const version = b.readUInt32LE(4);
  const totalLength = b.readUInt32LE(8);
  assert.equal(magic, GLB_MAGIC, `${label}: magic must be 'glTF'`);
  assert.equal(version, 2, `${label}: glTF version must be 2`);
  assert.equal(totalLength, b.length, `${label}: header length must equal the byte length`);
  // JSON chunk
  const jsonLength = b.readUInt32LE(12);
  const jsonType = b.readUInt32LE(16);
  assert.equal(jsonType, 0x4e4f534a, `${label}: first chunk must be JSON`);
  assert.equal(jsonLength % 4, 0, `${label}: JSON chunk length must be 4-byte aligned`);
  const jsonText = b.slice(20, 20 + jsonLength).toString('utf8');
  const json = JSON.parse(jsonText);
  // space padding at the end of the JSON chunk
  const pad = jsonLength - JSON.stringify(json).length; // ≥ 0 (padding only)
  assert.ok(pad >= 0 && pad < 4, `${label}: JSON padding is 0..3 bytes`);
  for (let i = 0; i < pad; i += 1) {
    assert.equal(b[20 + jsonLength - 1 - i], 0x20, `${label}: JSON chunk pads with spaces`);
  }
  // BIN chunk
  const binHeaderAt = 20 + jsonLength;
  const binLength = b.readUInt32LE(binHeaderAt);
  const binType = b.readUInt32LE(binHeaderAt + 4);
  assert.equal(binType, 0x004e4942, `${label}: second chunk must be BIN`);
  assert.equal(binLength % 4, 0, `${label}: BIN chunk length must be 4-byte aligned`);
  const bin = b.slice(binHeaderAt + 8, binHeaderAt + 8 + binLength);
  assert.equal(binHeaderAt + 8 + binLength, b.length, `${label}: chunks must exactly fill the container`);
  return { b, json, bin };
}

function refusalOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ExportRefusal, `expected ExportRefusal, got ${err?.constructor?.name}`);
    return err;
  }
  assert.fail('expected a refusal but the call succeeded');
}

async function rejectsRefusal(fn) {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof ExportRefusal, `expected ExportRefusal, got ${err?.constructor?.name}`);
    return err;
  }
  assert.fail('expected a refusal but the call succeeded');
}

// ─── 1. GLB binary validity ─────────────────────────────────────────────────

test('glb: binary validity — magic, version, chunk layout, JSON parse (both formats)', () => {
  for (const format of EXPORT_FORMATS) {
    const result = runExportPipeline(makeHtir(), makeInput({ format }));
    const { json, bin } = parseGlb(result.bytes, format);
    assert.equal(json.asset.version, '2.0');
    assert.match(json.asset.generator, /you-glb-1/);
    assert.equal(json.buffers.length, 1);
    assert.equal(json.buffers[0].byteLength, bin.length, `${format}: buffer byteLength matches the BIN chunk`);
    assert.ok(bin.length > 0 && bin.length % 4 === 0);
  }
});

test('glb: every bufferView fits the buffer; every accessor fits its view; POSITION carries min/max', () => {
  const result = runExportPipeline(makeHtir(), makeInput());
  const { json, bin } = parseGlb(result.bytes);
  const bufferLength = json.buffers[0].byteLength;
  for (const [i, view] of json.bufferViews.entries()) {
    assert.ok(view.byteOffset >= 0 && view.byteOffset % 4 === 0, `bufferView ${i} offset 4-byte aligned`);
    assert.ok(view.byteOffset + view.byteLength <= bufferLength, `bufferView ${i} fits the buffer`);
  }
  const COMPONENT_SIZES = { 5121: 1, 5123: 2, 5126: 4 };
  const TYPE_ARITY = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 };
  for (const [i, acc] of json.accessors.entries()) {
    const view = json.bufferViews[acc.bufferView];
    const elt = COMPONENT_SIZES[acc.componentType] * TYPE_ARITY[acc.type];
    assert.equal(acc.byteOffset ?? 0, 0, `accessor ${i} uses its view from offset 0`);
    assert.ok(elt * acc.count <= view.byteLength, `accessor ${i} (${acc.type}, ${acc.count}) fits its view`);
    if (acc.type === 'VEC3' && acc.count === 24 && json.meshes.some((m) => m.primitives.some((p) => p.attributes.POSITION === i))) {
      assert.ok(Array.isArray(acc.min) && acc.min.length === 3, `POSITION accessor ${i} carries min`);
      assert.ok(Array.isArray(acc.max) && acc.max.length === 3, `POSITION accessor ${i} carries max`);
    }
  }
  // sanity: joints/weights/indices attribute types on every primitive
  for (const mesh of json.meshes) {
    for (const prim of mesh.primitives) {
      assert.equal(json.accessors[prim.attributes.POSITION].type, 'VEC3');
      assert.equal(json.accessors[prim.attributes.NORMAL].type, 'VEC3');
      assert.equal(json.accessors[prim.attributes.JOINTS_0].type, 'VEC4');
      assert.equal(json.accessors[prim.attributes.WEIGHTS_0].type, 'VEC4');
      assert.equal(json.accessors[prim.attributes.JOINTS_0].componentType, 5121);
      assert.equal(json.accessors[prim.indices].type, 'SCALAR');
      assert.equal(prim.material, 0);
    }
  }
});

// ─── 2. Node/skin hierarchy against the HTIR input ─────────────────────────

test('hierarchy: the 19 you-generic-v1 bones are glTF nodes with valid children chains', () => {
  const result = runExportPipeline(makeHtir(), makeInput());
  const { json } = parseGlb(result.bytes);
  // bone nodes occupy the first 19 positions in canonical order
  assert.equal(json.nodes.length, 19 + 3);
  for (const [i, bone] of BONES.entries()) {
    const node = json.nodes[i];
    assert.equal(node.name, bone.id, `node ${i} is bone ${bone.id}`);
    assert.ok(Array.isArray(node.translation) && node.translation.length === 3);
  }
  // children chains express the parent table exactly (both directions)
  const childOf = new Map();
  for (const [i, bone] of BONES.entries()) {
    if (bone.parent === null) continue;
    const parentIdx = BONES.findIndex((x) => x.id === bone.parent);
    const parentNode = json.nodes[parentIdx];
    assert.ok(Array.isArray(parentNode.children) && parentNode.children.includes(i), `${bone.parent} lists ${bone.id} as a child`);
    childOf.set(i, parentIdx);
  }
  // hips is the only bone without a parent
  assert.equal([...BONES.keys()].filter((i) => BONES[i].parent === null).length, 1);
  // rest-pose consistency: child global = parent global + local translation
  const global = BONES.map((bone) => {
    const H = 1.78; // heightEstimateCm 178 from the fixture
    if (bone.id === 'leftUpperArm') return [-((0.245 * H) / 2), 0.84 * H, 0];
    if (bone.id === 'rightUpperArm') return [(0.245 * H) / 2, 0.84 * H, 0];
    if (bone.id === 'leftLowerArm') return [-((0.245 * H) / 2) - 0.16 * H, 0.84 * H, 0];
    if (bone.id === 'rightLowerArm') return [(0.245 * H) / 2 + 0.16 * H, 0.84 * H, 0];
    if (bone.id === 'leftHand') return [-((0.245 * H) / 2) - 0.32 * H, 0.84 * H, 0];
    if (bone.id === 'rightHand') return [(0.245 * H) / 2 + 0.32 * H, 0.84 * H, 0];
    return [bone.canonical[0] * H, bone.canonical[1] * H, bone.canonical[2] * H];
  });
  for (const [i, bone] of BONES.entries()) {
    if (bone.parent === null) {
      assert.deepEqual(json.nodes[i].translation.map(roundish), global[i].map(roundish), `root ${bone.id} at its global position`);
      continue;
    }
    const p = childOf.get(i);
    const expected = [global[i][0] - global[p][0], global[i][1] - global[p][1], global[i][2] - global[p][2]];
    assert.deepEqual(
      json.nodes[i].translation.map(roundish),
      expected.map(roundish),
      `${bone.parent} → ${bone.id} local translation = global delta`,
    );
  }
});

function roundish(n) {
  return Math.round(n * 1e4) / 1e4;
}

test('skin: one shared skeleton — joints = 19 bones, IBM count matches, skeleton = hips', () => {
  const result = runExportPipeline(makeHtir(), makeInput());
  const { json } = parseGlb(result.bytes);
  assert.equal(json.skins.length, 1);
  const skin = json.skins[0];
  assert.equal(skin.name, 'you-generic-v1');
  assert.equal(skin.joints.length, 19);
  assert.deepEqual(skin.joints, [...Array(19).keys()], 'joints are the 19 bone node indices');
  assert.equal(skin.skeleton, 0, 'the skeleton root is hips');
  const ibm = json.accessors[skin.inverseBindMatrices];
  assert.equal(ibm.count, 19);
  assert.equal(ibm.type, 'MAT4');
  // every LOD mesh node references the shared skin and a valid mesh
  for (const nodeIdx of json.scenes[0].nodes.slice(1)) {
    const node = json.nodes[nodeIdx];
    assert.equal(node.skin, 0);
    assert.ok(Number.isInteger(node.mesh) && node.mesh >= 0 && node.mesh < json.meshes.length);
  }
  // scene reachability: hips + the 3 LOD nodes
  assert.deepEqual(json.scenes[0].nodes, [0, 19, 20, 21]);
});

test('hierarchy: skinning is rigid and honest — WEIGHTS_0 sum to 1, joints in range', () => {
  const result = runExportPipeline(makeHtir(), makeInput());
  const { json, bin } = parseGlb(result.bytes);
  const prim = json.meshes[1].primitives[0];
  const wAcc = json.accessors[prim.attributes.WEIGHTS_0];
  const wView = json.bufferViews[wAcc.bufferView];
  const wSlice = bin.slice(wView.byteOffset, wView.byteOffset + wView.byteLength);
  const w = new Float32Array(wSlice.buffer, wSlice.byteOffset, wSlice.byteLength / 4);
  const jAcc = json.accessors[prim.attributes.JOINTS_0];
  const jView = json.bufferViews[jAcc.bufferView];
  const jSlice = bin.slice(jView.byteOffset, jView.byteOffset + jView.byteLength);
  const j = new Uint8Array(jSlice.buffer, jSlice.byteOffset, jSlice.byteLength);
  for (let v = 0; v < 24; v += 1) {
    assert.ok(Math.abs(w[v * 4] + w[v * 4 + 1] + w[v * 4 + 2] + w[v * 4 + 3] - 1) < 1e-6, `vertex ${v} weights sum to 1`);
    assert.ok(j[v * 4] >= 0 && j[v * 4] < 19, `vertex ${v} joint index in range`);
  }
});

// ─── 3. VRM extension + placeholder honesty ─────────────────────────────────

test('vrm: the extension is present ONLY on the vrm format; glb stays pure glTF 2.0', () => {
  const vrm = runExportPipeline(makeHtir(), makeInput({ format: 'vrm' }));
  const { json: vrmJson } = parseGlb(vrm.bytes, 'vrm');
  assert.deepEqual(vrmJson.extensionsUsed, ['VRM']);
  assert.equal(vrmJson.extensions.VRM.specVersion, '0.0');
  assert.match(vrmJson.extensions.VRM.exporterVersion, /you-glb-1/);
  assert.equal(vrmJson.extensions.VRM.humanoid.humanoid.length, 19);
  assert.ok(Array.isArray(vrmJson.extensions.VRM.blendShapeMaster.blendShapeGroups));
  assert.ok(vrmJson.extensions.VRM.firstPerson.firstPersonBone >= 0);

  const glb = runExportPipeline(makeHtir(), makeInput({ format: 'glb' }));
  const { json: glbJson } = parseGlb(glb.bytes, 'glb');
  assert.equal(glbJson.extensionsUsed, undefined, 'the glb format carries no VRM extension');
  assert.equal(glbJson.extensions, undefined);
});

test('vrm: humanoid bone map covers all 19 bones with valid node indices', () => {
  const vrm = runExportPipeline(makeHtir(), makeInput({ format: 'vrm' }));
  const { json } = parseGlb(vrm.bytes, 'vrm');
  const map = vrm ? json.extensions.VRM.humanoid.humanoid : null;
  assert.equal(map.length, 19);
  for (const entry of map) {
    assert.ok(BONES.some((b) => b.id === entry.bone), `bone ${entry.bone} is a you-generic-v1 bone`);
    const nodeIdx = entry.node;
    assert.ok(Number.isInteger(nodeIdx) && nodeIdx >= 0 && nodeIdx < json.nodes.length, `bone ${entry.bone} maps to a valid node`);
    assert.equal(json.nodes[nodeIdx].name, entry.bone, `bone ${entry.bone} maps to its own node`);
  }
  // the map is the identity over the canonical order
  assert.deepEqual(map.map((e) => e.node), [...Array(19).keys()]);
});

test('vrm: blendshape groups ONLY for the HTIR articulation set; presets exact only where honest', () => {
  const htir = makeHtir();
  const vrm = runExportPipeline(htir, makeInput({ format: 'vrm' }));
  const { json } = parseGlb(vrm.bytes, 'vrm');
  const groups = json.extensions.VRM.blendShapeMaster.blendShapeGroups;
  assert.deepEqual(groups.map((g) => g.name), htir.articulation.blendshapes, 'groups are exactly the HTIR set, no inventions');
  const byName = new Map(groups.map((g) => [g.name, g]));
  assert.equal(byName.get('neutral').presetName, 'Neutral', 'neutral → exact VRM preset');
  assert.equal(byName.get('blink').presetName, 'Blink', 'blink → exact VRM preset');
  assert.equal(byName.get('smile').presetName, 'Unknown', 'smile has no exact preset — custom group, honest');
  assert.equal(byName.get('brow-raise').presetName, 'Unknown', 'brow-raise has no exact preset — custom group, honest');
  // binds point at valid mesh + morph target indices on the primary LOD mesh
  const primaryMesh = makeInput({ format: 'vrm' }).lodLevel;
  for (const group of groups) {
    assert.equal(group.binds.length, 1);
    const bind = group.binds[0];
    assert.equal(bind.mesh, primaryMesh, 'binds reference the requested LOD mesh');
    const mesh = json.meshes[bind.mesh];
    const headPrim = mesh.primitives.find((p) => Array.isArray(p.targets));
    assert.ok(headPrim, 'the head primitive carries the targets');
    assert.ok(bind.index >= 0 && bind.index < headPrim.targets.length, 'bind index is a real target');
  }
  // targetNames carry the HTIR names verbatim
  const mesh = json.meshes[0];
  assert.deepEqual(mesh.extras.targetNames, htir.articulation.blendshapes);
});

test('vrm: morph target deltas are ALL ZERO — placeholder honesty, no fabricated deltas', () => {
  const vrm = runExportPipeline(makeHtir(), makeInput({ format: 'vrm' }));
  const { json, bin } = parseGlb(vrm.bytes, 'vrm');
  const mesh = json.meshes[0];
  const headPrim = mesh.primitives.find((p) => Array.isArray(p.targets));
  assert.ok(headPrim, 'the head primitive carries morph targets');
  assert.equal(headPrim.targets.length, 4, 'one target per HTIR blendshape');
  for (const [t, target] of headPrim.targets.entries()) {
    const acc = json.accessors[target.POSITION];
    assert.equal(acc.count, 24, 'target POSITION matches the head vertex count');
    const view = json.bufferViews[acc.bufferView];
    const bytes = bin.slice(view.byteOffset, view.byteOffset + view.byteLength);
    for (let i = 0; i < bytes.length; i += 1) {
      assert.equal(bytes[i], 0, `target ${t}: all deltas zero (placeholder, not fabricated animation)`);
    }
    assert.deepEqual(acc.min, [0, 0, 0]);
    assert.deepEqual(acc.max, [0, 0, 0]);
  }
});

test('facial controls: includeFacialControls=false emits NO targets and records the omission', () => {
  const result = runExportPipeline(makeHtir(), makeInput({ includeFacialControls: false }));
  const { json } = parseGlb(result.bytes);
  for (const mesh of json.meshes) {
    assert.ok(mesh.primitives.every((p) => p.targets === undefined), 'no morph targets anywhere');
    assert.equal(mesh.extras, undefined, 'no targetNames either');
  }
  assert.equal(result.manifest.facialControls.included, false);
  assert.match(result.manifest.facialControls.note, /omitted by export option/);
  assert.equal(result.mappingTable.facialControls.included, false);
  assert.equal(result.mappingTable.blendshapes.every((b) => b.emitted === false), true);
});

// ─── 4. LOD honesty (counts from the REAL emitter output) ───────────────────

test('lods: three levels, strictly decimating, counts MATCH a recount from the emitted GLB', () => {
  const result = runExportPipeline(makeHtir(), makeInput());
  const { json } = parseGlb(result.bytes);
  assert.equal(result.manifest.lods.length, 3);
  const seen = [];
  for (const lod of result.manifest.lods) {
    assert.ok(EXPORT_LOD_LEVELS.includes(lod.level));
    assert.ok(lod.triangles > 0 && lod.primitives > 0 && lod.vertices > 0);
    // recount from the ACTUAL emitted glTF: triangles = Σ indices.count/3
    const mesh = json.meshes.find((m) => m.name === `LOD${lod.level}`);
    assert.ok(mesh, `LOD${lod.level} mesh exists in the GLB`);
    const triangles = mesh.primitives.reduce((s, p) => s + json.accessors[p.indices].count / 3, 0);
    assert.equal(triangles, lod.triangles, `LOD${lod.level}: manifest triangles == recounted (${triangles})`);
    assert.equal(mesh.primitives.length, lod.primitives, `LOD${lod.level}: manifest primitives == emitted`);
    const vertices = mesh.primitives.reduce((s, p) => s + json.accessors[p.attributes.POSITION].count, 0);
    assert.equal(vertices, lod.vertices, `LOD${lod.level}: manifest vertices == emitted`);
    seen.push(lod.triangles);
  }
  assert.ok(seen[0] > seen[1] && seen[1] > seen[2], `triangle counts strictly decrease: ${seen.join(' > ')}`);
  // LOD2 records the honest extremity omission
  const lod2 = result.manifest.lods.find((l) => l.level === 2);
  assert.match(lod2.note, /hands and feet are OMITTED/i);
});

// ─── 5. Determinism ─────────────────────────────────────────────────────────

test('determinism: identical HTIR + options → byte-identical GLB (sha256-stable)', () => {
  const htir = makeHtir();
  const a = runExportPipeline(htir, makeInput({ format: 'vrm', lodLevel: 0 }));
  const b = runExportPipeline(makeHtir(), makeInput({ format: 'vrm', lodLevel: 0 }));
  const sha = (x) => createHash('sha256').update(x).digest('hex');
  assert.equal(sha(a.bytes), sha(b.bytes), 'fresh equal fixtures hash identically');
  assert.equal(Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes)), 0, 'byte-identical');
  // different options → different bytes
  const c = runExportPipeline(htir, makeInput({ format: 'vrm', lodLevel: 1 }));
  assert.notEqual(sha(a.bytes), sha(c.bytes), 'a different requested LOD changes the emitted primary scene');
  // different HTIR (a real measurement) → different bytes
  const wider = makeHtir();
  wider.geometry.measurements.shoulderRatio = 0.26;
  const d = runExportPipeline(wider, makeInput({ format: 'vrm', lodLevel: 0 }));
  assert.notEqual(sha(a.bytes), sha(d.bytes), 'a different shoulderRatio changes the emitted geometry');
  // determinism statement is part of the manifest contract
  assert.match(a.manifest.determinism, /byte-identical/);
});

// ─── 6. Fail-closed negatives ───────────────────────────────────────────────

test('fail-closed: unknown format → typed validation refusal, never a guess', () => {
  for (const format of ['fbx', 'obj', 'unitypackage', '', null, 42, undefined]) {
    const r = refusalOf(() => validateExportInput({ twinId: 't', twinVersionId: 'v', format }));
    assert.equal(r.code, 'validation_failed');
    assert.match(r.message, /format must be one of: glb, vrm/);
    assert.match(r.message, /refusing to guess/);
  }
  // case/whitespace normalization is deliberate (format names are lowercase conventions)
  assert.equal(validateExportInput({ twinId: 't', twinVersionId: 'v', format: ' GLB ' }).format, 'glb');
  assert.equal(validateExportInput({ twinId: 't', twinVersionId: 'v', format: 'Vrm' }).format, 'vrm');
});

test('fail-closed: bad lodLevel → typed validation refusal', () => {
  for (const lodLevel of [3, -1, 1.5, '1']) {
    const r = refusalOf(() => validateExportInput({ twinId: 't', twinVersionId: 'v', format: 'glb', lodLevel }));
    assert.equal(r.code, 'validation_failed');
    assert.match(r.message, /lodLevel must be one of: 0, 1, 2/);
  }
  // format is REQUIRED (fail-closed: an omitted format never guesses)
  assert.equal(refusalOf(() => validateExportInput({ twinId: 't', twinVersionId: 'v' })).code, 'validation_failed');
  // absent lodLevel → 0; null is treated as absent (the style-default law)
  assert.equal(validateExportInput({ twinId: 't', twinVersionId: 'v', format: 'glb' }).lodLevel, 0, 'default 0');
  assert.equal(validateExportInput({ twinId: 't', twinVersionId: 'v', format: 'glb', lodLevel: null }).lodLevel, 0);
  assert.equal(validateExportInput({ twinId: ' t ', twinVersionId: ' v ', format: 'glb' }).twinId, 't');
  const r = refusalOf(() => validateExportInput({ twinId: 't', twinVersionId: '', format: 'glb' }));
  assert.match(r.message, /twinId and twinVersionId are required/);
});

test('fail-closed: a TwinVersion without usable geometry → honest geometry_unavailable, never a default body', async () => {
  const cases = [
    [null, 'no parseable HTIR'],
    [42, 'not an object'],
    [{}, 'no geometry field'],
    [{ geometry: { skeleton: 'mixamo-v9', measurements: { shoulderRatio: 0.24 } } }, 'unknown skeleton convention'],
    [{ geometry: { skeleton: 'you-generic-v1', measurements: {} } }, 'no finite measurements'],
    [{ geometry: { skeleton: 'you-generic-v1', measurements: { shoulderRatio: Number.NaN } } }, 'NaN measurement dropped → none left'],
  ];
  for (const [htir, label] of cases) {
    const err = await rejectsRefusal(() => runExportPipeline(htir, makeInput()));
    assert.equal(err.code, 'geometry_unavailable', `${label} → geometry_unavailable`);
    assert.match(err.message, /refusing/i, `${label}: the refusal states the honest reason`);
  }
  // the gate is testable standalone too
  const gate = checkGeometryUsable(parseHtirForExport({ geometry: { skeleton: 'unknown-v1', measurements: { shoulderRatio: 0.2 } } }));
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /implements only "you-generic-v1"/);
  const good = checkGeometryUsable(parseHtirForExport(makeHtir()));
  assert.equal(good.ok, true);
});

// ─── 7. The manifest structural-vs-derived split (THE CONTRACT) ─────────────

test('manifest: structural entries carry the HTIR values verbatim', () => {
  const htir = makeHtir();
  const result = runExportPipeline(htir, makeInput());
  const m = result.manifest;
  assert.ok(m.structural.length >= 5, 'a substantive structural half');
  const fields = new Map(m.structural.map((e) => [e.field, e]));
  assert.equal(fields.get('geometry.skeleton').value, 'you-generic-v1');
  assert.equal(fields.get('geometry.measurements.shoulderRatio').value, 0.245);
  assert.equal(fields.get('geometry.measurements.headRatio').value, 0.128);
  assert.equal(fields.get('morphology.heightEstimateCm').value, 178);
  assert.equal(fields.get('appearance.palette.skin').value, '#c8956c');
  assert.deepEqual(fields.get('articulation.blendshapes').value, htir.articulation.blendshapes);
  assert.equal(fields.get('confidence.byDomain.geometry').value, 0.62);
  for (const entry of m.structural) assert.match(entry.basis, /HTIR TwinVersion verbatim/);
});

test('manifest: derived entries carry their bases — the honest split', () => {
  const result = runExportPipeline(makeHtir(), makeInput());
  const m = result.manifest;
  assert.ok(m.derived.length >= 6, 'a substantive derived half');
  const fields = new Map(m.derived.map((e) => [e.field, e]));
  const mesh = fields.get('mesh.segmentGeometry');
  assert.match(mesh.basis, /NOT scanned surface geometry/);
  const height = fields.get('mesh.absoluteHeight');
  assert.equal(height.value, 1.78, 'the structural height flows through (178cm)');
  assert.match(height.basis, /HTIR heightEstimateCm converted/);
  const thickness = fields.get('mesh.segmentThickness');
  assert.match(thickness.basis, /build descriptor "athletic"/);
  const deltas = fields.get('facialControls.morphTargetDeltas');
  assert.match(deltas.basis, /no per-vertex blendshape deltas exist/);
  assert.match(fields.get('mesh.canonicalProportions').basis, /platform defaults/);
});

test('manifest: defaults are honestly tagged when the HTIR omits them', () => {
  const bare = makeHtir();
  delete bare.morphology.heightEstimateCm;
  bare.geometry.measurements = { shoulderRatio: 0.24 }; // headRatio omitted
  const result = runExportPipeline(bare, makeInput());
  const fields = new Map(result.manifest.derived.map((e) => [e.field, e]));
  assert.match(fields.get('mesh.absoluteHeight').basis, /canonical 1\.7m default/, 'no height → the canonical default, stated');
  assert.match(fields.get('mesh.headLength').basis, /canonical 0\.13 ratio default/, 'no headRatio → stated default');
  assert.equal(result.manifest.structural.some((e) => e.field === 'morphology.heightEstimateCm'), false);
});

test('manifest: the claims statement is contract — tampering refuses at assertExportSuccess', () => {
  const result = runExportPipeline(makeHtir(), makeInput());
  assert.ok(claimsAreIntact(result.manifest.claims));
  assert.match(EXPORT_CLAIMS, /NOT a photorealistic scan/);
  assert.match(EXPORT_CLAIMS, /structural from the HTIR versus derived\/estimated/);
  // tampered claims
  const tampered = refusalOf(() =>
    assertExportSuccess({ ...result, manifest: { ...result.manifest, claims: 'looks great!' } }),
  );
  assert.equal(tampered.code, 'validation_failed');
  assert.match(tampered.message, /claims statement/);
  // empty halves
  const noStructural = refusalOf(() =>
    assertExportSuccess({ ...result, manifest: { ...result.manifest, structural: [] } }),
  );
  assert.match(noStructural.message, /structural-vs-derived split/);
  const noDerived = refusalOf(() =>
    assertExportSuccess({ ...result, manifest: { ...result.manifest, derived: [] } }),
  );
  assert.match(noDerived.message, /structural-vs-derived split/);
  // non-decimating LODs
  const flat = refusalOf(() =>
    assertExportSuccess({
      ...result,
      manifest: {
        ...result.manifest,
        lods: result.manifest.lods.map((l) => ({ ...l, triangles: 100 })),
      },
    }),
  );
  assert.match(flat.message, /does not decimate/);
});

// ─── 8. Mapping table + package manifest (engine surface) ───────────────────

test('mapping table: bones carry VRM + Unity + Unreal names; all 19 mapped', () => {
  const result = runExportPipeline(makeHtir(), makeInput());
  const t = result.mappingTable;
  assert.equal(t.bones.length, 19);
  assert.equal(t.skeleton, 'you-generic-v1');
  const byBone = new Map(t.bones.map((b) => [b.youBone, b]));
  assert.equal(byBone.get('hips').unityMecanim, 'Hips');
  assert.equal(byBone.get('hips').unrealMannequin, 'pelvis');
  assert.equal(byBone.get('leftUpperArm').unityMecanim, 'LeftUpperArm');
  assert.equal(byBone.get('leftUpperArm').unrealMannequin, 'upperarm_l');
  assert.equal(byBone.get('rightFoot').unrealMannequin, 'foot_r');
  for (const b of t.bones) {
    assert.equal(b.mapped, true);
    assert.match(b.source, /structural/);
    assert.ok(b.vrmHumanoidBone && b.unityMecanim && b.unrealMannequin);
    assert.ok(Number.isInteger(b.gltfNode) && b.gltfNode >= 0);
  }
  // the chest carries the honest partial-split note for UE5
  assert.match(byBone.get('chest').note, /spine_02\/spine_03/);
});

test('mapping table: ARKit mapping where it maps, explicit unmapped where it does not', () => {
  const mappings = mapBlendshapes(['neutral', 'smile', 'brow-raise', 'blink', 'custom-flex']);
  const byName = new Map(mappings.map((m) => [m.htirName, m]));
  assert.deepEqual(byName.get('blink').arkitNames, ['eyeBlinkLeft', 'eyeBlinkRight']);
  assert.equal(byName.get('blink').mapped, true);
  assert.deepEqual(byName.get('smile').arkitNames, ['mouthSmileLeft', 'mouthSmileRight']);
  assert.match(byName.get('smile').note, /partial/);
  assert.deepEqual(byName.get('brow-raise').arkitNames, ['browInnerUp', 'browOuterLeft', 'browOuterRight']);
  assert.equal(byName.get('neutral').mapped, true);
  assert.match(byName.get('neutral').note, /rest pose/);
  // unknown names are honest unmapped entries — never a guess
  const unknown = byName.get('custom-flex');
  assert.equal(unknown.mapped, false);
  assert.deepEqual(unknown.arkitNames, []);
  assert.match(unknown.note, /unmapped: no ARKit or VRM correspondence/);
  // the pipeline mapping table only lists the HTIR set
  const result = runExportPipeline(makeHtir(), makeInput());
  assert.deepEqual(result.mappingTable.blendshapes.map((b) => b.htirName), ['neutral', 'smile', 'brow-raise', 'blink']);
});

test('package manifest: honest Unity/Unreal surface — what IS and is NOT included', () => {
  const files = [
    { role: 'model', artifactId: 'a1', storageKey: 'export/h1.glb', contentHash: 'h1', bytes: 1000, mime: 'model/gltf-binary' },
    { role: 'retargeting-mapping', artifactId: 'a2', storageKey: 'export/h2.json', contentHash: 'h2', bytes: 2000, mime: 'application/json' },
    { role: 'export-manifest', artifactId: 'a3', storageKey: 'export/h3.json', contentHash: 'h3', bytes: 500, mime: 'application/json' },
  ];
  const pkg = buildPackageManifest({ format: 'glb', files });
  assert.equal(pkg.packageVersion, '1');
  assert.equal(pkg.files.length, 3);
  assert.deepEqual(pkg.files.map((f) => f.role), ['model', 'retargeting-mapping', 'export-manifest']);
  assert.ok(pkg.engineIntegration.unity.notProvided.includes('a Unity prefab or scene'));
  assert.ok(pkg.engineIntegration.unreal.notProvided.includes('an Unreal plugin or module'));
  assert.match(pkg.readme, /This package contains exactly three files/);
  assert.match(pkg.readme, /is NOT included/);
  assert.match(pkg.readme, /any Unity prefab/i);
  assert.match(pkg.readme, /zero-delta placeholders/);
  assert.ok(pkg.readme.includes(EXPORT_CLAIMS), 'the README carries the verbatim claims statement');
  // the VRM variant documents the container/rename fact honestly
  const vrmPkg = buildPackageManifest({ format: 'vrm', files });
  assert.match(vrmPkg.readme, /rename the file extension to \.vrm/);
});

// ─── 9. API surface (pure route folds — the routes' exact decision law) ─────

const NOW = new Date('2026-10-04T00:00:00Z');
const TENANT = 'tenant_a';

function makeGrant(overrides = {}) {
  return {
    id: 'grant_1',
    scopes: ['reconstruct'],
    revokedAt: null,
    expiresAt: new Date('2026-10-05T00:00:00Z'),
    ...overrides,
  };
}

const TWIN_A = { id: 'twin_1', tenantId: TENANT, subjectId: 'subject_1' };
const VERSION_A = { id: 'v_1', twinId: 'twin_1' };

function makeCreateArgs(overrides = {}) {
  return {
    body: { twinId: 'twin_1', twinVersionId: 'v_1', format: 'glb', lodLevel: 1, includeFacialControls: true },
    twin: TWIN_A,
    twinVersion: VERSION_A,
    tenantId: TENANT,
    idempotencyKey: undefined,
    existingJob: null,
    activeGrants: [makeGrant()],
    now: NOW,
    ...overrides,
  };
}

test('api fold: validation errors → 400 envelope spec', () => {
  const bad = decideCreateExport(makeCreateArgs({ body: { twinId: 'twin_1', twinVersionId: 'v_1', format: 'fbx' } }));
  assert.equal(bad.kind, 'error');
  assert.equal(bad.status, 400);
  assert.equal(bad.code, 'validation_failed');
  const missing = decideCreateExport(makeCreateArgs({ body: {} }));
  assert.equal(missing.status, 400);
  assert.match(missing.message, /twinId and twinVersionId are required/);
});

test('api fold: twin/version scoping → honest 404s (tenant isolation on create)', () => {
  const noTwin = decideCreateExport(makeCreateArgs({ twin: null }));
  assert.equal(noTwin.kind, 'error');
  assert.equal(noTwin.status, 404);
  assert.match(noTwin.message, /twin "twin_1" not found/);
  const otherTenantTwin = decideCreateExport(makeCreateArgs({ twin: { ...TWIN_A, tenantId: 'tenant_b' } }));
  assert.equal(otherTenantTwin.status, 404, "another tenant's twin is honestly not_found");
  const noVersion = decideCreateExport(makeCreateArgs({ twinVersion: null }));
  assert.equal(noVersion.status, 404);
  assert.match(noVersion.message, /twin version "v_1" not found/);
  const wrongTwinVersion = decideCreateExport(makeCreateArgs({ twinVersion: { id: 'v_1', twinId: 'twin_other' } }));
  assert.equal(wrongTwinVersion.status, 404);
});

test('api fold: consent is server-enforced — reconstruct scope, 403 otherwise', () => {
  const none = decideCreateExport(makeCreateArgs({ activeGrants: [] }));
  assert.equal(none.kind, 'error');
  assert.equal(none.status, 403);
  assert.equal(none.code, 'consent_required');
  assert.match(none.message, /scope "reconstruct"/);
  // render-only scope does NOT cover an export (the reconstruct law)
  const renderOnly = decideCreateExport(makeCreateArgs({ activeGrants: [makeGrant({ scopes: ['render'] })] }));
  assert.equal(renderOnly.status, 403);
  // revoked / expired grants do not cover
  const revoked = decideCreateExport(makeCreateArgs({ activeGrants: [makeGrant({ revokedAt: new Date('2026-10-01T00:00:00Z') })] }));
  assert.equal(revoked.status, 403);
  const expired = decideCreateExport(makeCreateArgs({ activeGrants: [makeGrant({ expiresAt: new Date('2026-10-03T00:00:00Z') })] }));
  assert.equal(expired.status, 403);
  // a covering grant proceeds with its id
  const ok = decideCreateExport(makeCreateArgs());
  assert.equal(ok.kind, 'proceed');
  assert.equal(ok.consentGrantId, 'grant_1');
  assert.deepEqual(ok.input.format, 'glb');
});

test('api fold: idempotent replay returns the ORIGINAL ids — never a second row', () => {
  const existing = { id: 'job_99', kind: 'export.glb', input: { exportJobId: 'export_99' } };
  const replay = decideCreateExport(
    makeCreateArgs({ idempotencyKey: 'key-1', existingJob: existing }),
  );
  assert.equal(replay.kind, 'replay');
  assert.equal(replay.jobId, 'job_99');
  assert.equal(replay.exportJobId, 'export_99');
  // a same-key job of a DIFFERENT kind does not replay (it is not this export)
  const vrmExisting = { id: 'job_99', kind: 'export.vrm', input: { exportJobId: 'export_99' } };
  const proceed = decideCreateExport(
    makeCreateArgs({ idempotencyKey: 'key-1', existingJob: vrmExisting, body: { twinId: 'twin_1', twinVersionId: 'v_1', format: 'glb' } }),
  );
  assert.equal(proceed.kind, 'proceed', 'the kind must match the requested format');
  // an existing job whose input lost the exportJobId does not fabricate one
  const orphan = { id: 'job_99', kind: 'export.glb', input: {} };
  const proceed2 = decideCreateExport(makeCreateArgs({ idempotencyKey: 'key-1', existingJob: orphan }));
  assert.equal(proceed2.kind, 'proceed');
});

test('api fold: GET tenant isolation — another tenant\'s export is honestly not_found', () => {
  const rows = [
    { id: 'export_a', tenantId: 'tenant_a' },
    { id: 'export_b', tenantId: 'tenant_b' },
  ];
  const asA = decideGetExport(rows[0], 'export_a', 'tenant_a');
  assert.equal(asA.status, 200);
  assert.equal(asA.row.id, 'export_a');
  const cross = decideGetExport(rows[1], 'export_b', 'tenant_a');
  assert.equal(cross.status, 404, 'no row leaks across tenants');
  assert.equal(cross.code, 'not_found');
  const unknown = decideGetExport(null, 'export_zz', 'tenant_a');
  assert.equal(unknown.status, 404);
});

test('http taxonomy: refusal codes map to their envelope specs; unknown errors map to null', () => {
  assert.deepEqual(exportHttpSpec(new ExportRefusal('validation_failed', 'msg-1')), {
    status: 400,
    code: 'validation_failed',
    message: 'msg-1',
    details: undefined,
  });
  assert.equal(exportHttpSpec(new ExportRefusal('geometry_unavailable', 'msg-2')).status, 422);
  assert.equal(exportHttpSpec(new Error('plain')), null);
  assert.equal(exportHttpSpec(null), null);
  assert.equal(exportJobKindFor('glb'), EXPORT_GLB_JOB_KIND);
  assert.equal(exportJobKindFor('vrm'), EXPORT_VRM_JOB_KIND);
  assert.throws(() => exportJobKindFor('fbx'), /unknown export format/);
});

// ─── adapter descriptor sanity (the catalog-facing identity) ────────────────

test('adapter descriptor: provider-neutral LOCAL deterministic emitter, honest claims note', () => {
  assert.equal(GAME_EXPORT_ADAPTER.adapterId, 'game-export-1');
  assert.equal(GAME_EXPORT_ADAPTER.providerNeutral, true);
  assert.equal(GAME_EXPORT_ADAPTER.localEmitter, true);
  assert.equal(GAME_EXPORT_ADAPTER.deterministic, true);
  assert.match(GAME_EXPORT_ADAPTER.claimsNote, /NOT a photorealistic scan/);
  assert.match(GAME_EXPORT_ADAPTER.claimsNote, /structural-vs-derived split/);
});
