// ═══════════════════════════════════════════════════════════════════════════
// YOU avatar/embodiment UX tests (P6.B7, Worker B lane) — node:test.
//
// Covers the P6.B7 surface with real evidence, two layers:
//
// PURE (no server, no network, no db — the agent-runtime suite's law):
//   1. STATE-MACHINE TRANSITION TABLE: EMBODIMENT_TRANSITIONS encodes the
//      direct legal arcs of the C6 turn lifecycle; canTransition accepts the
//      legal set and rejects the illegal set (idle→speaking, listening→
//      tool_use, reading→typing, tool_use→speaking, typing→thinking,
//      speaking→tool_use, interrupted→speaking, unavailable→thinking …).
//   2. DERIVATION LIFECYCLE: a fine-grained simulated turn (queued → load →
//      consent → enforce → reply waiting-on-model → tool round → follow-up →
//      persist → succeeded + recorded events) emits ONLY table-legal adjacent
//      states, in the exact P4 sequence reading → thinking → tool_use →
//      thinking → typing → speaking; composer → listening; the documented
//      inactivity threshold → idle + re-engage why; failed/dead → unavailable
//      with the verbatim job error; interrupt → interrupted (queued-cancel
//      and running-request flavors); ended session → unavailable. The
//      engine's NEW onPhase seam reports model/tool boundaries (turn
//      transparency) and a throwing reporter never breaks the turn.
//   3. PROVIDER STATUS RESOLUTION (fail-closed, env-injected): a provider
//      whose registry-required env key is unset is unavailable with the
//      honest reason (the key NAME, never a value); a credential-configured
//      provider without a wave-1 chat adapter stays unavailable with the
//      honest wave-1 reason; the executable provider resolves available; the
//      chat-seam breaker health is projected read-only; the per-soul binding
//      resolves available / unavailable / unknown-registry honestly.
//   4. SOUL PROVIDER CONFIG VALIDATION: decideSoulProviderBinding accepts the
//      wave-1 adapter (case/whitespace normalized) and refuses unknown or
//      adapter-less providers with the typed 400 taxonomy.
//
// API LEVEL (boots/reuses the shared app server like the P6.B3/B5 suites;
// no network beyond 127.0.0.1; the DB is touched directly only for the
// in-flight job seeding + the isolation tenant — the B5 suite's law):
//   5. GET /api/v1/agent/providers — the registry surface (auth'd, no
//      credential values ever in the payload).
//   6. Soul creation through the provider wiring: provider "zai" accepted;
//      provider "openrouter" refused with the wave-1 chat-adapter 400.
//   7. INTERRUPT semantics on seeded in-flight turn jobs (the rows the
//      runtime would have produced — the B5 seeding precedent): queued →
//      202 effective cancellation (job cancelled, no reply) and the session
//      join drives deriveEmbodimentState() to `interrupted`; running → 202
//      durable interrupt request (effective: false); nothing in flight →
//      409. The session/turns API join carries jobStep/jobProgress/
//      jobFinishedAt (turn transparency).
//   8. TENANT ISOLATION: a second tenant (seeded directly) gets 404 on the
//      first tenant's session detail AND interrupt (no existence leak), and
//      sees none of its souls/sessions.
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

import {
  EMBODIMENT_STATES,
  EMBODIMENT_TRANSITIONS,
  IDLE_AFTER_MS,
  canTransition,
  deriveEmbodimentState,
  embodimentTurnPending,
} from '../../apps/web/src/lib/you/agent/embodiment.ts';
import {
  resolveSoulProviderStatuses,
  resolveSoulProviderBinding,
  registryToSourceRows,
} from '../../apps/web/src/lib/you/agent/soul-providers.ts';
import { MODEL_REGISTRY, PROVIDER_METADATA } from '../../apps/web/src/lib/you/ai/registry.ts';
import {
  SOUL_PROVIDER_IDS,
  decideSoulProviderBinding,
  normalizeBehaviorParams,
  normalizeManifest,
  normalizePersona,
  runAgentTurnEngine,
} from '../../apps/web/src/lib/you/agent/runtime-core.ts';

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

let twinA = null;
let bodyA = null;
let soulA = null;
let sessionA = null;
let queuedJobId = null;
let runningJobId = null;

// ═════════════════════════════════════════════════════════════════════════
// PART A — PURE: the transition table
// ═════════════════════════════════════════════════════════════════════════

