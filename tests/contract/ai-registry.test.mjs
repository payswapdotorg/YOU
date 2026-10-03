// ═══════════════════════════════════════════════════════════════════════════
// YOU AI provider/model registry tests (P6.C5) — node:test, PURE UNIT.
//
// Imports the registry module directly (node >= 23.6 strips the erasable
// type syntax; the module is deliberately dependency-free so no provider
// SDK, network, or real key is ever touched). All provider credentials in
// this file are obvious placeholders.
//
// Covered:
//   - resolution precedence (YOU_AI_PROVIDERS pin > YOU_AI_VISION_MODEL >
//     legacy YOU_RECON_MODEL > registry healthy default);
//   - capability matching (text-only and disabled models never resolve for
//     vision);
//   - fail-closed paths (unknown provider; missing OPENROUTER_API_KEY at
//     resolution time; nothing left to fall through to);
//   - malformed config tolerance (documented skip reasons, boot-safe);
//   - registry immutability after boot (deep-frozen, no mutation API,
//     resolution stable after mutation attempts);
//   - warning logging (once per reason, [you:ai-registry] prefix).
//
// Part of the aggregated station gate (imported statically by tests/index.mjs).
// Env vars touched here are snapshotted and restored around every test so
// sibling suites in the same process are unaffected.
// ═══════════════════════════════════════════════════════════════════════════
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_REGISTRY,
  PROVIDER_METADATA,
  RegistryResolutionError,
  listModels,
  normalizeProvider,
  parseProviderOverrides,
  resolveModel,
} from '../../apps/web/src/lib/you/ai/registry.ts';

const PLACEHOLDER_KEY = 'test-placeholder-key-never-real';

const TOUCHED = [
  'YOU_AI_PROVIDERS',
  'YOU_AI_VISION_MODEL',
  'YOU_RECON_MODEL',
  'YOU_RECON_PROVIDER',
  'OPENROUTER_API_KEY',
];
let savedEnv;

function setEnv(vars) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  savedEnv = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  // deterministic baseline for every test: no AI knobs, placeholder key
  setEnv({
    YOU_AI_PROVIDERS: undefined,
    YOU_AI_VISION_MODEL: undefined,
    YOU_RECON_MODEL: undefined,
    YOU_RECON_PROVIDER: undefined,
    OPENROUTER_API_KEY: PLACEHOLDER_KEY,
  });
});

afterEach(() => {
  setEnv(savedEnv);
  savedEnv = undefined;
});

// ─── healthy defaults ────────────────────────────────────────────────────────

test('registry: healthy defaults resolve per provider with no env knobs', () => {
  const zai = resolveModel('vision', { provider: 'zai' });
  assert.equal(zai.provider, 'zai');
  assert.equal(zai.modelId, 'glm-5v-turbo');
  assert.equal(zai.source, 'registry-default');
  assert.equal(zai.entry?.modelId, 'glm-5v-turbo');

  const or = resolveModel('vision', { provider: 'openrouter' });
  assert.equal(or.provider, 'openrouter');
  assert.equal(or.modelId, 'google/gemini-2.5-flash');
  assert.equal(or.source, 'registry-default');
  assert.ok(or.entry?.capabilities.vision, 'the default is vision-capable');
});

test('registry: "local" is the C1 alias for zai at the resolution seam', () => {
  assert.equal(normalizeProvider('local'), 'zai');
  assert.deepEqual(PROVIDER_METADATA.zai.aliases, ['local']);
  const viaAlias = resolveModel('vision', { provider: 'local' });
  assert.equal(viaAlias.provider, 'zai');
  assert.equal(viaAlias.modelId, 'glm-5v-turbo');
  // alias pins inside YOU_AI_PROVIDERS normalize to the same provider id
  setEnv({ YOU_AI_PROVIDERS: 'local:glm-5v-turbo' });
  assert.equal(resolveModel('vision', { provider: 'zai' }).source, 'provider-override');
});

// ─── resolution precedence ───────────────────────────────────────────────────

test('registry: precedence 1 — YOU_AI_PROVIDERS pin beats YOU_AI_VISION_MODEL', () => {
  setEnv({
    YOU_AI_PROVIDERS: 'openrouter:openai/gpt-4o-mini',
    YOU_AI_VISION_MODEL: 'google/gemini-2.5-pro',
    YOU_RECON_MODEL: 'legacy/should-not-win',
  });
  const r = resolveModel('vision', { provider: 'openrouter' });
  assert.equal(r.modelId, 'openai/gpt-4o-mini');
  assert.equal(r.source, 'provider-override');
  assert.equal(r.entry?.modelId, 'openai/gpt-4o-mini');
});

test('registry: precedence 2 — YOU_AI_VISION_MODEL beats the legacy knob and the default', () => {
  setEnv({
    YOU_AI_VISION_MODEL: 'google/gemini-2.5-pro',
    YOU_RECON_MODEL: 'legacy/should-not-win',
  });
  const r = resolveModel('vision', { provider: 'openrouter' });
  assert.equal(r.modelId, 'google/gemini-2.5-pro');
  assert.equal(r.source, 'capability-override');
});

