// ═══════════════════════════════════════════════════════════════════════════
// Live session runtime tests (P6.C7 — Worker C lane) — node:test.
//
// PURE UNIT TESTS — no server boot, no network, no real keys, no database.
// Covers the live runtime's pure half (lib/you/live/live-core.ts — the
// consent + binding decision, the signaling state machine, idempotent state
// events, connection transitions, agent-state mapping, signaling tokens,
// the HTTP taxonomy) composed exactly the way the server half folds them
// (parseSignalingState → decide → apply → persist), including a tenant-
// isolation harness that mirrors the routes' findFirst({ id, tenantId })
// scoping law:
//
//   1. consent enforcement — create without a covering grant → honest 403
//      consent_required (missing / revoked / expired / wrong scope / wrong
//      subject); no binding at all → 400; ended agent session → 409;
//      twin/agent binding mismatch → 409; covering grant → ok with the
//      grant id recorded as provenance;
//   2. signaling state machine — offer → answer ordering, honest 409s on
//      every wrong-phase/wrong-role message (answer before offer, second
//      offer, candidates before descriptions, answer from the offerer),
//      terminal sessions refuse everything, candidate seq assignment,
//      the candidate cap, message validation (role/sdp/candidate bounds);
//   3. state-event idempotency — same key returns the original event and
//      appends nothing; the ring and key map are bounded (oldest evicted);
//   4. end/close transitions — connection reports drive connecting → live /
//      failed / ended; terminal is terminal (post-terminal reports are
//      ignored — no resurrection); live is never demoted by transient
//      connecting reports; duplicate teardown is idempotent;
//   5. tenant isolation — the harness composes the exact route fold with
//      tenant-scoped lookup: another tenant's reads/writes are honestly
//      not_found, never a leak;
//   6. agentSession binding validation + the agent → live state mapping —
//      the C6 turn sequence (listening → engine events → idle), 'custom'
//      events skipped honestly, the P4 surface-state set is exact;
//   7. signaling tokens — HMAC sign/verify, tamper and wrong-session
//      refusals, expiry, malformed input;
//   8. HTTP taxonomy — LiveSessionRefusal → the standard envelope spec;
//      unknown errors map to null (the honest 500 path).
//
// Imported STATICALLY by tests/index.mjs — runs in the aggregated
// `node --test tests/` gate. No env mutations (the secret is passed
// explicitly to every token call).
// ═══════════════════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LIVE_PERFORMANCE_STATES,
  LiveSessionRefusal,
  MAX_SIGNALING_CANDIDATES,
  MAX_STATE_EVENTS,
  MAX_PROCESSED_KEYS,
  agentEventToLiveState,
  agentTurnLiveStateSequence,
  appendStateEvent,
  applyConnectionTransition,
  applySignalingMessage,
  decideCreateLiveSession,
  decideSignalMessage,
  emptySignalingState,
  liveNotFound,
  liveSessionHttpSpec,
  normalizePerformanceDelta,
  normalizeSignalingMessage,
  parseLiveSessionStatus,
  parseSignalingState,
  signSignalingToken,
  verifySignalingToken,
  SIGNALING_TOKEN_TTL_MS,
} from '../../apps/web/src/lib/you/live/live-core.ts';

const SECRET = 'test-signaling-secret';
const NOW = new Date('2026-10-04T12:00:00.000Z');
const NOW_MS = NOW.getTime();

// ─── shared fixtures ─────────────────────────────────────────────────────────

const TWIN = { id: 'twin_1', displayName: 'Ada', subjectId: 'subject_1' };
const AGENT_SESSION = {
  id: 'agent_session_1',
  status: 'live',
  twinId: 'twin_1',
  twinSubjectId: 'subject_1',
};

function makeGrant(overrides = {}) {
  return {
    id: 'grant_1',
    subjectId: 'subject_1',
    scopes: ['embodiment'],
    revokedAt: null,
    expiresAt: new Date(NOW_MS + 60 * 60 * 1000),
    ...overrides,
  };
}

function refuseWith(decision, status, code) {
  assert.equal(decision.ok, false, 'decision must refuse');
  assert.ok(decision.refusal instanceof LiveSessionRefusal, 'typed refusal');
  assert.equal(decision.refusal.status, status);
  assert.equal(decision.refusal.code, code);
}