test('b7: transition table — the full P4 state set with legal direct arcs per the runtime lifecycle', () => {
  assert.equal(EMBODIMENT_STATES.length, 9);
  for (const s of EMBODIMENT_STATES) {
    assert.ok(Array.isArray(EMBODIMENT_TRANSITIONS[s]), `table row for ${s}`);
  }
  // the runtime's real sequencing — a sample of every legal arc family
  const legal = [
    ['idle', 'listening'], ['idle', 'reading'], ['idle', 'unavailable'],
    ['listening', 'reading'], ['listening', 'idle'], ['listening', 'unavailable'],
    ['reading', 'thinking'], ['reading', 'unavailable'], ['reading', 'interrupted'],
    ['thinking', 'tool_use'], ['thinking', 'typing'], ['thinking', 'unavailable'], ['thinking', 'interrupted'],
    ['tool_use', 'thinking'], ['tool_use', 'typing'], ['tool_use', 'unavailable'], ['tool_use', 'interrupted'],
    ['typing', 'speaking'], ['typing', 'unavailable'], ['typing', 'interrupted'],
    ['speaking', 'idle'], ['speaking', 'listening'], ['speaking', 'reading'], ['speaking', 'unavailable'],
    ['interrupted', 'idle'], ['interrupted', 'listening'], ['interrupted', 'reading'], ['interrupted', 'unavailable'],
    ['unavailable', 'listening'], ['unavailable', 'reading'], ['unavailable', 'idle'],
  ];
  for (const [from, to] of legal) {
    assert.ok(canTransition(from, to), `legal arc ${from} → ${to} must be accepted`);
  }
  // holding a state is legal
  assert.ok(canTransition('thinking', 'thinking'));
});

