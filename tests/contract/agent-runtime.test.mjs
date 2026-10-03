// ═══════════════════════════════════════════════════════════════════════════
// Agent Body/Soul production runtime tests (P6.C6 — Worker C lane) — node:test.
//
// PURE UNIT TESTS — no server boot, no network, no real keys, no database.
// Covers the runtime's pure half (lib/you/agent/runtime-core.ts — manifests,
// lifecycle, binding rules, capability enforcement, determinism, the turn
// engine with injected deps, the HTTP taxonomy) composed with the REAL
// resilience modules (core/retry.ts, core/deadletter.ts — the exact engine
// core/jobs.ts wraps executors in):
//
//   1. capability manifest — closed vocabulary, normalization (dedupe/sort),
//      auto-disclosed CANNOT complement (no silent overclaiming), typed 400s
//      on unknown tokens / malformed input;
//   2. lifecycle — activate/deactivate transitions with the typed 409
//      taxonomy on invalid transitions;
//   3. binding rules — active gates (409), conversation capability gates
//      (403 policy_blocked), twin-match law (409 binding conflict);
//   4. capability enforcement (the WO law) — decideToolInvocation matrix +
//      engine-level proof that a Soul cannot invoke an undeclared capability
//      (the tool seam is NEVER called; the refusal is recorded honestly);
//   5. resilience path — the engine composed with the REAL withRetries:
//      retryable chat failures retry then succeed (attempts recorded);
//      persistent retryable failures exhaust → dead-letter classification +
//      structured payload; non-retryable failures fail fast (NOT dead);
//   6. event emission — the engine's performance events (thinking → tool_use
//      → thinking → speaking) with real measured latencies from the injected
//      seam, enforcement visibility in tool_use payloads, seed provenance;
//   7. determinism — session/turn seeds, seeded default temperature band,
//      reproducible request construction (byte-identical system prompts);
//   8. API 4xx taxonomy — agentRuntimeHttpSpec maps every typed refusal to
//      the honest (status, code) pair, including the breaker's 503 with
//      retry-after guidance; unknown errors map to null (honest 500 path).
//
// Imported STATICALLY by tests/index.mjs — runs in the aggregated
// `node --test tests/` gate. No env mutations needed (retry knobs are passed
// explicitly, never read from env here).
// ═══════════════════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_CAPABILITY_VOCABULARY,
  AGENT_ENTITY_STATUSES,
  AgentRuntimeRefusal,
  agentNotFound,
  agentRuntimeHttpSpec,
  compileAgentSystemPrompt,
  decideLifecycleTransition,
  decideSessionBinding,
  decideToolInvocation,
  deriveSessionSeed,
  deriveTurnSeed,
  normalizeBehaviorParams,
  normalizeManifest,
  normalizePersona,
  parseEntityStatus,
  parseManifest,
  runAgentTurnEngine,
  seededDefaultTemperature,
  TOOL_CAPABILITIES,
} from '../../apps/web/src/lib/you/agent/runtime-core.ts';
import { withRetries, isRetryableError } from '../../apps/web/src/lib/you/core/retry.ts';
import { buildDeadLetterPayload, isDeadLetterOutcome } from '../../apps/web/src/lib/you/core/deadletter.ts';
import { ProviderUnavailableError } from '../../apps/web/src/lib/you/core/circuit-breaker.ts';

// ─── shared fixtures ─────────────────────────────────────────────────────────

const FULL_CAN = ['conversation', 'tool-use', 'evidence-request'];
const fullManifest = () => normalizeManifest(FULL_CAN);
const convoOnlyManifest = () => normalizeManifest(['conversation']);
const noConversationManifest = () => normalizeManifest(['tool-use']); // cannot converse

function makeBody(overrides = {}) {
  return {
    id: 'body_1',
    name: 'Twin Concierge',
    status: 'active',
    twinVersionId: 'tv_1',
    manifest: fullManifest(),
    ...overrides,
  };
}
function makeSoul(overrides = {}) {
  return {
    id: 'soul_1',
    name: 'Warm Host',
    status: 'active',
    twinId: 'twin_1',
    manifest: fullManifest(),
    ...overrides,
  };
}

