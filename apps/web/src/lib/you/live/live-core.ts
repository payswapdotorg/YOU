// ═══════════════════════════════════════════════════════════════════════════
// Live session runtime — the PURE half (Worker C lane, P6.C7).
//
// The realtime performance / WebRTC path, kept fully SEPARATE from the offline
// rendering loop (twins/captures/performances/renders/artifacts never appear
// here). A LiveSession is the low-latency surface: optionally bound to a Twin
// (human-driven live performance) and/or to a C6 AgentRuntimeSession
// (agent-driven live state), with CONSENT REQUIRED — a live session cannot
// open without a grant covering live performance.
//
// Honesty laws enforced by this module:
// - CONSENT IS REQUIRED AND SERVER-ENFORCED: decideCreateLiveSession refuses
//   (403 consent_required) when no active grant covers the bound subject for
//   live performance. Live performance IS realtime embodiment of the twin, so
//   the covering scope is `embodiment` — the frozen ConsentScope union is
//   deliberately NOT widened (contract-freeze law: extend, never break). The
//   grant id is recorded on the session as provenance.
// - SIGNALING IS A STATE MACHINE, NOT A QUEUE: one offer → one answer →
//   trickled candidates. Wrong-order messages get an honest 409 naming the
//   current phase — nothing is silently dropped or reordered.
// - NO FAKE LIVENESS: the session status only becomes `live` when a REAL
//   RTCPeerConnection reports `connected` through the state route; `failed`
//   and `closed` are recorded exactly as reported. The badge can never say
//   live without a peer actually connecting.
// - IDEMPOTENT STATE EVENTS: every state event can carry an idempotency key;
//   a replayed key returns the original event and appends nothing.
// - TYPED REFUSALS: every failure is a typed LiveSessionRefusal with the
//   honest HTTP taxonomy (400 validation / 401 token / 403 consent / 404 /
//   409 conflict). Nothing is rewritten to look like success.
// - TERMINAL STATES ARE TERMINAL: ended/failed sessions refuse signaling and
//   state writes; connection events after teardown are ignored (a peer
//   closing after teardown is normal, not an error, and never resurrects a
//   session).
//
// ZERO-IMPORT MODULE except node:crypto for the signaling-token HMAC (this
// file is server + node:test only; the Studio imports it TYPE-ONLY, which is
// erased at compile time — no node builtin reaches the browser bundle).
// Imported directly by node:test suites under Node >= 23.6 type stripping.
// ═══════════════════════════════════════════════════════════════════════════
import { createHmac } from 'crypto';
import type { AgentPerformanceEvent, ConsentScope, PerformanceState } from '../contracts';

// ─── Statuses, phases, surface states ───────────────────────────────────────

export const LIVE_SESSION_STATUSES = ['connecting', 'live', 'ended', 'failed'] as const;
export type LiveSessionStatus = (typeof LIVE_SESSION_STATUSES)[number];

export function parseLiveSessionStatus(raw: string | null | undefined): LiveSessionStatus {
  return LIVE_SESSION_STATUSES.includes(raw as LiveSessionStatus) ? (raw as LiveSessionStatus) : 'connecting';
}

/** WebRTC signaling exchange phases (one offer → one answer → candidates). */
export const SIGNALING_PHASES = ['new', 'offered', 'answered', 'connected', 'closed'] as const;
export type SignalingPhase = (typeof SIGNALING_PHASES)[number];

export function parseSignalingPhase(raw: string | null | undefined): SignalingPhase {
  return SIGNALING_PHASES.includes(raw as SignalingPhase) ? (raw as SignalingPhase) : 'new';
}

/**
 * The P4 surface states the live path drives (from the frozen contracts
 * PerformanceState union): listening/reading/typing/thinking/tool_use/
 * speaking/interrupted/idle/unavailable. The live monitor shows exactly
 * these — no invented states.
 */
export const LIVE_PERFORMANCE_STATES: readonly PerformanceState[] = [
  'listening', 'reading', 'typing', 'thinking', 'tool_use',
  'speaking', 'interrupted', 'idle', 'unavailable',
];

// ─── Typed refusal taxonomy (the honest 4xx map) ────────────────────────────