// ─── 1. Consent enforcement (create without grant → honest 4xx) ─────────────

test('live create: no binding at all → 400 validation_failed (consent provenance needs a subject)', () => {
  refuseWith(decideCreateLiveSession({ twin: null, agentSession: null, grant: makeGrant(), now: NOW }), 400, 'validation_failed');
});

test('live create (twin-bound): no grant → honest 403 consent_required — a live session cannot open', () => {
  const decision = decideCreateLiveSession({ twin: TWIN, agentSession: null, grant: null, now: NOW });
  refuseWith(decision, 403, 'consent_required');
  assert.match(decision.refusal.message, /live performance/);
  assert.deepEqual(decision.refusal.details, { subjectId: 'subject_1', scope: 'embodiment', requiredScopes: ['embodiment'] });
});

test('live create (agent-bound): no grant → honest 403 consent_required', () => {
  refuseWith(
    decideCreateLiveSession({ twin: null, agentSession: AGENT_SESSION, grant: null, now: NOW }),
    403,
    'consent_required',
  );
});

test('live create: revoked grant → 403 (a live session cannot open on a revoked grant)', () => {
  refuseWith(
    decideCreateLiveSession({ twin: TWIN, agentSession: null, grant: makeGrant({ revokedAt: new Date(NOW_MS - 1000) }), now: NOW }),
    403,
    'consent_required',
  );
});

test('live create: expired grant → 403 naming the expiry', () => {
  const decision = decideCreateLiveSession({
    twin: TWIN,
    agentSession: null,
    grant: makeGrant({ expiresAt: new Date(NOW_MS - 1) }),
    now: NOW,
  });
  refuseWith(decision, 403, 'consent_required');
  assert.match(decision.refusal.message, /expired/);
});

test('live create: grant without the embodiment scope → 403 (does not cover live performance)', () => {
  const decision = decideCreateLiveSession({
    twin: TWIN,
    agentSession: null,
    grant: makeGrant({ scopes: ['capture', 'render'] }),
    now: NOW,
  });
  refuseWith(decision, 403, 'consent_required');
  assert.match(decision.refusal.message, /does not cover live performance/);
});

test('live create: grant covering another subject → 403 (the grant must cover the performed twin)', () => {
  refuseWith(
    decideCreateLiveSession({ twin: TWIN, agentSession: null, grant: makeGrant({ subjectId: 'subject_other' }), now: NOW }),
    403,
    'consent_required',
  );
});

test('live create: covering grant → ok, twinId + consentGrantId recorded as provenance', () => {
  const decision = decideCreateLiveSession({ twin: TWIN, agentSession: null, grant: makeGrant(), now: NOW });
  assert.equal(decision.ok, true);
  assert.equal(decision.twinId, 'twin_1');
  assert.equal(decision.consentGrantId, 'grant_1');
});

test('live create: agent-session-only binding derives twinId from the agent session (same consent law)', () => {
  const decision = decideCreateLiveSession({ twin: null, agentSession: AGENT_SESSION, grant: makeGrant(), now: NOW });
  assert.equal(decision.ok, true);
  assert.equal(decision.twinId, 'twin_1');
});

// ─── 6a. agentSession binding validation ────────────────────────────────────

test('agent binding: an ENDED agent session cannot drive a live session → 409', () => {
  refuseWith(
    decideCreateLiveSession({
      twin: null,
      agentSession: { ...AGENT_SESSION, status: 'ended' },
      grant: makeGrant(),
      now: NOW,
    }),
    409,
    'conflict',
  );
});

test('agent binding: twin and agent session pointing at different twins → 409 binding conflict', () => {
  const decision = decideCreateLiveSession({
    twin: TWIN,
    agentSession: { ...AGENT_SESSION, twinId: 'twin_2' },
    grant: makeGrant(),
    now: NOW,
  });
  refuseWith(decision, 409, 'conflict');
  assert.deepEqual(decision.refusal.details, { twinId: 'twin_1', agentSessionTwinId: 'twin_2' });
});

// ─── 2. Signaling state machine (offer→answer ordering, honest 409s) ────────