function makeEngineInput(overrides = {}) {
  return {
    tenantId: 'tenant_1',
    sessionId: 'sess_1',
    twinId: 'twin_1',
    body: {
      name: 'Twin Concierge',
      role: 'host',
      description: 'greets and guides',
      version: 3,
      tools: ['twins.list', 'knowledge_search', 'evidence.request'],
      manifest: fullManifest(),
      twinVersionId: 'tv_1',
    },
    soul: {
      name: 'Warm Host',
      description: 'warm personality for the twin',
      version: 2,
      persona: normalizePersona({ tagline: 'Warm, unhurried', traits: ['warm', 'precise'] }),
      manifest: fullManifest(),
      params: normalizeBehaviorParams({ thinking: false, temperature: 0.4 }),
      provider: 'zai',
      model: 'glm-fast',
      twinDisplayName: 'Ada',
    },
    history: [],
    message: 'hello',
    turnSeed: 123456,
    ...overrides,
  };
}

/** Fixed deterministic deps: clock + uuid counters, scripted chat replies. */
function makeDeps({ replies = ['Hi there!'], latencies = [111], toolResults = [] } = {}) {
  let chatCall = 0;
  let uuidCall = 0;
  let toolCall = 0;
  const toolCallsSeen = [];
  return {
    deps: {
      chat: async (_messages, opts) => {
        const reply = replies[Math.min(chatCall, replies.length - 1)];
        chatCall += 1;
        return {
          content: typeof reply === 'function' ? reply(chatCall) : reply,
          latencyMs: latencies[Math.min(chatCall - 1, latencies.length - 1)] ?? 50,
          model: 'glm-fast',
        };
      },
      executeTool: async (ctx, call) => {
        toolCallsSeen.push({ ctx, call });
        const result = toolResults[Math.min(toolCall, toolResults.length - 1)];
        toolCall += 1;
        return {
          tool: call.tool,
          input: call.input,
          executed: true,
          effect: 'internal service call (test double)',
          result: result ?? { ok: true },
          durationMs: 42,
        };
      },
      now: () => 1700000000000,
      uuid: () => `evt-${(uuidCall += 1)}`,
    },
    getChatCalls: () => chatCall,
    getToolCallsSeen: () => toolCallsSeen,
  };
}

// ─── 1. Capability manifest ──────────────────────────────────────────────────

test('manifest: closed vocabulary is exactly the enforced set', () => {
  assert.deepEqual([...AGENT_CAPABILITY_VOCABULARY].sort(), ['conversation', 'evidence-request', 'tool-use']);
});

test('manifest: normalization dedupes + sorts and auto-discloses the CANNOT complement', () => {
  const m = normalizeManifest(['tool-use', 'conversation', 'tool-use', ' conversation ']);
  assert.deepEqual(m.can, ['conversation', 'tool-use']);
  assert.deepEqual(m.cannot, ['evidence-request']); // undeclared ⇒ disclosed limitation
});

test('manifest: declaring nothing claims nothing (honest default)', () => {
  const m = normalizeManifest(undefined);
  assert.deepEqual(m.can, []);
  assert.deepEqual([...m.cannot].sort(), [...AGENT_CAPABILITY_VOCABULARY].sort());
});

test('manifest: unknown capability token → typed 400 validation_failed', () => {
  assert.throws(
    () => normalizeManifest(['conversation', 'telepathy']),
    (err) => err instanceof AgentRuntimeRefusal && err.status === 400 && err.code === 'validation_failed',
  );
});

test('manifest: malformed input → typed 400 (array of strings required)', () => {
  for (const bad of ['conversation', 42, [{}, 'x'], [null]]) {
    assert.throws(
      () => normalizeManifest(bad),
      (err) => err instanceof AgentRuntimeRefusal && err.status === 400,
      `input ${JSON.stringify(bad)} must refuse`,
    );
  }
});

test('manifest: parseManifest is defensive on garbage (never throws, claims nothing)', () => {
  for (const garbage of [null, '', 'not json', '{"can":"nope"}', '{"can":[42,"conversation"]}']) {
    const m = parseManifest(garbage);
    assert.ok(Array.isArray(m.can) && Array.isArray(m.cannot));
    assert.ok(!m.can.includes(42));
  }
  const m = parseManifest('{"can":["conversation"]}');
  assert.deepEqual(m.can, ['conversation']);
  assert.deepEqual(m.cannot, ['tool-use', 'evidence-request']); // source vocabulary order
});