test('registry: precedence 3 — legacy YOU_RECON_MODEL passthrough (C1 contract, entry is null)', () => {
  setEnv({ YOU_RECON_MODEL: 'test/vision-good' });
  const r = resolveModel('vision', { provider: 'openrouter' });
  assert.equal(r.modelId, 'test/vision-good');
  assert.equal(r.source, 'legacy-env');
  assert.equal(r.entry, null, 'legacy passthrough is not a registry entry');
  // the legacy knob is openrouter-only by C1 design — zai ignores it
  const zai = resolveModel('vision', { provider: 'zai' });
  assert.equal(zai.modelId, 'glm-5v-turbo');
  assert.equal(zai.source, 'registry-default');
});

// ─── capability matching ─────────────────────────────────────────────────────

test('registry: a vision resolution never returns a text-only model', () => {
  setEnv({ YOU_AI_VISION_MODEL: 'meta-llama/llama-3.3-70b-instruct' }); // vision: false
  const r = resolveModel('vision', { provider: 'openrouter' });
  assert.equal(r.modelId, 'google/gemini-2.5-flash', 'falls through to the healthy default');
  assert.equal(r.source, 'registry-default');
  for (const entry of MODEL_REGISTRY) {
    if (!entry.capabilities.vision) {
      assert.ok(!entry.defaultFor.includes('vision'), 'text-only models are never vision defaults');
    }
  }
});

test('registry: a disabled model is never resolved, even when pinned', () => {
  const disabled = MODEL_REGISTRY.find((e) => !e.enabled);
  assert.ok(disabled, 'the registry carries at least one honestly-disabled entry');
  setEnv({ YOU_AI_PROVIDERS: `openrouter:${disabled.modelId}` });
  const r = resolveModel('vision', { provider: 'openrouter' });
  assert.equal(r.source, 'registry-default', 'the disabled pin is skipped');
  assert.equal(r.modelId, 'google/gemini-2.5-flash');
});

test('registry: a vision model of the OTHER provider is skipped for this provider', () => {
  setEnv({ YOU_AI_VISION_MODEL: 'glm-5v-turbo' }); // zai model, resolving for openrouter
  const r = resolveModel('vision', { provider: 'openrouter' });
  assert.equal(r.modelId, 'google/gemini-2.5-flash');
  assert.equal(r.source, 'registry-default');
});

// ─── fail-closed paths ───────────────────────────────────────────────────────

test('registry: unknown provider fails closed (never guesses)', () => {
  assert.throws(
    () => resolveModel('vision', { provider: 'azure' }),
    (e) => e instanceof RegistryResolutionError && /unknown AI provider "azure"/.test(e.message),
  );
  assert.throws(() => normalizeProvider(''), RegistryResolutionError);
});

test('registry: openrouter without OPENROUTER_API_KEY fails closed AT RESOLUTION TIME', () => {
  setEnv({ OPENROUTER_API_KEY: undefined, YOU_RECON_MODEL: 'test/vision-good' });
  assert.throws(
    () => resolveModel('vision', { provider: 'openrouter' }),
    (e) =>
      e instanceof RegistryResolutionError &&
      /requires OPENROUTER_API_KEY/.test(e.message) &&
      /refusing to guess credentials/.test(e.message),
  );
});

test('registry: zai has no credential requirement at resolution time', () => {
  setEnv({ OPENROUTER_API_KEY: undefined });
  const r = resolveModel('vision', { provider: 'local' });
  assert.equal(r.modelId, 'glm-5v-turbo');
});

// ─── malformed config tolerance (boot never crashes) ─────────────────────────

test('registry: malformed YOU_AI_PROVIDERS entries are skipped with documented reasons', () => {
  const { overrides, warnings } = parseProviderOverrides(
    'openrouter:, , :glm-5v-turbo, garbage:model, openrouter:not-a-registry-model, zai:glm-5v-turbo',
  );
  assert.equal(overrides.size, 1, 'only the one valid entry survives');
  assert.equal(overrides.get('zai'), 'glm-5v-turbo');
  // 5 invalid segments − 1 silently-tolerated empty segment = 4 documented skips
  assert.equal(warnings.length, 4, 'one documented reason per non-empty invalid entry');
  for (const w of warnings) {
    assert.match(w, /^YOU_AI_PROVIDERS: skipping entry ".+" — /, `documented reason: ${w}`);
  }
  // every distinct failure mode is named
  const joined = warnings.join('\n');
  assert.match(joined, /expected the form "provider:model"/);
  assert.match(joined, /unknown provider "garbage"/);
  assert.match(joined, /not in the registry for provider "openrouter"/);
});

test('registry: empty or unset YOU_AI_PROVIDERS parses to nothing (no warnings)', () => {
  for (const raw of [undefined, '', '   ', ',,,']) {
    const { overrides, warnings } = parseProviderOverrides(raw);
    assert.equal(overrides.size, 0);
    assert.deepEqual(warnings, []);
  }
});