const machine = (phase, status = 'connecting', offerFrom = null) => ({ phase, status, offerFrom });
const offer = (from = 'initiator') => normalizeSignalingMessage({ kind: 'offer', from, sdp: 'v=0 offer-sdp' }, NOW);
const answer = (from = 'responder') => normalizeSignalingMessage({ kind: 'answer', from, sdp: 'v=0 answer-sdp' }, NOW);
const candidate = (from = 'initiator', i = 1) =>
  normalizeSignalingMessage({ kind: 'candidate', from, candidate: `candidate:${i} udp 1 192.168.1.4 ${1000 + i} typ host`, sdpMid: '0', sdpMLineIndex: 0 }, NOW);

test('signaling: offer accepted in phase new → offered', () => {
  const d = decideSignalMessage(machine('new'), offer());
  assert.equal(d.ok, true);
  assert.equal(d.nextPhase, 'offered');
});

test('signaling: answer before any offer → honest 409 (initiator sends the offer first)', () => {
  const d = decideSignalMessage(machine('new'), answer());
  assert.equal(d.ok, false);
  assert.equal(d.refusal.status, 409);
  assert.match(d.refusal.message, /no offer has been relayed/);
});

test('signaling: answer after offer (opposite role) → answered', () => {
  const d = decideSignalMessage(machine('offered', 'connecting', 'initiator'), answer('responder'));
  assert.equal(d.ok, true);
  assert.equal(d.nextPhase, 'answered');
});

test('signaling: answer from the SAME role that sent the offer → 409', () => {
  const d = decideSignalMessage(machine('offered', 'connecting', 'initiator'), answer('initiator'));
  assert.equal(d.ok, false);
  assert.equal(d.refusal.status, 409);
  assert.match(d.refusal.message, /must come from the peer that received the offer/);
});

test('signaling: second offer → 409 (v1 relays a single offer/answer exchange)', () => {
  for (const phase of ['offered', 'answered', 'connected']) {
    const d = decideSignalMessage(machine(phase), offer());
    assert.equal(d.ok, false, `phase ${phase} must refuse a second offer`);
    assert.equal(d.refusal.status, 409);
    assert.match(d.refusal.message, /single offer\/answer exchange/);
  }
});

test('signaling: candidates before any offer/answer → 409', () => {
  const d = decideSignalMessage(machine('new'), candidate());
  assert.equal(d.ok, false);
  assert.equal(d.refusal.status, 409);
  assert.match(d.refusal.message, /trickled ICE candidates are relayed only after/);
});

test('signaling: candidates accepted after the offer AND after the answer (phase unchanged)', () => {
  for (const phase of ['offered', 'answered', 'connected']) {
    const d = decideSignalMessage(machine(phase), candidate());
    assert.equal(d.ok, true, `phase ${phase} accepts candidates`);
    assert.equal(d.nextPhase, phase);
  }
});

test('signaling: ended sessions refuse EVERYTHING (terminal is terminal)', () => {
  for (const message of [offer(), answer(), candidate()]) {
    const d = decideSignalMessage(machine('answered', 'ended'), message);
    assert.equal(d.ok, false, `ended must refuse ${message.kind}`);
    assert.equal(d.refusal.status, 409);
    assert.match(d.refusal.message, /ended|failed/);
  }
});

test('signaling: failed sessions refuse everything with the honest retry guidance', () => {
  const d = decideSignalMessage(machine('answered', 'failed'), candidate());
  assert.equal(d.ok, false);
  assert.match(d.refusal.message, /open a new session to retry/);
});

test('signaling: applySignalingMessage assigns candidate seqs and persists offer/answer verbatim', () => {
  let state = emptySignalingState();
  state = applySignalingMessage(state, offer(), 'offered');
  assert.equal(state.phase, 'offered');
  assert.equal(state.offer.sdp, 'v=0 offer-sdp');
  assert.equal(state.offer.from, 'initiator');
  state = applySignalingMessage(state, answer(), 'answered');
  assert.equal(state.answer.sdp, 'v=0 answer-sdp');
  state = applySignalingMessage(state, candidate(), 'answered');
  state = applySignalingMessage(state, candidate('responder', 2), 'answered');
  assert.deepEqual(state.candidates.map((c) => c.seq), [1, 2]);
  assert.equal(state.nextSeq, 3);
  // round-trips through the persisted JSON shape
  const parsed = parseSignalingState(JSON.stringify(state));
  assert.equal(parsed.phase, 'answered');
  assert.equal(parsed.candidates.length, 2);
  assert.equal(parsed.offer.sdp, 'v=0 offer-sdp');
});