// ─── 2. Lifecycle ────────────────────────────────────────────────────────────

test('lifecycle: statuses parse defensively (garbage → draft)', () => {
  assert.equal(parseEntityStatus('active'), 'active');
  assert.equal(parseEntityStatus('inactive'), 'inactive');
  assert.equal(parseEntityStatus('bogus'), 'draft');
  assert.equal(parseEntityStatus(null), 'draft');
  assert.deepEqual([...AGENT_ENTITY_STATUSES], ['draft', 'active', 'inactive']);
});

test('lifecycle: draft → activate → deactivate → activate (the full legal cycle)', () => {
  assert.deepEqual(decideLifecycleTransition('draft', 'activate'), { ok: true, next: 'active' });
  assert.deepEqual(decideLifecycleTransition('active', 'deactivate'), { ok: true, next: 'inactive' });
  assert.deepEqual(decideLifecycleTransition('inactive', 'activate'), { ok: true, next: 'active' });
});

test('lifecycle: invalid transitions refuse with typed 409 conflict', () => {
  const alreadyActive = decideLifecycleTransition('active', 'activate');
  assert.equal(alreadyActive.ok, false);
  assert.equal(alreadyActive.refusal.status, 409);
  assert.equal(alreadyActive.refusal.code, 'conflict');
  assert.match(alreadyActive.refusal.message, /already active/);

  const deactivateDraft = decideLifecycleTransition('draft', 'deactivate');
  assert.equal(deactivateDraft.ok, false);
  assert.equal(deactivateDraft.refusal.status, 409);
  assert.match(deactivateDraft.refusal.message, /only an active entity can be deactivated/);
});

// ─── 3. Binding rules ────────────────────────────────────────────────────────

test('binding: happy path — active body + active soul, twin match, conversation declared', () => {
  const decision = decideSessionBinding({
    body: makeBody(),
    soul: makeSoul(),
    twinOfBodyVersion: 'twin_1',
  });
  assert.deepEqual(decision, { ok: true });
});

test('binding: abstract body (no TwinVersion) binds to any twin', () => {
  const decision = decideSessionBinding({
    body: makeBody({ twinVersionId: null }),
    soul: makeSoul(),
    twinOfBodyVersion: null,
  });
  assert.deepEqual(decision, { ok: true });
});

test('binding: non-active body/soul refuse with typed 409 naming the entity', () => {
  const bodyDraft = decideSessionBinding({ body: makeBody({ status: 'draft' }), soul: makeSoul(), twinOfBodyVersion: 'twin_1' });
  assert.equal(bodyDraft.ok, false);
  assert.equal(bodyDraft.refusal.status, 409);
  assert.match(bodyDraft.refusal.message, /body "Twin Concierge" is draft/);

  const soulInactive = decideSessionBinding({ body: makeBody(), soul: makeSoul({ status: 'inactive' }), twinOfBodyVersion: 'twin_1' });
  assert.equal(soulInactive.ok, false);
  assert.equal(soulInactive.refusal.status, 409);
  assert.match(soulInactive.refusal.message, /soul "Warm Host" is inactive/);
});