export type LiveSessionRefusalCode =
  | 'validation_failed'
  | 'unauthenticated'
  | 'consent_required'
  | 'not_found'
  | 'conflict';

export class LiveSessionRefusal extends Error {
  readonly status: number;
  readonly code: LiveSessionRefusalCode;
  readonly details?: unknown;
  constructor(status: number, code: LiveSessionRefusalCode, message: string, details?: unknown) {
    super(message);
    this.name = 'LiveSessionRefusal';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const liveNotFound = (what: string) =>
  new LiveSessionRefusal(404, 'not_found', `${what} not found`);

export interface LiveSessionHttpSpec {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

/**
 * Pure mapping of live-runtime failures to the standard error-envelope spec.
 * Handles ONLY the runtime's own typed failures; anything else returns null
 * and the route layer lets it propagate to the honest 500 path.
 */
export function liveSessionHttpSpec(err: unknown): LiveSessionHttpSpec | null {
  if (err instanceof LiveSessionRefusal) {
    return {
      status: err.status,
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    };
  }
  return null;
}

// ─── Create-time consent + binding validation (the pure decision) ───────────

/** The pre-resolved candidate grant (server loads by id or via requireConsent). */
export interface LiveGrantLike {
  id: string;
  subjectId: string;
  scopes: string[];
  revokedAt: Date | null;
  expiresAt: Date;
}

export interface LiveCreateBindingInput {
  /** the tenant-scoped twin when twinId was given (null = not twin-bound). */
  twin: { id: string; displayName: string; subjectId: string } | null;
  /** the tenant-scoped C6 agent session when agentSessionId was given. */
  agentSession: { id: string; status: string; twinId: string; twinSubjectId: string } | null;
  /** the resolved candidate grant — null when none was found/covering. */
  grant: LiveGrantLike | null;
  now: Date;
  /** the scope that covers live performance (embodiment — see header law). */
  scope?: ConsentScope;
}

export type LiveCreateDecision =
  | { ok: true; twinId: string; consentGrantId: string }
  | { ok: false; refusal: LiveSessionRefusal };

/**
 * The live-session open law (pure, testable):
 * - at least one binding is REQUIRED (twin and/or agent session) — a live
 *   session bound to nothing has no consent subject to cover (400);
 * - a grant covering live performance (embodiment scope) for the bound
 *   twin's subject is REQUIRED — missing, revoked, expired, wrong-scope or
 *   wrong-subject grants all refuse honestly with 403 consent_required;
 * - a bound agent session must be LIVE (409) — ended agent sessions cannot
 *   drive live state;
 * - when both bindings are given they must point at the SAME twin (409) —
 *   the visual embodiment and the driving agent must be the same person.
 */
export function decideCreateLiveSession(input: LiveCreateBindingInput): LiveCreateDecision {
  const scope: ConsentScope = input.scope ?? 'embodiment';

  if (!input.twin && !input.agentSession) {
    return {
      ok: false,
      refusal: new LiveSessionRefusal(
        400,
        'validation_failed',
        'a live session binds a twin, an agent session, or both — at least one binding is required (consent provenance needs a subject)',
      ),
    };
  }

  if (input.twin && input.agentSession && input.twin.id !== input.agentSession.twinId) {
    return {
      ok: false,
      refusal: new LiveSessionRefusal(
        409,
        'conflict',
        `binding conflict: twin "${input.twin.displayName}" and agent session "${input.agentSession.id}" point at different twins — the live performance and the driving agent must be the same twin`,
        { twinId: input.twin.id, agentSessionTwinId: input.agentSession.twinId },
      ),
    };
  }

  if (input.agentSession && input.agentSession.status !== 'live') {
    return {
      ok: false,
      refusal: new LiveSessionRefusal(
        409,
        'conflict',
        `agent session "${input.agentSession.id}" is ${input.agentSession.status} — only a live agent session can drive a live session`,
        { agentSessionId: input.agentSession.id, status: input.agentSession.status },
      ),
    };
  }

  // the consent subject is the bound twin's subject (the agent session's
  // twin is the same twin when both are bound — checked above)
  const subjectId = input.twin ? input.twin.subjectId : (input.agentSession?.twinSubjectId ?? null);
  if (subjectId === null) {
    return {
      ok: false,
      refusal: new LiveSessionRefusal(
        400,
        'validation_failed',
        'the bound twin has no consent subject to cover — this is a data-integrity refusal, not a consent decision',
      ),
    };
  }

  const grant = input.grant;
  if (!grant) {
    return {
      ok: false,
      refusal: new LiveSessionRefusal(
        403,
        'consent_required',
        `no active consent grant covering live performance (scope "${scope}") for subject ${subjectId} — a live session cannot open without one`,
        { subjectId, scope, requiredScopes: [scope] },
      ),
    };
  }
  if (grant.revokedAt) {
    return {
      ok: false,
      refusal: new LiveSessionRefusal(
        403,
        'consent_required',
        `consent grant "${grant.id}" has been revoked — a live session cannot open on a revoked grant`,
        { subjectId, scope, grantId: grant.id },
      ),
    };
  }
  if (grant.expiresAt.getTime() <= input.now.getTime()) {
    return {
      ok: false,
      refusal: new LiveSessionRefusal(
        403,
        'consent_required',
        `consent grant "${grant.id}" expired at ${grant.expiresAt.toISOString()} — renew consent before opening a live session`,
        { subjectId, scope, grantId: grant.id, expiredAt: grant.expiresAt.toISOString() },
      ),
    };
  }
  if (!grant.scopes.includes(scope)) {
    return {
      ok: false,
      refusal: new LiveSessionRefusal(
        403,
        'consent_required',
        `consent grant "${grant.id}" does not cover live performance — its scopes (${grant.scopes.join(', ') || 'none'}) lack the "${scope}" scope that live performance requires`,
        { subjectId, scope, grantId: grant.id, grantScopes: grant.scopes },
      ),
    };
  }
  if (grant.subjectId !== subjectId) {
    return {
      ok: false,
      refusal: new LiveSessionRefusal(
        403,
        'consent_required',
        `consent grant "${grant.id}" covers subject ${grant.subjectId}, not the bound twin's subject ${subjectId} — the grant must cover the twin being performed live`,
        { subjectId, grantId: grant.id, grantSubjectId: grant.subjectId },
      ),
    };
  }

  return {
    ok: true,
    // twinId is derived from the agent session when only that is bound
    twinId: input.twin ? input.twin.id : (input.agentSession?.twinId as string),
    consentGrantId: grant.id,
  };
}

// ─── Signaling messages + the state machine ─────────────────────────────────

export type SignalingMessageKind = 'offer' | 'answer' | 'candidate';
export type SignalingRole = 'initiator' | 'responder';

export interface SignalingSdpMessage {
  kind: 'offer' | 'answer';
  from: SignalingRole;
  sdp: string;
  relayedAt: string;
}

export interface SignalingCandidateMessage {
  kind: 'candidate';
  from: SignalingRole;
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  seq: number;
  relayedAt: string;
}

export type SignalingMessage = SignalingSdpMessage | SignalingCandidateMessage;

/** Bounded sizes (honest 400s above — SDP blobs are KBs, never MBs). */
export const MAX_SDP_LENGTH = 64 * 1024;
export const MAX_CANDIDATE_LENGTH = 2048;
export const MAX_SIGNALING_CANDIDATES = 256;

function refusal400(message: string, details?: unknown): LiveSessionRefusal {
  return new LiveSessionRefusal(400, 'validation_failed', message, details);
}

/**
 * Defensive parse + validation of one signaling message from the wire.
 * Honest 400s: unknown kind, bad role, missing/oversized SDP/candidate.
 */
export function normalizeSignalingMessage(
  input: unknown,
  now: Date,
): SignalingMessage {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const kind = src.kind;
  const from = src.from;
  if (from !== 'initiator' && from !== 'responder') {
    throw refusal400('signal "from" must be "initiator" or "responder" (the role this peer takes in the exchange)');
  }
  const relayedAt = now.toISOString();

  if (kind === 'offer' || kind === 'answer') {
    const sdp = src.sdp;
    if (typeof sdp !== 'string' || !sdp.trim()) {
      throw refusal400(`signal "${kind}" requires a non-empty "sdp" string (the session description to relay)`);
    }
    if (sdp.length > MAX_SDP_LENGTH) {
      throw refusal400(`signal "${kind}" sdp exceeds ${MAX_SDP_LENGTH} characters — refusing to relay oversized session descriptions`);
    }
    return { kind, from, sdp, relayedAt };
  }

  if (kind === 'candidate') {
    const candidate = src.candidate;
    if (typeof candidate !== 'string' || !candidate.trim()) {
      throw refusal400('signal "candidate" requires a non-empty "candidate" string (the ICE candidate to relay)');
    }
    if (candidate.length > MAX_CANDIDATE_LENGTH) {
      throw refusal400(`signal "candidate" exceeds ${MAX_CANDIDATE_LENGTH} characters`);
    }
    const sdpMid = typeof src.sdpMid === 'string' ? src.sdpMid : null;
    const sdpMLineIndex = typeof src.sdpMLineIndex === 'number' && Number.isInteger(src.sdpMLineIndex) ? src.sdpMLineIndex : null;
    return { kind, from, candidate, sdpMid, sdpMLineIndex, seq: 0, relayedAt };
  }

  throw refusal400('signal "kind" must be "offer", "answer" or "candidate"', { received: String(kind) });
}

export interface SignalingMachineInput {
  phase: SignalingPhase;
  status: LiveSessionStatus;
  /** the recorded offer (its `from` role locks the answer's opposite role). */
  offerFrom: SignalingRole | null;
}

export interface SignalDecision {
  ok: boolean;
  /** the phase AFTER accepting this message (unchanged for candidates). */
  nextPhase: SignalingPhase;
  refusal?: LiveSessionRefusal;
}

/**
 * The signaling state machine (offer → answer → candidates, honest 409s):
 * - ended/failed sessions refuse ALL signaling (terminal is terminal);
 * - an offer is accepted ONLY in phase `new` — v1 relays a single
 *   offer/answer exchange per session (renegotiation = a new session);
 * - an answer is accepted ONLY in phase `offered` and ONLY from the peer
 *   that did NOT send the offer (the responder);
 * - candidates are accepted once an offer exists (offered/answered/
 *   connected) — ICE never trickles before the descriptions are exchanged.
 */
export function decideSignalMessage(machine: SignalingMachineInput, message: SignalingMessage): SignalDecision {
  if (machine.status === 'ended') {
    return {
      ok: false,
      nextPhase: machine.phase,
      refusal: new LiveSessionRefusal(
        409,
        'conflict',
        `live session has ended — signaling is closed (phase: ${machine.phase})`,
        { status: machine.status, phase: machine.phase },
      ),
    };
  }
  if (machine.status === 'failed') {
    return {
      ok: false,
      nextPhase: machine.phase,
      refusal: new LiveSessionRefusal(
        409,
        'conflict',
        `live session failed — signaling is closed; open a new session to retry (phase: ${machine.phase})`,
        { status: machine.status, phase: machine.phase },
      ),
    };
  }

  if (message.kind === 'offer') {
    if (machine.phase !== 'new') {
      return {
        ok: false,
        nextPhase: machine.phase,
        refusal: new LiveSessionRefusal(
          409,
          'conflict',
          `an offer was already exchanged on this session (phase: ${machine.phase}) — v1 relays a single offer/answer exchange; open a new session for renegotiation`,
          { phase: machine.phase },
        ),
      };
    }
    return { ok: true, nextPhase: 'offered' };
  }

  if (message.kind === 'answer') {
    if (machine.phase === 'new') {
      return {
        ok: false,
        nextPhase: machine.phase,
        refusal: new LiveSessionRefusal(
          409,
          'conflict',
          'no offer has been relayed yet — the initiator sends the offer first, then the responder answers',
          { phase: machine.phase },
        ),
      };
    }
    if (machine.phase === 'answered' || machine.phase === 'connected' || machine.phase === 'closed') {
      return {
        ok: false,
        nextPhase: machine.phase,
        refusal: new LiveSessionRefusal(
          409,
          'conflict',
          `an answer was already exchanged on this session (phase: ${machine.phase}) — ICE candidates are still accepted`,
          { phase: machine.phase },
        ),
      };
    }
    // phase === 'offered': the answer must come from the OPPOSITE role
    if (machine.offerFrom !== null && message.from === machine.offerFrom) {
      return {
        ok: false,
        nextPhase: machine.phase,
        refusal: new LiveSessionRefusal(
          409,
          'conflict',
          `the answer must come from the peer that received the offer — role "${message.from}" sent the offer on this session`,
          { phase: machine.phase, offerFrom: machine.offerFrom, answerFrom: message.from },
        ),
      };
    }
    return { ok: true, nextPhase: 'answered' };
  }

  // candidate
  if (machine.phase === 'new') {
    return {
      ok: false,
      nextPhase: machine.phase,
      refusal: new LiveSessionRefusal(
        409,
        'conflict',
        'no offer/answer has been exchanged yet — trickled ICE candidates are relayed only after the session descriptions',
        { phase: machine.phase },
      ),
    };
  }
  return { ok: true, nextPhase: machine.phase };
}

// ─── Performance deltas (gaze / expression / speech) ────────────────────────

export interface LivePerformanceDelta {
  /** normalized gaze target in [-1, 1] × [-1, 1]. */
  gaze?: { x: number; y: number };
  /** a named expression token (e.g. "neutral", "smile", "surprised"). */
  expression?: string;
  /** a speech text delta (what is being said right now). */
  speech?: string;
  /** performance intensity 0..1. */
  intensity?: number;
}

export const MAX_EXPRESSION_LENGTH = 60;
export const MAX_SPEECH_LENGTH = 500;

/**
 * Validate one performance delta (honest 400s: at least one field, bounded
 * strings, gaze/intensity within range — garbage never reaches the stream).
 */
export function normalizePerformanceDelta(input: unknown): LivePerformanceDelta {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: LivePerformanceDelta = {};

  if (src.gaze !== undefined && src.gaze !== null) {
    const g = src.gaze as Record<string, unknown>;
    const x = typeof g?.x === 'number' && Number.isFinite(g.x) ? g.x : null;
    const y = typeof g?.y === 'number' && Number.isFinite(g.y) ? g.y : null;
    if (x === null || y === null) {
      throw refusal400('delta.gaze must be { x: number, y: number } (normalized -1..1)');
    }
    if (Math.abs(x) > 1 || Math.abs(y) > 1) {
      throw refusal400(`delta.gaze components must stay within [-1, 1] (received x=${x}, y=${y})`);
    }
    out.gaze = { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
  }

  if (src.expression !== undefined && src.expression !== null) {
    if (typeof src.expression !== 'string' || !src.expression.trim()) {
      throw refusal400('delta.expression must be a non-empty string (a named expression token)');
    }
    if (src.expression.length > MAX_EXPRESSION_LENGTH) {
      throw refusal400(`delta.expression exceeds ${MAX_EXPRESSION_LENGTH} characters`);
    }
    out.expression = src.expression.trim();
  }

  if (src.speech !== undefined && src.speech !== null) {
    if (typeof src.speech !== 'string' || !src.speech.trim()) {
      throw refusal400('delta.speech must be a non-empty string (the speech delta being spoken)');
    }
    if (src.speech.length > MAX_SPEECH_LENGTH) {
      throw refusal400(`delta.speech exceeds ${MAX_SPEECH_LENGTH} characters — send smaller deltas`);
    }
    out.speech = src.speech.trim();
  }

  if (src.intensity !== undefined && src.intensity !== null) {
    if (typeof src.intensity !== 'number' || !Number.isFinite(src.intensity) || src.intensity < 0 || src.intensity > 1) {
      throw refusal400('delta.intensity must be a number within [0, 1]');
    }
    out.intensity = Math.round(src.intensity * 1000) / 1000;
  }

  if (Object.keys(out).length === 0) {
    throw refusal400('delta is empty — provide at least one of gaze, expression, speech, intensity');
  }
  return out;
}

// ─── The persisted signaling state (JSON blob shape) ────────────────────────

export interface LiveStateEvent {
  eventId: string;
  seq: number;
  kind: 'connection' | 'performance' | 'agent';
  /** connection state (kind=connection) or agent surface state (kind=agent). */
  state: string | null;
  delta: LivePerformanceDelta | null;
  source: 'client' | 'agent-runtime' | 'server';
  timestamp: string;
  meta?: Record<string, unknown>;
}

export interface LiveSignalingState {
  phase: SignalingPhase;
  offer: SignalingSdpMessage | null;
  answer: SignalingSdpMessage | null;
  candidates: SignalingCandidateMessage[];
  nextSeq: number;
  stateEvents: LiveStateEvent[];
  /** idempotency key → eventId (bounded map of recently processed keys). */
  processedKeys: Record<string, string>;
  currentAgentState: string | null;
  lastConnectionState: string | null;
}

export const MAX_STATE_EVENTS = 128;
export const MAX_PROCESSED_KEYS = 256;

export function emptySignalingState(): LiveSignalingState {
  return {
    phase: 'new',
    offer: null,
    answer: null,
    candidates: [],
    nextSeq: 1,
    stateEvents: [],
    processedKeys: {},
    currentAgentState: null,
    lastConnectionState: null,
  };
}

/** Defensive parse of the persisted JSON (never throws — garbage degrades to empty). */
export function parseSignalingState(json: string | null | undefined): LiveSignalingState {
  if (!json) return emptySignalingState();
  try {
    const p = JSON.parse(json) as Partial<LiveSignalingState>;
    const base = emptySignalingState();
    return {
      phase: parseSignalingPhase(p.phase ?? undefined),
      offer: p.offer && p.offer.kind === 'offer' && typeof p.offer.sdp === 'string' ? p.offer : null,
      answer: p.answer && p.answer.kind === 'answer' && typeof p.answer.sdp === 'string' ? p.answer : null,
      candidates: Array.isArray(p.candidates)
        ? p.candidates.filter(
            (c): c is SignalingCandidateMessage =>
              !!c && typeof c === 'object' && typeof (c as SignalingCandidateMessage).candidate === 'string',
          )
        : [],
      nextSeq: typeof p.nextSeq === 'number' && Number.isFinite(p.nextSeq) && p.nextSeq > 0 ? p.nextSeq : 1,
      stateEvents: Array.isArray(p.stateEvents)
        ? p.stateEvents.filter((e): e is LiveStateEvent => !!e && typeof e === 'object' && typeof (e as LiveStateEvent).eventId === 'string')
        : [],
      processedKeys:
        p.processedKeys && typeof p.processedKeys === 'object' && !Array.isArray(p.processedKeys)
          ? Object.fromEntries(
              Object.entries(p.processedKeys).filter(([, v]) => typeof v === 'string'),
            )
          : {},
      currentAgentState: typeof p.currentAgentState === 'string' ? p.currentAgentState : null,
      lastConnectionState: typeof p.lastConnectionState === 'string' ? p.lastConnectionState : null,
    };
  } catch {
    return emptySignalingState();
  }
}

/** Apply an accepted offer/answer to the state (pure fold). */
export function applySignalingMessage(
  state: LiveSignalingState,
  message: SignalingMessage,
  nextPhase: SignalingPhase,
): LiveSignalingState {
  const next: LiveSignalingState = { ...state, phase: nextPhase };
  // positive discriminant check (candidate) — TS splits exact-literal members
  // only, so the sdp variants land in the else with their shared type intact
  if (message.kind === 'candidate') {
    if (state.candidates.length >= MAX_SIGNALING_CANDIDATES) {
      throw new LiveSessionRefusal(
        409,
        'conflict',
        `this session has relayed the maximum of ${MAX_SIGNALING_CANDIDATES} ICE candidates — v1 stops here; open a new session if the connection needs more`,
      );
    }
    next.candidates = [...state.candidates, { ...message, seq: state.nextSeq }];
    next.nextSeq = state.nextSeq + 1;
  } else if (message.kind === 'offer') {
    next.offer = message;
  } else {
    next.answer = message;
  }
  return next;
}

// ─── Idempotent state-event append (bounded ring) ───────────────────────────

export interface AppendStateEventResult {
  state: LiveSignalingState;
  /** true when the idempotency key already carried this event (no append). */
  duplicate: boolean;
  eventId: string;
}

/**
 * Append one state event with idempotency: a replayed key returns the
 * ORIGINAL event id and appends nothing. Both the event ring and the key
 * map are bounded (oldest evicted) — the live stream is a transport log,
 * not an audit trail (emitEvent carries the durable record).
 */
export function appendStateEvent(
  state: LiveSignalingState,
  event: LiveStateEvent,
  idempotencyKey?: string,
): AppendStateEventResult {
  if (idempotencyKey !== undefined) {
    const existing = state.processedKeys[idempotencyKey];
    if (existing) {
      return { state, duplicate: true, eventId: existing };
    }
  }

  let stateEvents = [...state.stateEvents, event];
  if (stateEvents.length > MAX_STATE_EVENTS) {
    stateEvents = stateEvents.slice(stateEvents.length - MAX_STATE_EVENTS);
  }

  const processedKeys = { ...state.processedKeys };
  if (idempotencyKey !== undefined) {
    processedKeys[idempotencyKey] = event.eventId;
    const keys = Object.keys(processedKeys);
    if (keys.length > MAX_PROCESSED_KEYS) {
      for (const k of keys.slice(0, keys.length - MAX_PROCESSED_KEYS)) delete processedKeys[k];
    }
  }

  return {
    state: { ...state, stateEvents, processedKeys, nextSeq: state.nextSeq + 1 },
    duplicate: false,
    eventId: event.eventId,
  };
}

// ─── Connection lifecycle (the no-fake-liveness law) ────────────────────────

export type LiveConnectionState = 'connecting' | 'connected' | 'failed' | 'closed';

export interface ConnectionTransitionResult {
  /** the session status after applying the peer connection's report. */
  status: LiveSessionStatus;
  /** the signaling phase after applying the report. */
  phase: SignalingPhase;
  /** true when nothing changed (post-terminal noise is ignored, not an error). */
  ignored: boolean;
  /** whether the status actually changed (drives the emitted event). */
  statusChanged: boolean;
}

/**
 * Apply one REAL RTCPeerConnection connection-state report:
 * - `connected` → status live, phase connected (ONLY a real peer does this);
 * - `failed` → status failed (honest failure, terminal in v1);
 * - `closed` → status ended, phase closed;
 * - `connecting` → demotes nothing: a session that has been live stays live
 *   through transient re-establishment reports until it fails or closes;
 * - reports after ended/failed are IGNORED — a peer closing after teardown
 *   is normal and can never resurrect or re-fail a session.
 */
export function applyConnectionTransition(
  status: LiveSessionStatus,
  phase: SignalingPhase,
  connectionState: LiveConnectionState,
): ConnectionTransitionResult {
  if (status === 'ended' || status === 'failed') {
    return { status, phase, ignored: true, statusChanged: false };
  }

  switch (connectionState) {
    case 'connected':
      return {
        status: 'live',
        phase: 'connected',
        ignored: false,
        statusChanged: status !== 'live',
      };
    case 'failed':
      // from connecting|live — always an honest change
      return { status: 'failed', phase, ignored: false, statusChanged: true };
    case 'closed':
      // from connecting|live — always an honest change
      return { status: 'ended', phase: 'closed', ignored: false, statusChanged: true };
    case 'connecting':
      return {
        status: status === 'live' ? 'live' : 'connecting',
        phase,
        ignored: false,
        statusChanged: false,
      };
  }
}

// ─── Agent turn states → live surface states (the C6 binding law) ───────────

/**
 * Map C6 agent-turn performance events to the live surface states (P4):
 * thinking → thinking, tool_use → tool_use, speaking → speaking; the P4
 * surface states pass through 1:1 (listening/reading/typing/interrupted/
 * idle/unavailable); `custom` events do not map (null — the monitor skips
 * them honestly rather than inventing a state).
 */
export function agentEventToLiveState(event: AgentPerformanceEvent): PerformanceState | null {
  const t = event.type;
  if ((LIVE_PERFORMANCE_STATES as readonly string[]).includes(t)) {
    return t as PerformanceState;
  }
  return null; // 'custom' — no honest surface mapping
}

/**
 * The full per-turn live state sequence the executor drives: listening (the
 * turn was accepted — the twin is listening) → the engine's events as they
 * stream (thinking / tool_use / thinking / speaking) → idle (turn complete).
 */
export function agentTurnLiveStateSequence(events: AgentPerformanceEvent[]): PerformanceState[] {
  const sequence: PerformanceState[] = ['listening'];
  for (const event of events) {
    const state = agentEventToLiveState(event);
    if (state !== null) sequence.push(state);
  }
  sequence.push('idle');
  return sequence;
}

// ─── Signaling tokens (short-lived, HMAC-bound to the session) ──────────────

export const SIGNALING_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes, documented

function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/**
 * Mint a short-lived signaling token bound to ONE session: `v1.<expMs>.<hmac>`
 * where hmac = HMAC-SHA256(secret, "<sessionId>.<expMs>"). The token carries
 * no secret material and grants exactly the signaling/state submit capability
 * for this session until expMs.
 */
export function signSignalingToken(secret: string, sessionId: string, now: Date): string {
  const expMs = now.getTime() + SIGNALING_TOKEN_TTL_MS;
  return `v1.${expMs}.${hmacHex(secret, `${sessionId}.${expMs}`)}`;
}

export interface SignalingTokenCheck {
  ok: boolean;
  expiresAtMs: number | null;
  refusal?: LiveSessionRefusal;
}

/** Verify a signaling token against a session (honest 401s; tamper/expiry named). */
export function verifySignalingToken(
  secret: string,
  token: string,
  sessionId: string,
  now: Date,
): SignalingTokenCheck {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    return {
      ok: false,
      expiresAtMs: null,
      refusal: new LiveSessionRefusal(401, 'unauthenticated', 'malformed signaling token — expected v1.<expMs>.<hmac>'),
    };
  }
  const expMs = Number(parts[1]);
  if (!Number.isFinite(expMs) || expMs <= 0) {
    return {
      ok: false,
      expiresAtMs: null,
      refusal: new LiveSessionRefusal(401, 'unauthenticated', 'malformed signaling token expiry'),
    };
  }
  const expected = hmacHex(secret, `${sessionId}.${expMs}`);
  if (parts[2] !== expected) {
    return {
      ok: false,
      expiresAtMs: null,
      refusal: new LiveSessionRefusal(
        401,
        'unauthenticated',
        'signaling token signature mismatch — the token is not valid for this session (wrong session, tampered token, or server key rotation)',
      ),
    };
  }
  if (expMs <= now.getTime()) {
    return {
      ok: false,
      expiresAtMs: expMs,
      refusal: new LiveSessionRefusal(
        401,
        'unauthenticated',
        `signaling token expired at ${new Date(expMs).toISOString()} — request a fresh token by creating a new live session`,
      ),
    };
  }
  return { ok: true, expiresAtMs: expMs };
}

// ─── Client-facing view types (lane-owned; the Studio imports type-only) ────

export interface LiveStateEventView {
  eventId: string;
  seq: number;
  kind: 'connection' | 'performance' | 'agent';
  state: string | null;
  delta: LivePerformanceDelta | null;
  source: string;
  timestamp: string;
}

export interface LiveSessionView {
  id: string;
  twinId: string | null;
  twinDisplayName: string | null;
  agentSessionId: string | null;
  /** consent provenance: the grant covering live performance (REQUIRED). */
  consentGrantId: string;
  status: LiveSessionStatus;
  phase: SignalingPhase;
  currentAgentState: string | null;
  lastConnectionState: string | null;
  createdAt: string;
  endedAt: string | null;
  /** recent live state events (bounded ring — newest last). */
  stateEvents: LiveStateEventView[];
  signaling: {
    hasOffer: boolean;
    hasAnswer: boolean;
    candidateCount: number;
  };
}

export interface LiveSessionSummaryView {
  id: string;
  twinDisplayName: string | null;
  agentSessionId: string | null;
  consentGrantId: string;
  status: LiveSessionStatus;
  phase: SignalingPhase;
  currentAgentState: string | null;
  eventCount: number;
  createdAt: string;
  endedAt: string | null;
}

export interface LiveSignalingPollView {
  sessionId: string;
  status: LiveSessionStatus;
  phase: SignalingPhase;
  offer: { from: string; sdp: string; relayedAt: string } | null;
  answer: { from: string; sdp: string; relayedAt: string } | null;
  /** candidates with seq > since (all when since is omitted). */
  candidates: { seq: number; from: string; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null; relayedAt: string }[];
  nextSeq: number;
}