test('signaling: candidate cap → honest 409 at MAX_SIGNALING_CANDIDATES', () => {
  let state = emptySignalingState();
  state = applySignalingMessage(state, offer(), 'offered');
  for (let i = 0; i < MAX_SIGNALING_CANDIDATES; i += 1) {
    state = applySignalingMessage(state, candidate('initiator', i + 1), 'offered');
  }
  assert.equal(state.candidates.length, MAX_SIGNALING_CANDIDATES);
  assert.throws(
    () => applySignalingMessage(state, candidate('responder', 9999), 'offered'),
    (err) => err instanceof LiveSessionRefusal && err.status === 409 && /maximum/.test(err.message),
  );
});

test('signaling: message validation — honest 400s (bad role, empty sdp, oversized sdp, unknown kind, empty candidate)', () => {
  assert.throws(() => normalizeSignalingMessage({ kind: 'offer', from: 'spy', sdp: 'x' }, NOW), (e) => e.status === 400 && /initiator.*responder|responder.*initiator/.test(e.message));
  assert.throws(() => normalizeSignalingMessage({ kind: 'offer', from: 'initiator', sdp: '' }, NOW), (e) => e.status === 400 && /sdp/.test(e.message));
  assert.throws(() => normalizeSignalingMessage({ kind: 'offer', from: 'initiator', sdp: 'x'.repeat(64 * 1024 + 1) }, NOW), (e) => e.status === 400 && /exceeds/.test(e.message));
  assert.throws(() => normalizeSignalingMessage({ kind: 'renegotiate', from: 'initiator', sdp: 'x' }, NOW), (e) => e.status === 400 && /"offer", "answer" or "candidate"/.test(e.message));
  assert.throws(() => normalizeSignalingMessage({ kind: 'candidate', from: 'initiator', candidate: '' }, NOW), (e) => e.status === 400 && /candidate/.test(e.message));
});

test('signaling: parseSignalingState degrades garbage to the empty state (never throws)', () => {
  for (const garbage of [null, '', 'not json', '{"phase":"weird"}', '{"candidates":"no"}', '{"stateEvents":[null,42]}']) {
    const parsed = parseSignalingState(garbage);
    assert.equal(parsed.phase, 'new');
    assert.equal(parsed.candidates.length, 0);
    assert.equal(parsed.stateEvents.length, 0);
  }
});

// ─── 3. State-event idempotency ─────────────────────────────────────────────

function makeEvent(eventId, seq) {
  return { eventId, seq, kind: 'agent', state: 'thinking', delta: null, source: 'client', timestamp: NOW.toISOString() };
}

test('state events: a replayed idempotency key returns the ORIGINAL event and appends nothing', () => {
  let state = emptySignalingState();
  const first = appendStateEvent(state, makeEvent('evt-1', 1), 'key-A');
  assert.equal(first.duplicate, false);
  assert.equal(first.eventId, 'evt-1');
  const replay = appendStateEvent(first.state, makeEvent('evt-2', 2), 'key-A');
  assert.equal(replay.duplicate, true);
  assert.equal(replay.eventId, 'evt-1'); // the original, never the new one
  assert.equal(replay.state.stateEvents.length, 1);
});

test('state events: different keys append distinct events with increasing seq', () => {
  let state = emptySignalingState();
  state = appendStateEvent(state, makeEvent('evt-1', 1), 'key-A').state;
  state = appendStateEvent(state, makeEvent('evt-2', 2), 'key-B').state;
  assert.equal(state.stateEvents.length, 2);
  assert.deepEqual(state.stateEvents.map((e) => e.seq), [1, 2]);
});

test('state events: the ring is bounded — oldest evicted at MAX_STATE_EVENTS', () => {
  let state = emptySignalingState();
  for (let i = 0; i < MAX_STATE_EVENTS + 25; i += 1) {
    state = appendStateEvent(state, makeEvent(`evt-${i}`, i + 1)).state;
  }
  assert.equal(state.stateEvents.length, MAX_STATE_EVENTS);
  assert.equal(state.stateEvents[0].eventId, `evt-${25}`); // the first 25 were evicted
  assert.equal(state.stateEvents[state.stateEvents.length - 1].eventId, `evt-${MAX_STATE_EVENTS + 24}`);
});