test('binding: a Soul without the conversation capability refuses with 403 policy_blocked', () => {
  const decision = decideSessionBinding({
    body: makeBody(),
    soul: makeSoul({ manifest: noConversationManifest() }),
    twinOfBodyVersion: 'twin_1',
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.refusal.status, 403);
  assert.equal(decision.refusal.code, 'policy_blocked');
  assert.match(decision.refusal.message, /does not declare the "conversation" capability/);
});

test('binding: a Body without the conversation capability refuses with 403 policy_blocked', () => {
  const decision = decideSessionBinding({
    body: makeBody({ manifest: normalizeManifest(['tool-use']) }),
    soul: makeSoul(),
    twinOfBodyVersion: 'twin_1',
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.refusal.status, 403);
  assert.equal(decision.refusal.code, 'policy_blocked');
  assert.match(decision.refusal.message, /body "Twin Concierge"/);
});

test('binding: twin mismatch between the Body TwinVersion and the Soul refuses with 409', () => {
  const decision = decideSessionBinding({
    body: makeBody(),
    soul: makeSoul({ twinId: 'twin_OTHER' }),
    twinOfBodyVersion: 'twin_1',
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.refusal.status, 409);
  assert.equal(decision.refusal.code, 'conflict');
  assert.match(decision.refusal.message, /binding conflict/);
  assert.deepEqual(decision.refusal.details, {
    bodyId: 'body_1',
    twinOfBodyVersion: 'twin_1',
    soulId: 'soul_1',
    soulTwinId: 'twin_OTHER',
  });
});

// ─── 4. Capability enforcement (the WO law) ─────────────────────────────────

test('enforcement: tool→capability mirror covers the W2.C registry tools', () => {
  assert.equal(TOOL_CAPABILITIES['twins.list'], 'tool-use');
  assert.equal(TOOL_CAPABILITIES.knowledge_search, 'tool-use');
  assert.equal(TOOL_CAPABILITIES['evidence.request'], 'evidence-request');
});

test('enforcement: allowed only when tool+capability declared by BOTH Body and Soul', () => {
  const allowed = decideToolInvocation('twins.list', fullManifest(), ['twins.list'], fullManifest());
  assert.deepEqual(allowed, { allowed: true, capability: 'tool-use' });
});

test('enforcement: unknown tool refused fail-closed', () => {
  const d = decideToolInvocation('time.travel', fullManifest(), ['time.travel'], fullManifest());
  assert.equal(d.allowed, false);
  assert.equal(d.capability, null);
  assert.equal(d.refusalKind, 'unknown-tool');
  assert.match(d.reason, /unknown tool "time.travel"/);
});

test('enforcement: tool not declared by the Body contract refused', () => {
  const d = decideToolInvocation('evidence.request', fullManifest(), [], fullManifest());
  assert.equal(d.allowed, false);
  assert.equal(d.refusalKind, 'body-undeclared-tool');
  assert.match(d.reason, /not declared by this Agent Body contract/);
});

test('enforcement (THE LAW): a Soul cannot invoke a capability it does not declare', () => {
  const d = decideToolInvocation(
    'evidence.request',
    convoOnlyManifest(), // Soul declares ONLY conversation
    ['evidence.request'], // the Body contract declares the tool
    fullManifest(), // and the Body manifest declares the capability
  );
  assert.equal(d.allowed, false);
  assert.equal(d.refusalKind, 'soul-undeclared-capability');
  assert.equal(d.capability, 'evidence-request');
  assert.match(d.reason, /capability "evidence-request".*is not declared by this Soul's manifest/);
});

test('enforcement: a Body manifest gap also refuses (least privilege on both sides)', () => {
  const d = decideToolInvocation('evidence.request', fullManifest(), ['evidence.request'], convoOnlyManifest());
  assert.equal(d.allowed, false);
  assert.equal(d.refusalKind, 'body-undeclared-capability');
  assert.match(d.reason, /is not declared by this Body's manifest/);
});

test('enforcement (engine-level): an undeclared Soul capability NEVER reaches the tool seam', async () => {
  const { deps, getToolCallsSeen } = makeDeps({
    replies: [
      'TOOL: evidence.request\nINPUT: {"twinId":"twin_1","capability":"hands"}',
      'I could not request evidence — that capability is not part of my manifest, so the runtime refused it. I said so instead of pretending.',
    ],
    latencies: [120, 130],
  });
  const input = makeEngineInput({
    soul: { ...makeEngineInput().soul, manifest: convoOnlyManifest() },
  });
  const out = await runAgentTurnEngine(deps, input);

  assert.equal(getToolCallsSeen().length, 0, 'the tool seam must NEVER be called for an undeclared capability');
  assert.equal(out.tools.length, 1);
  assert.equal(out.tools[0].executed, false);
  assert.match(out.tools[0].reason, /is not declared by this Soul's manifest/);
  assert.equal(out.llmCalls, 2); // draft + one grounded follow-up
  assert.match(out.reply, /refused/i);
});

test('enforcement (engine-level): a declared capability executes through the seam', async () => {
  const { deps, getToolCallsSeen } = makeDeps({
    replies: [
      'TOOL: twins.list\nINPUT: {"limit": 5}',
      'There are 2 twins in this tenant.',
    ],
    latencies: [100, 110],
    toolResults: [{ count: 2, twins: [] }],
  });
  const out = await runAgentTurnEngine(deps, makeEngineInput());
  assert.equal(getToolCallsSeen().length, 1);
  assert.equal(out.tools[0].executed, true);
  assert.equal(out.tools[0].durationMs, 42);
  assert.equal(out.llmCalls, 2);
});

// ─── 5. Resilience path (retry then deadletter) — the REAL engine ───────────

/** Mirror of the core/jobs.ts runner composition for one executor attempt. */
async function runTurnLikeTheJobRunner(execute, opts = {}) {
  return withRetries(execute, {
    maxAttempts: 3,
    baseDelayMs: 1,
    jitter: 0,
    budgetMs: 5000,
    sleep: async () => {}, // no wall-clock cost in tests
    ...opts,
  });
}

test('resilience: retryable chat failures retry then succeed (attempts recorded honestly)', async () => {
  let failures = 0;
  const { deps, getChatCalls } = makeDeps();
  const outcome = await runTurnLikeTheJobRunner(async () => {
    if (failures < 2) {
      failures += 1;
      throw Object.assign(new Error('fetch failed: zai chat error 503'), { status: 503 });
    }
    return runAgentTurnEngine(deps, makeEngineInput());
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.attempts, 3, 'two retryable failures + the successful third attempt');
  assert.equal(outcome.stoppedBy, 'succeeded');
  assert.equal(failures, 2);
  assert.equal(getChatCalls(), 1); // the engine ran exactly once (success attempt)
});

test('resilience: persistent retryable failure exhausts → dead-letter classification + payload', async () => {
  const { deps } = makeDeps();
  const outcome = await runTurnLikeTheJobRunner(async () => {
    await runAgentTurnEngine(
      {
        ...deps,
        chat: async () => {
          throw Object.assign(new Error('network timeout contacting the chat provider'), {
            name: 'TimeoutError',
          });
        },
      },
      makeEngineInput(),
    );
    throw new Error('unreachable');
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.stoppedBy, 'exhausted-attempts');
  assert.equal(outcome.attempts, 3);

  // the exact classification core/jobs.ts applies on the failure path
  assert.equal(isDeadLetterOutcome(outcome), true, 'exhausted retryable failures are dead-letter material');
  const payload = buildDeadLetterPayload(outcome);
  assert.equal(payload.code, 'dead_letter');
  assert.equal(payload.attempts, 3);
  assert.equal(payload.stoppedBy, 'exhausted-attempts');
  assert.equal(payload.lastError, 'network timeout contacting the chat provider');
  assert.ok(payload.firstAttemptAt.endsWith('Z'));
  assert.ok(payload.lastErrorAt.endsWith('Z'));
});

test('resilience: non-retryable failures (consent/validation class) fail FAST — never dead-lettered', async () => {
  const { deps } = makeDeps();
  let attempts = 0;
  const outcome = await runTurnLikeTheJobRunner(async () => {
    attempts += 1;
    // consent_required is an HttpError(403) at the route/executor boundary
    throw Object.assign(new Error('consent_required: no active consent grant with scope "embodiment"'), { status: 403 });
  });
  void deps;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.stoppedBy, 'non-retryable');
  assert.equal(outcome.attempts, 1, 'no retries for consent failures');
  assert.equal(isDeadLetterOutcome(outcome), false, 'a plain failed job, not dead — retrying cannot fix consent');
});

test('resilience: the shared classifier treats provider_unavailable as fail-fast (breaker owns recovery)', () => {
  const breakerErr = Object.assign(new Error('provider "zai" is unavailable (circuit breaker open)'), {
    code: 'provider_unavailable',
  });
  assert.equal(isRetryableError(breakerErr), false);
  assert.equal(isRetryableError(Object.assign(new Error('HTTP 429'), { status: 429 })), true);
  assert.equal(isRetryableError(Object.assign(new Error('boom'), { status: 400 })), false);
});

// ─── 6. Event emission ───────────────────────────────────────────────────────

test('events: no-tool turn emits exactly thinking → speaking with REAL measured latencies', async () => {
  const { deps } = makeDeps({ replies: ['Hello!'], latencies: [321] });
  const out = await runAgentTurnEngine(deps, makeEngineInput());
  assert.equal(out.events.length, 2);

  const [thinking, speaking] = out.events;
  assert.equal(thinking.type, 'thinking');
  assert.equal(thinking.source, 'llm');
  assert.equal(thinking.durationMs, 321, 'the REAL latency reported by the chat seam, verbatim');
  assert.equal(thinking.payload.turnSeed, 123456);
  assert.equal(thinking.payload.soulVersion, 2);
  assert.equal(thinking.payload.temperature, 0.4);
  assert.equal(thinking.payload.phase, 'reply-draft');

  assert.equal(speaking.type, 'speaking');
  assert.equal(speaking.source, 'llm');
  assert.equal(speaking.durationMs, null, 'playback duration is modeled later, never fabricated here');
  assert.equal(speaking.payload.llmCalls, 1);
  assert.equal(speaking.payload.turnSeed, 123456);
});

test('events: tool turn emits thinking → tool_use → thinking → speaking with enforcement visibility', async () => {
  const { deps } = makeDeps({
    replies: ['TOOL: twins.list\nINPUT: {"limit": 5}', 'Two twins.'],
    latencies: [100, 140],
    toolResults: [{ count: 2 }],
  });
  const out = await runAgentTurnEngine(deps, makeEngineInput());
  assert.deepEqual(out.events.map((e) => e.type), ['thinking', 'tool_use', 'thinking', 'speaking']);

  const toolEvent = out.events[1];
  assert.equal(toolEvent.source, 'application');
  assert.equal(toolEvent.durationMs, 42, 'real measured tool duration from the seam');
  assert.equal(toolEvent.payload.executed, true);
  assert.equal(toolEvent.payload.capability, 'tool-use');
  assert.equal(toolEvent.payload.round, 1);
  assert.match(toolEvent.payload.note, /body contract \+ Soul capability manifest enforced server-side/);

  const followUp = out.events[2];
  assert.equal(followUp.payload.phase, 'tool-followup');
  assert.equal(followUp.payload.tool, 'twins.list');
  assert.equal(followUp.payload.toolExecuted, true);
  assert.equal(out.latencyMs, 240, 'latency sums the REAL measured round-trips (100 + 140)');
});

test('events: refused tool invocations are recorded honestly (executed false + reason, never fabricated)', async () => {
  const { deps } = makeDeps({
    replies: ['TOOL: evidence.request\nINPUT: {"twinId":"twin_1"}', 'I cannot do that — honestly reported.'],
    latencies: [90, 80],
  });
  const out = await runAgentTurnEngine(deps, makeEngineInput({ soul: { ...makeEngineInput().soul, manifest: convoOnlyManifest() } }));
  const toolEvent = out.events[1];
  assert.equal(toolEvent.payload.executed, false);
  assert.equal(toolEvent.payload.result, null);
  assert.equal(toolEvent.payload.enforcement, 'soul-undeclared-capability');
  assert.match(toolEvent.payload.reason, /is not declared by this Soul's manifest/);
  assert.match(toolEvent.payload.note, /NOT executed — honest failure record/);
});

test('events: event ids + timestamps come from the injected clock/uuid (deterministic in tests)', async () => {
  const { deps } = makeDeps();
  const out = await runAgentTurnEngine(deps, makeEngineInput());
  assert.equal(out.events[0].eventId, 'evt-1');
  assert.equal(out.events[0].timestamp, new Date(1700000000000).toISOString());
});

// ─── 7. Determinism + reproducibility ───────────────────────────────────────

test('determinism: seeds are pure functions of their recorded inputs', () => {
  assert.equal(deriveSessionSeed('t', 's', 'b', '2026-10-03T00:00:00Z'), deriveSessionSeed('t', 's', 'b', '2026-10-03T00:00:00Z'));
  assert.notEqual(deriveSessionSeed('t', 's', 'b', '2026-10-03T00:00:00Z'), deriveSessionSeed('t', 's', 'b', '2026-10-03T00:00:01Z'));
  assert.equal(deriveTurnSeed(42, 0, 'turn_1'), deriveTurnSeed(42, 0, 'turn_1'));
  assert.notEqual(deriveTurnSeed(42, 0, 'turn_1'), deriveTurnSeed(42, 1, 'turn_1'));
});

test('determinism: every seed fits a SIGNED Int32 column (the live regression)', () => {
  // observed live during P6.C6 verification: an unsigned seed of 2963674284
  // failed the Prisma insert with "does not fit in an INT column" — every
  // derived seed must stay within [-2^31, 2^31) for the Int columns.
  const INT32_MIN = -(2 ** 31);
  const INT32_MAX = 2 ** 31;
  const inputs = [
    ['tenant', 'soul', 'body', '2026-10-03T00:00:00Z'],
    ['t2', 's2', 'b2', '2024-01-01T00:00:00.000Z'],
    ['', '', '', ''],
    ['x'.repeat(500), 'y'.repeat(500), 'z'.repeat(500), '2026-12-31T23:59:59.999Z'],
    ['t', '2963674284-ish-input', 'b', '2026-10-03T17:00:00Z'],
  ];
  for (const [tenant, soul, body, iso] of inputs) {
    const s = deriveSessionSeed(tenant, soul, body, iso);
    assert.ok(s >= INT32_MIN && s < INT32_MAX, `session seed ${s} fits Int32`);
    for (const ordinal of [0, 1, 999]) {
      const t = deriveTurnSeed(s, ordinal, `turn_${ordinal}`);
      assert.ok(t >= INT32_MIN && t < INT32_MAX, `turn seed ${t} fits Int32`);
    }
  }
  // brute-force confirmation over a wide hash slice: the | 0 mapping always lands in range
  for (let h = 0; h < 5000; h += 1) {
    const s = deriveTurnSeed(h | 0, h % 7, `id-${h}`);
    assert.ok(Number.isInteger(s) && s >= INT32_MIN && s < INT32_MAX);
  }
});

test('determinism: seeded default temperature is stable and bounded in [0.4, 0.8)', () => {
  for (const seed of [0, 1, 42, 999999, 2 ** 31 - 1, -1, -42, -(2 ** 31)]) {
    const t = seededDefaultTemperature(seed);
    const t2 = seededDefaultTemperature(seed);
    assert.equal(t, t2, 'same seed → same temperature');
    assert.ok(t >= 0.4 && t < 0.8, `temperature ${t} in band (seed ${seed})`);
  }
});

test('determinism: same snapshots + seed → byte-identical system prompt (reproducible request construction)', () => {
  const base = {
    body: makeEngineInput().body,
    soul: makeEngineInput().soul,
    turnSeed: 777,
    temperature: seededDefaultTemperature(777),
    thinking: false,
  };
  assert.equal(compileAgentSystemPrompt(base), compileAgentSystemPrompt({ ...base }));
  const other = compileAgentSystemPrompt({ ...base, soul: { ...base.soul, version: 3 } });
  assert.notEqual(compileAgentSystemPrompt(base), other, 'a different Soul version changes the prompt');
});

test('determinism: the engine records the requestParams that parameterized the turn', async () => {
  const { deps } = makeDeps();
  const out = await runAgentTurnEngine(deps, makeEngineInput());
  assert.deepEqual(out.requestParams, { thinking: false, temperature: 0.4, seed: 123456 });
});

test('determinism: an undeclared temperature derives from the turn seed (recorded, reproducible)', async () => {
  const { deps } = makeDeps();
  const input = makeEngineInput({ soul: { ...makeEngineInput().soul, params: {} } });
  const out = await runAgentTurnEngine(deps, input);
  assert.equal(out.requestParams.temperature, seededDefaultTemperature(123456));
  assert.equal(out.requestParams.seed, 123456);
});

test('determinism: the system prompt discloses both manifests and the persona (honest self-knowledge)', () => {
  const prompt = compileAgentSystemPrompt({
    body: makeEngineInput().body,
    soul: { ...makeEngineInput().soul, manifest: convoOnlyManifest() },
    turnSeed: 5,
    temperature: 0.5,
    thinking: true,
  });
  assert.match(prompt, /Capability manifest \(server-enforced/);
  assert.match(prompt, /- CAN: conversation, evidence-request, tool-use/);
  assert.match(prompt, /Warm Host/);
  assert.match(prompt, /turn seed 5/);
  assert.match(prompt, /never claim to be a real human/i);
});

// ─── 8. API 4xx taxonomy ────────────────────────────────────────────────────

test('taxonomy: every typed refusal maps to its honest (status, code) pair', () => {
  const cases = [
    [invalidManifestCase(), 400, 'validation_failed'],
    [lifecycleConflictCase(), 409, 'conflict'],
    [bindingStatusCase(), 409, 'conflict'],
    [bindingPolicyCase(), 403, 'policy_blocked'],
    [bindingConflictCase(), 409, 'conflict'],
    [agentNotFound('agent body "x"'), 404, 'not_found'],
  ];
  for (const [err, status, code] of cases) {
    const spec = agentRuntimeHttpSpec(err);
    assert.ok(spec, `a spec must exist for ${err.message}`);
    assert.equal(spec.status, status, `${err.message} → ${status}`);
    assert.equal(spec.code, code, `${err.message} → ${code}`);
    assert.equal(typeof spec.message, 'string');
  }
});

function invalidManifestCase() {
  try {
    normalizeManifest(['telepathy']);
  } catch (err) {
    return err;
  }
  throw new Error('unreachable');
}
function lifecycleConflictCase() {
  return decideLifecycleTransition('active', 'activate').refusal;
}
function bindingStatusCase() {
  return decideSessionBinding({ body: makeBody({ status: 'draft' }), soul: makeSoul(), twinOfBodyVersion: 'twin_1' }).refusal;
}
function bindingPolicyCase() {
  return decideSessionBinding({ body: makeBody(), soul: makeSoul({ manifest: noConversationManifest() }), twinOfBodyVersion: 'twin_1' }).refusal;
}
function bindingConflictCase() {
  return decideSessionBinding({ body: makeBody(), soul: makeSoul({ twinId: 'other' }), twinOfBodyVersion: 'twin_1' }).refusal;
}

test('taxonomy: the breaker fail-fast maps to 503 service_unavailable with retry-after guidance', () => {
  const breakerErr = new ProviderUnavailableError('zai', 'open', 45000, 'cooldown has not elapsed');
  const spec = agentRuntimeHttpSpec(breakerErr);
  assert.ok(spec);
  assert.equal(spec.status, 503);
  assert.equal(spec.code, 'service_unavailable');
  assert.equal(spec.details.provider, 'zai');
  assert.equal(spec.details.breakerState, 'open');
  assert.equal(spec.details.retryAfterSeconds, 45);
  assert.equal(spec.headers['retry-after'], '45');
  assert.match(spec.message, /unavailable/);
});

test('taxonomy: unknown errors map to null — the honest 500 path, never rewritten', () => {
  assert.equal(agentRuntimeHttpSpec(new Error('a real database error')), null);
  assert.equal(agentRuntimeHttpSpec('string error'), null);
  assert.equal(agentRuntimeHttpSpec(null), null);
});

// ─── persona / params validation ─────────────────────────────────────────────

test('persona: normalization bounds and dedupes traits, drops garbage', () => {
  const p = normalizePersona({
    tagline: '  Warm host  ',
    traits: ['warm', 'warm', 42, '  precise  ', ''],
    speakingStyle: 'short sentences',
  });
  assert.equal(p.tagline, 'Warm host');
  assert.deepEqual(p.traits, ['warm', 'precise']);
  assert.equal(p.speakingStyle, 'short sentences');
  assert.equal(p.additionalInstructions, undefined);
  assert.deepEqual(normalizePersona(null).traits, []);
  assert.deepEqual(normalizePersona('nope').traits, []);
});

test('params: temperature outside [0, 2] refuses with typed 400; thinking must be boolean', () => {
  assert.deepEqual(normalizeBehaviorParams({ thinking: true, temperature: 0.7 }), { thinking: true, temperature: 0.7 });
  assert.deepEqual(normalizeBehaviorParams({}), {});
  assert.deepEqual(normalizeBehaviorParams({ thinking: 'yes' }), {});
  assert.throws(
    () => normalizeBehaviorParams({ temperature: 3 }),
    (err) => err instanceof AgentRuntimeRefusal && err.status === 400,
  );
  assert.throws(
    () => normalizeBehaviorParams({ temperature: -0.1 }),
    (err) => err instanceof AgentRuntimeRefusal && err.status === 400,
  );
});

// ─── protocol reuse (the extraction is live) ─────────────────────────────────

test('protocol: the engine speaks the same TOOL:/INPUT: protocol as the legacy avatar runtime', async () => {
  // a reply WITHOUT the explicit protocol line never triggers a tool round
  const { deps, getToolCallsSeen } = makeDeps({ replies: ['Maybe I could list twins for you sometime.'] });
  const out = await runAgentTurnEngine(deps, makeEngineInput());
  assert.equal(getToolCallsSeen().length, 0);
  assert.equal(out.tools.length, 0);
  assert.equal(out.events.length, 2); // thinking → speaking only
});