test('b7: transition table — illegal direct arcs are rejected (runtime impossibilities)', () => {
  const illegal = [
    // a reply artifact cannot appear without a submitted turn (reading first)
    ['idle', 'thinking'], ['idle', 'tool_use'], ['idle', 'typing'], ['idle', 'speaking'],
    ['listening', 'thinking'], ['listening', 'tool_use'], ['listening', 'typing'], ['listening', 'speaking'],
    // intake precedes the model; the model precedes tools/persist/speaking
    ['reading', 'tool_use'], ['reading', 'typing'], ['reading', 'speaking'],
    // a tool result requires a follow-up model call before the reply
    ['tool_use', 'speaking'],
    // persist is the turn's terminal act
    ['typing', 'thinking'], ['typing', 'tool_use'], ['typing', 'reading'], ['typing', 'listening'], ['typing', 'idle'],
    // a NEW turn passes through reading; mid-turn states cannot resume from results
    ['speaking', 'thinking'], ['speaking', 'tool_use'], ['speaking', 'typing'],
    // an interrupted turn settles or re-engages; it cannot resume mid-flight
    ['interrupted', 'thinking'], ['interrupted', 'tool_use'], ['interrupted', 'typing'], ['interrupted', 'speaking'],
    // recovery goes through a submitted turn; unavailable cannot jump to mid-turn states
    ['unavailable', 'thinking'], ['unavailable', 'tool_use'], ['unavailable', 'typing'], ['unavailable', 'speaking'],
  ];
  for (const [from, to] of illegal) {
    assert.ok(!canTransition(from, to), `illegal arc ${from} → ${to} must be rejected`);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// PART B — PURE: the derivation over the session/turn/job join
// ═════════════════════════════════════════════════════════════════════════

const T0 = 1_700_000_000_000;
const iso = (ms) => new Date(ms).toISOString();

function userTurn(overrides = {}) {
  return {
    role: 'user',
    createdAt: iso(T0),
    jobId: 'job_1',
    jobStatus: null,
    jobError: null,
    jobProgress: null,
    jobStep: null,
    jobFinishedAt: null,
    states: [],
    ...overrides,
  };
}

function agentTurn(overrides = {}) {
  return {
    role: 'agent',
    createdAt: iso(T0 + 4000),
    jobId: null,
    jobStatus: null,
    jobError: null,
    jobProgress: null,
    jobStep: null,
    jobFinishedAt: null,
    states: [
      { eventId: 'e1', sessionId: 'sess', type: 'thinking', timestamp: iso(T0 + 4100), durationMs: 800, source: 'llm', payload: {} },
      { eventId: 'e2', sessionId: 'sess', type: 'tool_use', timestamp: iso(T0 + 5000), durationMs: 120, source: 'application', payload: {} },
      { eventId: 'e3', sessionId: 'sess', type: 'thinking', timestamp: iso(T0 + 5200), durationMs: 700, source: 'llm', payload: {} },
      { eventId: 'e4', sessionId: 'sess', type: 'speaking', timestamp: iso(T0 + 6000), durationMs: null, source: 'llm', payload: {} },
    ],
    ...overrides,
  };
}

const step = (key, label, detail) => ({ key, label, status: 'running', ...(detail ? { detail } : {}) });

test('b7: derivation — a fine-grained turn lifecycle emits only table-legal adjacent states in the P4 sequence', () => {
  const seq = [];
  const at = (ms) => ({ now: T0 + ms, idleAfterMs: 60_000 });
  const base0 = { sessionStatus: 'live', turns: [] };

  // fresh session → idle, honest why
  let d = deriveEmbodimentState({ ...base0, ...at(0) });
  assert.equal(d.state, 'idle');
  assert.match(d.why, /awaiting the first message/);
  seq.push(d.state);

  // composer engaged → listening
  d = deriveEmbodimentState({ ...base0, composerActive: true, ...at(1000) });
  assert.equal(d.state, 'listening');
  assert.match(d.why, /composing/);
  seq.push(d.state);

  // submitted: queued → running load → consent → enforce (reading family)
  const q = userTurn({ jobStatus: 'queued', jobProgress: 0 });
  d = deriveEmbodimentState({ ...base0, turns: [q], ...at(2000) });
  assert.equal(d.state, 'reading');
  assert.match(d.why, /queued/);
  seq.push(d.state);

  d = deriveEmbodimentState({
    ...base0, turns: [userTurn({ jobStatus: 'running', jobProgress: 0.05, jobStep: step('load', 'Load session, pinned Body/Soul snapshots and history') })], ...at(2100),
  });
  assert.equal(d.state, 'reading');
  assert.match(d.why, /reading the session/);
  seq.push(d.state);

  d = deriveEmbodimentState({
    ...base0, turns: [userTurn({ jobStatus: 'running', jobProgress: 0.15, jobStep: step('consent', 'Re-verify embodiment consent') })], ...at(2200),
  });
  assert.equal(d.state, 'reading');
  assert.match(d.why, /consent/);
  seq.push(d.state);

  d = deriveEmbodimentState({
    ...base0, turns: [userTurn({ jobStatus: 'running', jobProgress: 0.2, jobStep: step('enforce', 'Capability manifests') })], ...at(2300),
  });
  assert.equal(d.state, 'reading');
  seq.push(d.state);

  // reply: waiting on model (draft) → thinking
  d = deriveEmbodimentState({
    ...base0, turns: [userTurn({ jobStatus: 'running', jobProgress: 0.35, jobStep: step('reply', 'Run the Soul', 'waiting on model — drafting the reply') })], ...at(2400),
  });
  assert.equal(d.state, 'thinking');
  assert.match(d.why, /waiting on model/);
  seq.push(d.state);

  // tool round → tool_use with the tool named (turn transparency)
  d = deriveEmbodimentState({
    ...base0, turns: [userTurn({ jobStatus: 'running', jobProgress: 0.5, jobStep: step('reply', 'Run the Soul', 'tool round 1: twins.list') })], ...at(2500),
  });
  assert.equal(d.state, 'tool_use');
  assert.match(d.why, /tool round 1: twins\.list/);
  seq.push(d.state);

  // follow-up model call → thinking again
  d = deriveEmbodimentState({
    ...base0, turns: [userTurn({ jobStatus: 'running', jobProgress: 0.6, jobStep: step('reply', 'Run the Soul', 'waiting on model — follow-up after tool round 1') })], ...at(2600),
  });
  assert.equal(d.state, 'thinking');
  seq.push(d.state);

  // persist → typing
  d = deriveEmbodimentState({
    ...base0, turns: [userTurn({ jobStatus: 'running', jobProgress: 0.85, jobStep: step('persist', 'Persist agent turn') })], ...at(2700),
  });
  assert.equal(d.state, 'typing');
  assert.match(d.why, /recording the reply/);
  seq.push(d.state);

  // succeeded + the recorded events → speaking (the last real event)
  d = deriveEmbodimentState({
    ...base0, turns: [userTurn({ jobStatus: 'succeeded', jobFinishedAt: iso(T0 + 3000) }), agentTurn()], ...at(3200),
  });
  assert.equal(d.state, 'speaking');
  assert.equal(d.since, iso(T0 + 6000));
  assert.match(d.why, /last recorded event — speaking/);
  seq.push(d.state);

  // inactivity threshold → idle with the re-engage why
  d = deriveEmbodimentState({
    ...base0, turns: [userTurn({ jobStatus: 'succeeded', jobFinishedAt: iso(T0 + 3000) }), agentTurn()], ...at(6000 + 61_000),
  });
  assert.equal(d.state, 'idle');
  assert.match(d.why, /re-engage/);
  seq.push(d.state);

  // composer re-engagement → listening
  d = deriveEmbodimentState({
    ...base0, composerActive: true,
    turns: [userTurn({ jobStatus: 'succeeded', jobFinishedAt: iso(T0 + 3000) }), agentTurn()],
    ...at(6000 + 61_000),
  });
  assert.equal(d.state, 'listening');
  seq.push(d.state);

  // every adjacent pair the derivation emitted must be table-legal
  for (let i = 0; i < seq.length - 1; i += 1) {
    assert.ok(
      canTransition(seq[i], seq[i + 1]),
      `derived adjacent transition ${seq[i]} → ${seq[i + 1]} must be legal per the table`,
    );
  }
  assert.deepEqual(seq, ['idle', 'listening', 'reading', 'reading', 'reading', 'reading', 'thinking', 'tool_use', 'thinking', 'typing', 'speaking', 'idle', 'listening']);
});

test('b7: derivation — failed/dead turns, interrupts and ended sessions are honest', () => {
  // failed latest turn → unavailable with the verbatim error (sticky)
  let d = deriveEmbodimentState({
    sessionStatus: 'live',
    turns: [userTurn({ jobStatus: 'failed', jobError: 'chat seam 503 after bounded retries', jobFinishedAt: iso(T0 + 5000) })],
    now: T0 + 10_000,
  });
  assert.equal(d.state, 'unavailable');
  assert.match(d.why, /failed/);
  assert.match(d.why, /chat seam 503 after bounded retries/);
  assert.ok(!d.inFlight);

  // dead-lettered turns say so
  d = deriveEmbodimentState({
    sessionStatus: 'live',
    turns: [userTurn({ jobStatus: 'dead', jobError: 'dead', jobFinishedAt: iso(T0 + 5000) })],
    now: T0 + 10_000,
  });
  assert.equal(d.state, 'unavailable');
  assert.match(d.why, /dead-lettered/);

  // user interrupt of a RUNNING job → interrupted, honest no-cooperative-cancel why
  d = deriveEmbodimentState({
    sessionStatus: 'live',
    turns: [userTurn({ jobStatus: 'running', jobProgress: 0.35, jobStep: step('reply', 'Run the Soul', 'waiting on model — drafting the reply') })],
    interruptedJobIds: ['job_1'],
    now: T0 + 3000,
  });
  assert.equal(d.state, 'interrupted');
  assert.match(d.why, /may still complete/);
  assert.ok(d.inFlight);

  // queued interrupt → the cancellation-pending flavor
  d = deriveEmbodimentState({
    sessionStatus: 'live',
    turns: [userTurn({ jobStatus: 'queued' })],
    interruptedJobIds: ['job_1'],
    now: T0 + 3000,
  });
  assert.equal(d.state, 'interrupted');
  assert.match(d.why, /cancellation pending pickup/);

  // a cancelled (interrupted-while-queued) terminal job → interrupted within the threshold…
  d = deriveEmbodimentState({
    sessionStatus: 'live',
    turns: [userTurn({ jobStatus: 'cancelled', jobFinishedAt: iso(T0 + 5000) })],
    now: T0 + 10_000,
  });
  assert.equal(d.state, 'interrupted');
  assert.match(d.why, /cancelled before the runtime picked it up/);
  // …and settled to idle after the inactivity threshold
  d = deriveEmbodimentState({
    sessionStatus: 'live',
    turns: [userTurn({ jobStatus: 'cancelled', jobFinishedAt: iso(T0 + 5000) })],
    now: T0 + 10_000 + 61_000,
  });
  assert.equal(d.state, 'idle');

  // an ended session is permanently unavailable
  d = deriveEmbodimentState({
    sessionStatus: 'ended',
    endedAt: iso(T0 + 9000),
    turns: [userTurn({ jobStatus: 'succeeded', jobFinishedAt: iso(T0 + 3000) }), agentTurn()],
    now: T0 + 10_000,
  });
  assert.equal(d.state, 'unavailable');
  assert.match(d.why, /session ended/);

  // the accept-time breaker refusal flag → honest degraded state
  d = deriveEmbodimentState({
    sessionStatus: 'live',
    turns: [],
    providerDegradedWhy: 'chat provider unavailable — circuit breaker cooling, ~30s',
    now: T0 + 1000,
  });
  assert.equal(d.state, 'unavailable');
  assert.match(d.why, /circuit breaker cooling/);
});

test('b7: derivation — pending-detection and the documented threshold', () => {
  assert.ok(embodimentTurnPending(userTurn({ jobStatus: 'queued' })));
  assert.ok(embodimentTurnPending(userTurn({ jobStatus: 'running' })));
  assert.ok(!embodimentTurnPending(userTurn({ jobStatus: 'succeeded' })));
  assert.ok(!embodimentTurnPending(userTurn({ jobStatus: 'cancelled' })));
  assert.ok(!embodimentTurnPending(userTurn({ jobStatus: 'failed' })));
  assert.equal(IDLE_AFTER_MS, 60_000);
});

// ═════════════════════════════════════════════════════════════════════════
// PART C — PURE: provider status resolution (fail-closed)
// ═════════════════════════════════════════════════════════════════════════

test('b7: provider status — fail-closed on unset credentials, honest wave-1 chat-adapter truth', () => {
  const registry = registryToSourceRows(PROVIDER_METADATA, MODEL_REGISTRY);
  // NO env at all: the in-sandbox provider needs no credential → available;
  // hosted providers are refused with the KEY NAME (never a value)
  const rows = resolveSoulProviderStatuses(registry, {}, SOUL_PROVIDER_IDS);
  assert.equal(rows.length, 3);

  const zai = rows.find((r) => r.id === 'zai');
  assert.ok(zai, 'zai row present');
  assert.equal(zai.available, true);
  assert.equal(zai.chatExecutable, true);
  assert.equal(zai.envConfigured, true);
  assert.equal(zai.requiredEnvKey, null);
  assert.match(zai.reason, /no credential required/);
  assert.ok(zai.models.some((m) => m.modelId === 'glm-5v-turbo'), 'registry models are referenced');

  const or = rows.find((r) => r.id === 'openrouter');
  assert.equal(or.available, false);
  assert.equal(or.envConfigured, false);
  assert.match(or.reason, /OPENROUTER_API_KEY/);
  assert.match(or.reason, /fail-closed/);

  const ds = rows.find((r) => r.id === 'dashscope');
  assert.equal(ds.available, false);
  assert.match(ds.reason, /DASHSCOPE_API_KEY/);

  // with the key set: env-configured, but STILL unavailable for Souls — the
  // registry has no chat capability for it (wave-1 truth, no guessing)
  const rows2 = resolveSoulProviderStatuses(registry, { OPENROUTER_API_KEY: 'test-value-not-a-real-credential' }, SOUL_PROVIDER_IDS);
  const or2 = rows2.find((r) => r.id === 'openrouter');
  assert.equal(or2.envConfigured, true);
  assert.equal(or2.available, false);
  assert.equal(or2.chatExecutable, false);
  assert.match(or2.reason, /no chat adapter/);
  // the credential VALUE never reaches the resolved rows
  const serialized = JSON.stringify(rows2);
  assert.ok(!serialized.includes('test-value-not-a-real-credential'), 'credential values must never leak into status rows');

  // the chat-seam breaker health is projected read-only for executable providers
  const rows3 = resolveSoulProviderStatuses(registry, {}, SOUL_PROVIDER_IDS, {
    zai: {
      state: 'open', failuresInWindow: 3, failureThreshold: 3, windowMs: 60_000, cooldownMs: 30_000,
      openedAt: iso(T0), openedReason: 'chat seam timeouts', lastError: 'timeout', lastFailureAt: iso(T0),
      retryAfterMs: 25_000, successCount: 5, failureCount: 3,
    },
  });
  const zai3 = rows3.find((r) => r.id === 'zai');
  assert.equal(zai3.chatSeam.state, 'open');
  assert.equal(zai3.chatSeam.retryAfterMs, 25_000);
  assert.equal(zai3.chatSeam.openedReason, 'chat seam timeouts');
  // an open breaker makes the executable provider honestly unavailable
  const binding = resolveSoulProviderBinding('zai', rows3);
  assert.equal(binding.available, false);
  assert.match(binding.reason, /circuit breaker open/);
  assert.match(binding.reason, /~25s/);
});

test('b7: per-soul provider binding — unknown providers are reported, never guessed', () => {
  const rows = resolveSoulProviderStatuses(registryToSourceRows(PROVIDER_METADATA, MODEL_REGISTRY), {}, SOUL_PROVIDER_IDS);
  const okBinding = resolveSoulProviderBinding('zai', rows);
  assert.equal(okBinding.available, true);

  const unknown = resolveSoulProviderBinding('not-a-registry-provider', rows);
  assert.equal(unknown.available, false);
  assert.equal(unknown.row, null);
  assert.match(unknown.reason, /not in the C5 model registry/);

  const orBinding = resolveSoulProviderBinding('openrouter', rows);
  assert.equal(orBinding.available, false);
  assert.match(orBinding.reason, /OPENROUTER_API_KEY/);
});

// ═════════════════════════════════════════════════════════════════════════
// PART D — PURE: soul provider config validation (the server-side rule)
// ═════════════════════════════════════════════════════════════════════════

test('b7: soul provider config validation — wave-1 allow-list, typed 400 taxonomy', () => {
  // the wave-1 adapter is accepted, case/whitespace normalized
  let d = decideSoulProviderBinding('zai');
  assert.deepEqual(d, { ok: true, provider: 'zai' });
  d = decideSoulProviderBinding('  ZAI ');
  assert.deepEqual(d, { ok: true, provider: 'zai' });

  // registry providers without a chat adapter → typed 400 with the wave-1 truth
  d = decideSoulProviderBinding('openrouter');
  assert.equal(d.ok, false);
  assert.equal(d.refusal.status, 400);
  assert.match(d.refusal.message, /no chat adapter in wave-1/);
  assert.match(d.refusal.message, /C5 model registry has no chat capability/);
  d = decideSoulProviderBinding('dashscope');
  assert.equal(d.ok, false);
  assert.equal(d.refusal.status, 400);

  // unknown providers → typed 400 (never guessed)
  d = decideSoulProviderBinding('grog');
  assert.equal(d.ok, false);
  assert.equal(d.refusal.status, 400);
  assert.match(d.refusal.message, /"grog"/);

  // empty/whitespace → refused (no silent default)
  d = decideSoulProviderBinding('   ');
  assert.equal(d.ok, false);

  // provider-neutral: the allow-list is a parameter, not a hardcode
  d = decideSoulProviderBinding('customprov', ['zai', 'customprov']);
  assert.deepEqual(d, { ok: true, provider: 'customprov' });
});

// ═════════════════════════════════════════════════════════════════════════
// PART E — PURE: the engine's onPhase transparency seam
// ═════════════════════════════════════════════════════════════════════════

const FULL_CAN = ['conversation', 'tool-use', 'evidence-request'];

test('b7: engine onPhase — real model/tool boundaries are reported; a throwing reporter never breaks the turn', async () => {
  const input = {
    tenantId: 'tenant_1',
    sessionId: 'sess_1',
    twinId: 'twin_1',
    body: {
      name: 'Twin Concierge', role: 'host', description: null, version: 3,
      tools: ['twins.list'], manifest: normalizeManifest(FULL_CAN), twinVersionId: 'tv_1',
    },
    soul: {
      name: 'Warm Host', description: null, version: 2,
      persona: normalizePersona({ tagline: 'Warm' }),
      manifest: normalizeManifest(FULL_CAN),
      params: normalizeBehaviorParams({ thinking: false, temperature: 0.4 }),
      provider: 'zai', model: 'glm-fast', twinDisplayName: 'Ada',
    },
    history: [],
    message: 'list the twins',
    turnSeed: 123456,
  };
  const phases = [];
  const makeDeps = (onPhase) => {
    let chatCall = 0;
    return {
      chat: async () => {
        chatCall += 1;
        // first call asks for the tool; the follow-up answers the user
        return { content: chatCall === 1 ? 'TOOL: twins.list\nINPUT: {}' : 'Here are your twins.', latencyMs: 42, model: 'glm-fast' };
      },
      executeTool: async () => ({ tool: 'twins.list', input: {}, executed: true, effect: 'read', result: { twins: [] }, durationMs: 5, reason: null }),
      now: () => T0,
      uuid: () => `u-${chatCall}`,
      onPhase,
    };
  };
  const out = await runAgentTurnEngine(makeDeps((p) => phases.push(p)), input);
  assert.equal(out.reply, 'Here are your twins.');
  assert.equal(out.llmCalls, 2);
  assert.deepEqual(phases, [
    { phase: 'model', call: 'draft', round: 0 },
    { phase: 'tool', tool: 'twins.list', round: 1, executed: true },
    { phase: 'model', call: 'follow-up', round: 1 },
  ]);

  // a THROWING transparency reporter must not fail the turn
  const phases2 = [];
  const out2 = await runAgentTurnEngine(makeDeps((p) => { phases2.push(p); throw new Error('transparency reporter exploded'); }), input);
  assert.equal(out2.reply, 'Here are your twins.');
  assert.equal(phases2.length, 3);
});

// ═════════════════════════════════════════════════════════════════════════
// PART F — API level: the provider surface, soul wiring, interrupts, isolation
// ═════════════════════════════════════════════════════════════════════════

async function call(pathname, { method = 'GET', body, headers = {}, cookieOverride } = {}) {
  const h = { ...headers };
  if (cookieOverride) h.cookie = cookieOverride;
  else if (cookie) h.cookie = cookie;
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
          console.log(`[b7-tests] reusing suite server at ${base}`);
          return base;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(!aggregated, 'aggregated run: the sibling suite never published its server URL within 150s');
      console.log('[b7-tests] booting apps/web (next dev) on a free port…');
      await startServer();
      ownServer = true;
      console.log(`[b7-tests] server ready at ${base}`);
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
    console.log('[b7-tests] own server stopped');
  }
});

test('b7: provider surface + soul provider wiring (registry truth, fail-closed)', async () => {
  await ensureBase();
  await call('/api/v1/session', { method: 'POST', body: {} });

  // the provider surface is auth'd, registry-driven and credential-free
  let r = await call('/api/v1/agent/providers');
  assert.equal(r.status, 200, `providers → ${r.status}`);
  assert.ok(Array.isArray(r.json));
  const zaiRow = r.json.find((p) => p.id === 'zai');
  assert.ok(zaiRow, 'zai provider row');
  assert.equal(zaiRow.available, true);
  assert.equal(zaiRow.chatExecutable, true);
  assert.ok(zaiRow.chatSeam, 'chat-seam breaker health projected');
  assert.ok(['closed', 'open', 'half-open'].includes(zaiRow.chatSeam.state), 'honest breaker state');
  assert.ok(typeof zaiRow.chatSeam.retryAfterMs === 'number', 'retry guidance projected');
  for (const row of r.json) {
    // only key NAMES, never values: no field may carry a credential
    assert.ok(!('apiKey' in row) && !('credential' in row) && !('credentials' in row), 'no credential fields');
  }

  // tenant A fixtures: twin + embodiment consent + body + soul + activation
  const t = await call('/api/v1/twins', { method: 'POST', body: { displayName: `B7 main ${stamp}` } });
  assert.equal(t.status, 201, `twin create → ${t.status}`);
  twinA = t.json;

  const g = await call('/api/v1/consent-grants', {
    method: 'POST',
    body: { subjectId: twinA.subjectId, purpose: `P6.B7 embodiment ${stamp}`, scopes: ['embodiment'], ttlHours: 6 },
  });
  assert.equal(g.status, 201, `embodiment grant → ${g.status}`);

  // abstract Body (no twin binding — a fresh twin has no TwinVersion yet; the
  // binding law allows an unbound Body with any twin-bound Soul)
  const body = await call('/api/v1/agent/bodies', {
    method: 'POST',
    body: { name: `B7 Body ${stamp}`, role: 'host', tools: [], capabilities: ['conversation'] },
  });
  assert.equal(body.status, 201, `body create → ${body.status}`);
  bodyA = body.json;
  const ab = await call(`/api/v1/agent/bodies/${bodyA.id}`, { method: 'PATCH', body: { action: 'activate' } });
  assert.equal(ab.status, 200, `body activate → ${ab.status}`);

  // the wave-1 adapter is accepted; adapter-less registry providers are refused 400
  const s = await call('/api/v1/agent/souls', {
    method: 'POST',
    body: { name: `B7 Soul ${stamp}`, twinId: twinA.id, provider: 'zai', model: 'glm-fast', capabilities: ['conversation'] },
  });
  assert.equal(s.status, 201, `soul create (zai) → ${s.status}`);
  soulA = s.json;
  assert.equal(soulA.provider, 'zai');
  assert.equal(soulA.status, 'draft');

  const sBad = await call('/api/v1/agent/souls', {
    method: 'POST',
    body: { name: `B7 Bad Soul ${stamp}`, twinId: twinA.id, provider: 'openrouter', model: 'google/gemini-2.5-flash', capabilities: ['conversation'] },
  });
  assert.equal(sBad.status, 400, `soul create (openrouter) → ${sBad.status}`);
  assert.equal(sBad.json.error.code, 'validation_failed');
  assert.match(sBad.json.error.message, /no chat adapter in wave-1/);

  const asoul = await call(`/api/v1/agent/souls/${soulA.id}`, { method: 'PATCH', body: { action: 'activate' } });
  assert.equal(asoul.status, 200, `soul activate → ${asoul.status}`);

  const sess = await call('/api/v1/agent/sessions', { method: 'POST', body: { bodyId: bodyA.id, soulId: soulA.id } });
  assert.equal(sess.status, 201, `session create → ${sess.status}`);
  sessionA = sess.json;
  assert.equal(sessionA.status, 'live');
});

test('b7: interrupt — queued job cancels effectively; the API join drives the avatar to interrupted', async () => {
  await ensureBase();
  const pr = await prisma();

  // seed the rows the runtime would have produced (B5 precedent): a user
  // turn + a QUEUED agent.turn job (fire-and-forget runner never started for
  // a directly-seeded row — inert until the interrupt flips it)
  const turn = await pr.agentRuntimeTurn.create({
    data: { sessionId: sessionA.id, role: 'user', content: `interrupt me (queued) ${stamp}` },
  });
  const job = await pr.job.create({
    data: {
      tenantId: (await pr.agentRuntimeSession.findUnique({ where: { id: sessionA.id } })).tenantId,
      kind: 'agent.turn',
      status: 'queued',
      input: JSON.stringify({ sessionId: sessionA.id, userTurnId: turn.id, message: 'interrupt me' }),
    },
  });
  await pr.agentRuntimeTurn.update({ where: { id: turn.id }, data: { jobId: job.id } });
  queuedJobId = job.id;

  // the join carries the transparency fields while in flight
  let r = await call(`/api/v1/agent/sessions/${sessionA.id}`);
  assert.equal(r.status, 200);
  const inflight = r.json.turns.find((x) => x.id === turn.id);
  assert.equal(inflight.jobStatus, 'queued');
  assert.equal(inflight.jobId, job.id);
  assert.equal(inflight.jobProgress, 0);

  // the derivation over the REAL fetched view: queued → reading
  let d = deriveEmbodimentState({ sessionStatus: r.json.status, endedAt: r.json.endedAt, turns: r.json.turns, now: Date.now() });
  assert.equal(d.state, 'reading');
  assert.ok(d.inFlight);

  // interrupt → 202, effective (queued cancellation)
  r = await call(`/api/v1/agent/sessions/${sessionA.id}/interrupt`, { method: 'POST', body: {} });
  assert.equal(r.status, 202, `interrupt queued → ${r.status}`);
  assert.equal(r.json.effective, true);
  assert.equal(r.json.jobId, job.id);
  assert.match(r.json.note, /no reply was or will be produced/);

  // the job is honestly cancelled; the join reflects it; the avatar derives interrupted
  const jobRow = await pr.job.findUnique({ where: { id: job.id } });
  assert.equal(jobRow.status, 'cancelled');
  assert.ok(jobRow.finishedAt, 'cancelled job carries finishedAt');

  r = await call(`/api/v1/agent/sessions/${sessionA.id}`);
  const cancelledTurn = r.json.turns.find((x) => x.id === turn.id);
  assert.equal(cancelledTurn.jobStatus, 'cancelled');
  assert.ok(cancelledTurn.jobFinishedAt, 'the join surfaces the terminal timestamp');
  d = deriveEmbodimentState({ sessionStatus: r.json.status, endedAt: r.json.endedAt, turns: r.json.turns, now: Date.now() });
  assert.equal(d.state, 'interrupted');
  assert.match(d.why, /no reply was produced/);

  // an interrupt with nothing in flight → honest 409
  r = await call(`/api/v1/agent/sessions/${sessionA.id}/interrupt`, { method: 'POST', body: {} });
  assert.equal(r.status, 409, `re-interrupt with nothing in flight → ${r.status}`);
});

test('b7: interrupt — a running job gets a durable request only (no fake cancellation)', async () => {
  await ensureBase();
  const pr = await prisma();

  // seed a RUNNING job (rows the runtime would have produced mid-flight)
  const turn = await pr.agentRuntimeTurn.create({
    data: { sessionId: sessionA.id, role: 'user', content: `interrupt me (running) ${stamp}` },
  });
  const session = await pr.agentRuntimeSession.findUnique({ where: { id: sessionA.id } });
  const job = await pr.job.create({
    data: {
      tenantId: session.tenantId,
      kind: 'agent.turn',
      status: 'running',
      startedAt: new Date(),
      progress: 0.35,
      steps: JSON.stringify([
        { key: 'load', label: 'Load session, pinned Body/Soul snapshots and history', status: 'done' },
        { key: 'reply', label: 'Run the Soul', status: 'running', detail: 'waiting on model — drafting the reply' },
        { key: 'persist', label: 'Persist agent turn', status: 'pending' },
      ]),
      input: JSON.stringify({ sessionId: sessionA.id, userTurnId: turn.id, message: 'interrupt me' }),
    },
  });
  await pr.agentRuntimeTurn.update({ where: { id: turn.id }, data: { jobId: job.id } });
  runningJobId = job.id;

  // the join carries the live step detail (turn transparency)
  let r = await call(`/api/v1/agent/sessions/${sessionA.id}`);
  const runningTurn = r.json.turns.find((x) => x.id === turn.id);
  assert.equal(runningTurn.jobStatus, 'running');
  assert.ok(runningTurn.jobStep, 'the running step is joined');
  assert.equal(runningTurn.jobStep.key, 'reply');
  assert.match(runningTurn.jobStep.detail, /waiting on model/);
  assert.ok(runningTurn.jobProgress > 0, 'real job progress is joined');

  // the derivation over the REAL fetched view: reply/waiting-on-model → thinking
  let d = deriveEmbodimentState({ sessionStatus: r.json.status, endedAt: r.json.endedAt, turns: r.json.turns, now: Date.now() });
  assert.equal(d.state, 'thinking');
  assert.match(d.why, /waiting on model/);

  // interrupt → 202, NOT effective (no cooperative cancel seam)
  r = await call(`/api/v1/agent/sessions/${sessionA.id}/interrupt`, { method: 'POST', body: {} });
  assert.equal(r.status, 202, `interrupt running → ${r.status}`);
  assert.equal(r.json.effective, false);
  assert.match(r.json.note, /may still complete/);

  // the job row is UNTOUCHED (still running — no fake cancellation)
  const jobRow = await pr.job.findUnique({ where: { id: job.id } });
  assert.equal(jobRow.status, 'running');
  assert.equal(jobRow.finishedAt, null);

  // the durable interrupt request is recorded through the event seam
  const ev = await pr.eventRecord.findFirst({
    where: { tenantId: session.tenantId, type: 'agent.turn.interrupt_requested', entityId: sessionA.id },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(ev, 'agent.turn.interrupt_requested event emitted');
  assert.equal(JSON.parse(ev.payload).effective, false);

  // the client-side acknowledged interrupt drives the derivation to interrupted
  r = await call(`/api/v1/agent/sessions/${sessionA.id}`);
  d = deriveEmbodimentState({
    sessionStatus: r.json.status,
    endedAt: r.json.endedAt,
    turns: r.json.turns,
    interruptedJobIds: [job.id],
    now: Date.now(),
  });
  assert.equal(d.state, 'interrupted');
  assert.match(d.why, /may still complete/);
});

test('b7: tenant isolation — the second tenant sees nothing and cannot interrupt', async () => {
  await ensureBase();
  const pr = await prisma();

  // seed a second tenant + user + session directly (the B3/B5 precedent)
  const tenantB = await pr.tenant.create({
    data: { slug: `b7-iso-${stamp}`, name: `B7 Isolation ${stamp}` },
  });
  const userB = await pr.user.create({
    data: { tenantId: tenantB.id, email: `b7-${stamp}@example.test`, name: 'B7 Isolation User' },
  });
  const sessionB = await pr.session.create({
    data: {
      userId: userB.id,
      token: `b7-tok-${stamp}-${randomBytes(8).toString('hex')}`,
      expiresAt: new Date(Date.now() + 3600 * 1000),
    },
  });
  const bCookie = `you_session=${sessionB.token}`;

  // tenant B's souls/sessions lists contain none of tenant A's rows
  let r = await call('/api/v1/agent/souls', { cookieOverride: bCookie });
  assert.equal(r.status, 200);
  assert.ok(!(r.json ?? []).some((x) => x.id === soulA.id), 'tenant B must not see tenant A souls');
  r = await call('/api/v1/agent/sessions', { cookieOverride: bCookie });
  assert.equal(r.status, 200);
  assert.ok(!(r.json ?? []).some((x) => x.id === sessionA.id), 'tenant B must not see tenant A sessions');

  // cross-tenant session detail → 404 (no existence leak)
  r = await call(`/api/v1/agent/sessions/${sessionA.id}`, { cookieOverride: bCookie });
  assert.equal(r.status, 404, `cross-tenant session detail → ${r.status}`);

  // cross-tenant interrupt → 404, and the seeded in-flight job is untouched
  r = await call(`/api/v1/agent/sessions/${sessionA.id}/interrupt`, { method: 'POST', body: {}, cookieOverride: bCookie });
  assert.equal(r.status, 404, `cross-tenant interrupt → ${r.status}`);
  const jobRow = await pr.job.findUnique({ where: { id: runningJobId } });
  assert.equal(jobRow.status, 'running', 'the cross-tenant attempt left the in-flight job untouched');

  // the provider registry surface is tenant-independent data: still 200 for
  // tenant B (registry health only — no tenant rows, no credentials)
  r = await call('/api/v1/agent/providers', { cookieOverride: bCookie });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json));
  assert.ok(r.json.some((p) => p.id === 'zai'));
});