test('state events: the idempotency key map is bounded (oldest evicted)', () => {
  let state = emptySignalingState();
  for (let i = 0; i < MAX_PROCESSED_KEYS + 10; i += 1) {
    state = appendStateEvent(state, makeEvent(`evt-${i}`, i + 1), `key-${i}`).state;
  }
  const keys = Object.keys(state.processedKeys);
  assert.equal(keys.length, MAX_PROCESSED_KEYS);
  assert.equal(state.processedKeys['key-0'], undefined); // evicted
  assert.equal(state.processedKeys[`key-${MAX_PROCESSED_KEYS + 9}`], `evt-${MAX_PROCESSED_KEYS + 9}`);
});

// ─── 4. End/close transitions ────────────────────────────────────────────────

test('connection: connecting → connected makes the session LIVE (phase connected)', () => {
  const t = applyConnectionTransition('connecting', 'offered', 'connected');
  assert.deepEqual(t, { status: 'live', phase: 'connected', ignored: false, statusChanged: true });
});

test('connection: a repeated connected report changes nothing (no duplicate transition)', () => {
  const t = applyConnectionTransition('live', 'connected', 'connected');
  assert.equal(t.status, 'live');
  assert.equal(t.statusChanged, false);
});

test('connection: failed is honest and terminal-in-v1', () => {
  const t = applyConnectionTransition('connecting', 'offered', 'failed');
  assert.deepEqual(t, { status: 'failed', phase: 'offered', ignored: false, statusChanged: true });
});

test('connection: closed → ended with the closed phase', () => {
  const t = applyConnectionTransition('connecting', 'answered', 'closed');
  assert.deepEqual(t, { status: 'ended', phase: 'closed', ignored: false, statusChanged: true });
});

test('connection: post-terminal reports are IGNORED — no resurrection, ever', () => {
  for (const report of ['connected', 'connecting', 'closed']) {
    const ended = applyConnectionTransition('ended', 'closed', report);
    assert.deepEqual(ended, { status: 'ended', phase: 'closed', ignored: true, statusChanged: false });
    const failed = applyConnectionTransition('failed', 'answered', report);
    assert.deepEqual(failed, { status: 'failed', phase: 'answered', ignored: true, statusChanged: false });
  }
});

test('connection: a live session is never demoted by a transient connecting report', () => {
  const t = applyConnectionTransition('live', 'connected', 'connecting');
  assert.equal(t.status, 'live');
  assert.equal(t.statusChanged, false);
});

test('connection: parseLiveSessionStatus defaults unknown statuses to connecting (honest)', () => {
  assert.equal(parseLiveSessionStatus('live'), 'live');
  assert.equal(parseLiveSessionStatus(null), 'connecting');
  assert.equal(parseLiveSessionStatus('bogus'), 'connecting');
});

// ─── 5. Tenant isolation (the route fold, tenant-scoped) ─────────────────────

/**
 * Mirrors the routes' composition: findFirst({ where: { id, tenantId } }) →
 * token check → the pure state machine folds. Cross-tenant access behaves
 * EXACTLY like a missing session — an honest not_found, never a leak.
 */
function makeTenantHarness() {
  const rows = new Map(); // `${tenantId}:${id}` → { id, tenantId, status, signaling }
  return {
    create(tenantId, id, status = 'connecting') {
      const session = { id, tenantId, status, signaling: JSON.stringify(emptySignalingState()) };
      rows.set(`${tenantId}:${id}`, session);
      return session;
    },
    findFirst(tenantId, id) {
      return rows.get(`${tenantId}:${id}`) ?? null;
    },
    relaySignal(tenantId, id, messageInput, token) {
      const session = this.findFirst(tenantId, id);
      if (!session) return { refusal: liveNotFound(`live session "${id}" not found`) };
      const check = verifySignalingToken(SECRET, token, session.id, NOW);
      if (!check.ok) return { refusal: check.refusal };
      const message = normalizeSignalingMessage(messageInput, NOW);
      const state = parseSignalingState(session.signaling);
      const decision = decideSignalMessage(
        { phase: state.phase, status: parseLiveSessionStatus(session.status), offerFrom: state.offer?.from ?? null },
        message,
      );
      if (!decision.ok) return { refusal: decision.refusal };
      const next = applySignalingMessage(state, message, decision.nextPhase);
      session.signaling = JSON.stringify(next);
      return { phase: decision.nextPhase };
    },
  };
}