test('registry: malformed knobs never crash resolution — it falls through to the default', () => {
  setEnv({ YOU_AI_PROVIDERS: 'wat:wat, openrouter:,:x', YOU_AI_VISION_MODEL: 'not-in-registry' });
  const r = resolveModel('vision', { provider: 'openrouter' });
  assert.equal(r.modelId, 'google/gemini-2.5-flash');
  assert.equal(r.source, 'registry-default');
});

test('registry: invalid entries are logged once per reason with the module prefix', () => {
  const seen = [];
  const originalWarn = console.warn;
  console.warn = (...args) => seen.push(args.join(' '));
  try {
    setEnv({ YOU_AI_PROVIDERS: 'unique-malformed-entry-for-log-test:no-model' });
    resolveModel('vision', { provider: 'openrouter' });
    resolveModel('vision', { provider: 'openrouter' }); // dedup: same reason
  } finally {
    console.warn = originalWarn;
  }
  const hits = seen.filter((line) => line.includes('unique-malformed-entry-for-log-test'));
  assert.equal(hits.length, 1, 'logged exactly once (deduplicated)');
  assert.match(hits[0], /^\[you:ai-registry\] YOU_AI_PROVIDERS: skipping entry /);
});

// ─── registry immutability after boot ────────────────────────────────────────

test('registry: MODEL_REGISTRY is deep-frozen and has no mutation API', () => {
  assert.ok(Object.isFrozen(MODEL_REGISTRY));
  assert.equal(listModels(), MODEL_REGISTRY, 'listModels returns the frozen registry itself');
  assert.ok(MODEL_REGISTRY.length >= 5, 'multiple models per provider are registered');
  const providers = new Set(MODEL_REGISTRY.map((e) => e.provider));
  assert.deepEqual([...providers].sort(), ['openrouter', 'zai']);
  for (const entry of MODEL_REGISTRY) {
    assert.ok(Object.isFrozen(entry), `entry ${entry.modelId} is frozen`);
    assert.ok(Object.isFrozen(entry.capabilities), `capabilities of ${entry.modelId} are frozen`);
    assert.ok(Object.isFrozen(entry.defaultFor), `defaultFor of ${entry.modelId} is frozen`);
  }
  for (const meta of Object.values(PROVIDER_METADATA)) {
    assert.ok(Object.isFrozen(meta));
    assert.ok(Object.isFrozen(meta.aliases));
  }
});

test('registry: mutation attempts throw (strict mode) and never change resolution', () => {
  const before = resolveModel('vision', { provider: 'openrouter' });
  const firstEntry = MODEL_REGISTRY[0];
  assert.throws(() => {
    MODEL_REGISTRY.push({ ...firstEntry, modelId: 'injected' });
  }, TypeError);
  assert.throws(() => {
    firstEntry.modelId = 'tampered';
  }, TypeError);
  assert.throws(() => {
    firstEntry.capabilities.vision = false;
  }, TypeError);
  assert.throws(() => {
    MODEL_REGISTRY[0] = firstEntry;
  }, TypeError);
  const after = resolveModel('vision', { provider: 'openrouter' });
  assert.deepEqual(after, before, 'resolution is byte-identical after mutation attempts');
  assert.ok(!MODEL_REGISTRY.some((e) => e.modelId === 'injected' || e.modelId === 'tampered'));
});

// ─── registry self-consistency ───────────────────────────────────────────────

test('registry: every declared default is enabled, capability-matching and unique per provider', () => {
  const defaults = new Map();
  for (const entry of MODEL_REGISTRY) {
    for (const cap of entry.defaultFor) {
      assert.ok(entry.enabled, `default ${entry.modelId} must be enabled`);
      assert.ok(entry.capabilities[cap], `default ${entry.modelId} must declare capability "${cap}"`);
      const key = `${entry.provider}:${cap}`;
      assert.ok(!defaults.has(key), `at most one default per provider+capability (duplicate: ${key})`);
      defaults.set(key, entry.modelId);
      // the declared default must actually be what resolveModel falls back to
      const r = resolveModel(cap, { provider: entry.provider });
      assert.equal(r.modelId, entry.modelId);
      assert.equal(r.source, 'registry-default');
    }
  }
  assert.equal(defaults.get('zai:vision'), 'glm-5v-turbo');
  assert.equal(defaults.get('openrouter:vision'), 'google/gemini-2.5-flash');
});

test('registry: unverified capability numbers are null, never fabricated', () => {
  for (const entry of MODEL_REGISTRY) {
    for (const field of ['maxImageInputBytes', 'contextTokens']) {
      const v = entry.capabilities[field];
      assert.ok(v === null || (typeof v === 'number' && v > 0), `${entry.modelId}.${field} is null or a positive number`);
    }
    assert.ok(typeof entry.notes === 'string' && entry.notes.length > 0, `${entry.modelId} carries a provenance note`);
  }
});