test('tenant isolation: another tenant cannot relay signals into tenant A\'s session (not_found, not 403)', () => {
  const h = makeTenantHarness();
  h.create('tenant_A', 'live_1');
  const token = signSignalingToken(SECRET, 'live_1', NOW);
  // tenant B holds the VALID token (a leak scenario) — the tenant scope still refuses
  const result = h.relaySignal('tenant_B', 'live_1', { kind: 'offer', from: 'initiator', sdp: 'v=0 x' }, token);
  assert.ok(result.refusal instanceof LiveSessionRefusal);
  assert.equal(result.refusal.status, 404);
  assert.equal(result.refusal.code, 'not_found');
});

test('tenant isolation: same tenant + valid token relays the offer fine', () => {
  const h = makeTenantHarness();
  h.create('tenant_A', 'live_1');
  const token = signSignalingToken(SECRET, 'live_1', NOW);
  const result = h.relaySignal('tenant_A', 'live_1', { kind: 'offer', from: 'initiator', sdp: 'v=0 x' }, token);
  assert.deepEqual(result, { phase: 'offered' });
});

test('tenant isolation: distinct tenants with the same session id are distinct rows (no cross-talk)', () => {
  const h = makeTenantHarness();
  h.create('tenant_A', 'live_1');
  h.create('tenant_B', 'live_1');
  const tokenA = signSignalingToken(SECRET, 'live_1', NOW);
  assert.deepEqual(h.relaySignal('tenant_A', 'live_1', { kind: 'offer', from: 'initiator', sdp: 'v=0 A' }, tokenA), { phase: 'offered' });
  // tenant B's own row is untouched — still phase new
  const bRow = h.findFirst('tenant_B', 'live_1');
  assert.equal(parseSignalingState(bRow.signaling).phase, 'new');
  const tokenB = signSignalingToken(SECRET, 'live_1', NOW);
  assert.deepEqual(h.relaySignal('tenant_B', 'live_1', { kind: 'offer', from: 'initiator', sdp: 'v=0 B' }, tokenB), { phase: 'offered' });
  assert.equal(parseSignalingState(h.findFirst('tenant_A', 'live_1').signaling).offer.sdp, 'v=0 A');
});

// ─── 6b. Agent turn states → live surface states (the C6 binding) ───────────

test('agent mapping: LIVE_PERFORMANCE_STATES is exactly the P4 surface-state set', () => {
  assert.deepEqual([...LIVE_PERFORMANCE_STATES].sort(), [
    'idle', 'interrupted', 'listening', 'reading', 'speaking', 'thinking', 'tool_use', 'typing', 'unavailable',
  ]);
});

test('agent mapping: the per-turn sequence is listening → engine events → idle', () => {
  const engineEvents = [
    { eventId: 'e1', sessionId: 's', type: 'thinking', timestamp: NOW.toISOString(), durationMs: 100, source: 'llm' },
    { eventId: 'e2', sessionId: 's', type: 'tool_use', timestamp: NOW.toISOString(), durationMs: 40, source: 'application' },
    { eventId: 'e3', sessionId: 's', type: 'thinking', timestamp: NOW.toISOString(), durationMs: 90, source: 'llm' },
    { eventId: 'e4', sessionId: 's', type: 'speaking', timestamp: NOW.toISOString(), durationMs: null, source: 'llm' },
  ];
  assert.deepEqual(agentTurnLiveStateSequence(engineEvents), [
    'listening', 'thinking', 'tool_use', 'thinking', 'speaking', 'idle',
  ]);
});

test('agent mapping: custom events have NO honest surface mapping (skipped, not invented)', () => {
  assert.equal(agentEventToLiveState({ eventId: 'e', sessionId: 's', type: 'custom', timestamp: NOW.toISOString(), durationMs: null, source: 'user' }), null);
  const sequence = agentTurnLiveStateSequence([
    { eventId: 'e', sessionId: 's', type: 'custom', timestamp: NOW.toISOString(), durationMs: null, source: 'user' },
  ]);
  assert.deepEqual(sequence, ['listening', 'idle']);
});

// ─── Performance delta validation ────────────────────────────────────────────

test('performance deltas: valid fields normalize (bounded rounding)', () => {
  const d = normalizePerformanceDelta({ gaze: { x: 0.123456, y: -0.9 }, expression: 'smile', speech: 'hello there', intensity: 0.45678 });
  assert.deepEqual(d, { gaze: { x: 0.123, y: -0.9 }, expression: 'smile', speech: 'hello there', intensity: 0.457 });
});

test('performance deltas: honest 400s (empty delta, out-of-range gaze, garbage gaze, oversized fields, bad intensity)', () => {
  assert.throws(() => normalizePerformanceDelta({}), (e) => e.status === 400 && /at least one/.test(e.message));
  assert.throws(() => normalizePerformanceDelta({ gaze: { x: 1.5, y: 0 } }), (e) => e.status === 400 && /\[-1, 1\]/.test(e.message));
  assert.throws(() => normalizePerformanceDelta({ gaze: { x: 'no', y: 0 } }), (e) => e.status === 400 && /x: number/.test(e.message));
  assert.throws(() => normalizePerformanceDelta({ expression: 'x'.repeat(61) }), (e) => e.status === 400 && /expression exceeds/.test(e.message));
  assert.throws(() => normalizePerformanceDelta({ speech: 'x'.repeat(501) }), (e) => e.status === 400 && /speech exceeds/.test(e.message));
  assert.throws(() => normalizePerformanceDelta({ intensity: 1.2 }), (e) => e.status === 400 && /\[0, 1\]/.test(e.message));
});

// ─── 7. Signaling tokens ─────────────────────────────────────────────────────

test('signaling token: sign → verify ok with the documented TTL', () => {
  const token = signSignalingToken(SECRET, 'live_1', NOW);
  const check = verifySignalingToken(SECRET, token, 'live_1', NOW);
  assert.equal(check.ok, true);
  assert.equal(check.expiresAtMs, NOW_MS + SIGNALING_TOKEN_TTL_MS);
});

test('signaling token: a tampered signature is refused (401)', () => {
  const token = signSignalingToken(SECRET, 'live_1', NOW);
  const tampered = `v1.${token.split('.')[1]}.deadbeef`;
  const check = verifySignalingToken(SECRET, tampered, 'live_1', NOW);
  assert.equal(check.ok, false);
  assert.equal(check.refusal.status, 401);
  assert.match(check.refusal.message, /signature mismatch/);
});

test('signaling token: a token minted for ANOTHER session is refused (401, session-bound)', () => {
  const token = signSignalingToken(SECRET, 'live_1', NOW);
  const check = verifySignalingToken(SECRET, token, 'live_2', NOW);
  assert.equal(check.ok, false);
  assert.match(check.refusal.message, /not valid for this session/);
});

test('signaling token: expiry is honest (401 naming the expiry instant)', () => {
  const token = signSignalingToken(SECRET, 'live_1', NOW);
  const later = new Date(NOW_MS + SIGNALING_TOKEN_TTL_MS + 1);
  const check = verifySignalingToken(SECRET, token, 'live_1', later);
  assert.equal(check.ok, false);
  assert.equal(check.refusal.status, 401);
  assert.match(check.refusal.message, /expired/);
});

test('signaling token: malformed tokens are refused honestly (401)', () => {
  for (const bad of ['', 'nope', 'v1', 'v1.notanumber.sig', 'v2.123.sig']) {
    const check = verifySignalingToken(SECRET, bad, 'live_1', NOW);
    assert.equal(check.ok, false, `token ${JSON.stringify(bad)} must refuse`);
    assert.equal(check.refusal.status, 401);
  }
});

// ─── 8. HTTP taxonomy ────────────────────────────────────────────────────────

test('http taxonomy: LiveSessionRefusal maps to the standard envelope spec', () => {
  const spec = liveSessionHttpSpec(new LiveSessionRefusal(409, 'conflict', 'wrong phase', { phase: 'new' }));
  assert.deepEqual(spec, { status: 409, code: 'conflict', message: 'wrong phase', details: { phase: 'new' } });
  const noDetails = liveSessionHttpSpec(new LiveSessionRefusal(403, 'consent_required', 'no grant'));
  assert.deepEqual(noDetails, { status: 403, code: 'consent_required', message: 'no grant' });
});

test('http taxonomy: unknown errors map to null (the honest 500 path — never rewritten)', () => {
  assert.equal(liveSessionHttpSpec(new Error('boom')), null);
  assert.equal(liveSessionHttpSpec('string error'), null);
  assert.equal(liveSessionHttpSpec(null), null);
});
