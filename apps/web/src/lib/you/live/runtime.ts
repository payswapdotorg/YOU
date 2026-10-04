// ═══════════════════════════════════════════════════════════════════════════
// Live session runtime — the SERVER half (Worker C lane, P6.C7).
//
// Persistence + lifecycle for live sessions (the realtime performance /
// WebRTC path), fully SEPARATE from the offline rendering loop:
//   - create is CONSENT-ENFORCED (a covering grant is REQUIRED — embodiment
//     scope, see live-core header law) and tenant-scoped; the grant id is
//     recorded as provenance and RE-CHECKED on every signal/state submit
//     (revoked or expired mid-session → the write is refused AND the live
//     session is ended honestly — the C6 fail-closed precedent);
//   - signaling is relayed through the pure state machine (live-core
//     decideSignalMessage — honest 409s on wrong-phase, never reordered);
//   - state events are idempotent (x-idempotency-key) and bounded;
//   - the status only becomes `live` when a REAL peer connection reports
//     `connected` (no fake liveness — the pure applyConnectionTransition);
//   - every transition flows through the existing emitEvent seam
//     (core/events.ts — webhook fan-out included);
//   - teardown is explicit and idempotent (POST [id]/end).
//
// Agent binding (the C6 bridge): when a live session binds agentSessionId,
// the agent.turn executor streams the turn's performance events into the
// live state log as they happen (pushAgentStatesToLiveSessions) —
// listening → thinking → tool_use → speaking → idle. That path is LOW
// LATENCY and touches no offline-rendering table.
//
// Signaling tokens: short-lived (10 min) HMAC-bound capability tokens minted
// at create (v1.<expMs>.<hmac>). Secret: YOU_LIVE_SIGNALING_SECRET when set
// (stable across restarts); otherwise a PER-PROCESS random key — honest
// dev-tier behavior (a restart invalidates outstanding tokens; the route
// says so verbatim instead of failing silently). No credential ships in code.
//
// Honest limits (disclosed): the relay is HTTP request/response — the client
// polls for remote messages (documented v1 transport; no WebSocket/SSE yet);
// read-modify-write on the signaling blob is serialized by an IN-PROCESS
// per-session lock (single-node dev tier — a multi-node deployment needs the
// same serialization at the database level before scaling out).
// ═══════════════════════════════════════════════════════════════════════════
import { randomBytes } from 'crypto';
import type { ConsentGrant, LiveSession, Twin } from '@prisma/client';
import { db } from '@/lib/db';
import { HttpError } from '../core/errors';
import { emitEvent } from '../core/events';
import { parseJson } from '../core/views';
import { requireConsent } from '../core/consent';
import type { AgentPerformanceEvent, PerformanceState } from '../contracts';
import {
  LIVE_PERFORMANCE_STATES,
  LiveSessionRefusal,
  appendStateEvent,
  applyConnectionTransition,
  applySignalingMessage,
  agentEventToLiveState,
  decideCreateLiveSession,
  decideSignalMessage,
  liveSessionHttpSpec,
  normalizePerformanceDelta,
  normalizeSignalingMessage,
  parseLiveSessionStatus,
  parseSignalingState,
  signSignalingToken,
  verifySignalingToken,
  SIGNALING_TOKEN_TTL_MS,
  type LiveConnectionState,
  type LiveSessionStatus,
  type LiveSessionSummaryView,
  type LiveSessionView,
  type LiveSignalingPollView,
  type LiveSignalingState,
  type LiveStateEvent,
  type LiveStateEventView,
  type SignalingPhase,
} from './live-core';

// ─── Typed-refusal → HTTP envelope ───────────────────────────────────────────

/** Translate a live-core typed refusal into the standard error envelope. */
export function toLiveHttpError(err: unknown): HttpError {
  const spec = liveSessionHttpSpec(err);
  if (spec) {
    return new HttpError(spec.status, spec.code, spec.message, spec.details);
  }
  throw err;
}

// ─── Per-session write serialization (the RMW lock) ──────────────────────────

/**
 * In-process per-session mutex: every read-modify-write on a session's
 * signaling blob (signal relay, state event, teardown, agent push) runs
 * exclusively per session. Without it, a connection state POST landing
 * between an offer relay and its write would resurrect the pre-offer state
 * and later candidates would 409 on phase 'new' (observed live in the
 * browser verification — the exact race this lock removes). Single-process
 * scope: a multi-node deployment must add database-level serialization.
 */
const sessionWriteLocks = new Map<string, Promise<unknown>>();

function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = sessionWriteLocks.get(sessionId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  sessionWriteLocks.set(sessionId, next);
  void next
    .catch(() => undefined)
    .finally(() => {
      if (sessionWriteLocks.get(sessionId) === next) sessionWriteLocks.delete(sessionId);
    });
  return next;
}

// ─── Signaling secret (env or per-process) ──────────────────────────────────

let processSecret: string | null = null;

function liveSignalingSecret(): string {
  const fromEnv = process.env.YOU_LIVE_SIGNALING_SECRET;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  if (processSecret === null) {
    // dev tier: per-process random key (documented honest limit — restarts
    // invalidate outstanding tokens; set YOU_LIVE_SIGNALING_SECRET for stable
    // tokens). No credential is ever embedded in code.
    processSecret = randomBytes(32).toString('hex');
  }
  return processSecret;
}

// ─── View mappers ────────────────────────────────────────────────────────────

function stateEventView(e: LiveStateEvent): LiveStateEventView {
  return {
    eventId: e.eventId,
    seq: e.seq,
    kind: e.kind,
    state: e.state,
    delta: e.delta,
    source: e.source,
    timestamp: e.timestamp,
  };
}

export function liveSessionView(s: LiveSession & { twin?: Twin | null }): LiveSessionView {
  const signaling = parseSignalingState(s.signaling);
  return {
    id: s.id,
    twinId: s.twinId,
    twinDisplayName: s.twin?.displayName ?? null,
    agentSessionId: s.agentSessionId,
    consentGrantId: s.consentGrantId,
    status: parseLiveSessionStatus(s.status),
    phase: signaling.phase,
    currentAgentState: signaling.currentAgentState,
    lastConnectionState: signaling.lastConnectionState,
    createdAt: s.createdAt.toISOString(),
    endedAt: s.endedAt ? s.endedAt.toISOString() : null,
    stateEvents: signaling.stateEvents.map(stateEventView),
    signaling: {
      hasOffer: signaling.offer !== null,
      hasAnswer: signaling.answer !== null,
      candidateCount: signaling.candidates.length,
    },
  };
}

export function liveSessionSummaryView(s: LiveSession & { twin?: Twin | null }): LiveSessionSummaryView {
  const signaling = parseSignalingState(s.signaling);
  return {
    id: s.id,
    twinDisplayName: s.twin?.displayName ?? null,
    agentSessionId: s.agentSessionId,
    consentGrantId: s.consentGrantId,
    status: parseLiveSessionStatus(s.status),
    phase: signaling.phase,
    currentAgentState: signaling.currentAgentState,
    eventCount: signaling.stateEvents.length,
    createdAt: s.createdAt.toISOString(),
    endedAt: s.endedAt ? s.endedAt.toISOString() : null,
  };
}

// ─── Create (consent-enforced, tenant-scoped) ────────────────────────────────

export interface CreateLiveSessionInput {
  twinId?: string;
  agentSessionId?: string;
  /** optional explicit grant (the Studio picker); resolved server-side otherwise. */
  consentGrantId?: string;
}

export interface CreateLiveSessionResult {
  session: LiveSessionView;
  signalingToken: string;
  tokenExpiresAt: string;
}

export async function createLiveSession(
  tenantId: string,
  input: CreateLiveSessionInput,
): Promise<CreateLiveSessionResult> {
  // resolve bindings (tenant-scoped; honest 404s)
  let twin: { id: string; displayName: string; subjectId: string } | null = null;
  if (input.twinId) {
    const row = await db.twin.findFirst({ where: { id: input.twinId, tenantId } });
    if (!row) throw toLiveHttpError(new LiveSessionRefusal(404, 'not_found', `twin "${input.twinId}" not found`));
    twin = { id: row.id, displayName: row.displayName, subjectId: row.subjectId };
  }

  let agentSession: { id: string; status: string; twinId: string; twinSubjectId: string } | null = null;
  if (input.agentSessionId) {
    const row = await db.agentRuntimeSession.findFirst({
      where: { id: input.agentSessionId, tenantId },
      include: { twin: true },
    });
    if (!row) {
      throw toLiveHttpError(
        new LiveSessionRefusal(404, 'not_found', `agent session "${input.agentSessionId}" not found`),
      );
    }
    agentSession = {
      id: row.id,
      status: row.status,
      twinId: row.twinId,
      twinSubjectId: row.twin.subjectId,
    };
  }

  // resolve the candidate grant: explicit picker id, else the covering
  // requireConsent resolution (both paths feed the SAME pure decision)
  let grant: {
    id: string;
    subjectId: string;
    scopes: string[];
    revokedAt: Date | null;
    expiresAt: Date;
  } | null = null;
  if (input.consentGrantId) {
    const row = await db.consentGrant.findFirst({ where: { id: input.consentGrantId, tenantId } });
    if (!row) {
      throw toLiveHttpError(
        new LiveSessionRefusal(404, 'not_found', `consent grant "${input.consentGrantId}" not found`),
      );
    }
    grant = {
      id: row.id,
      subjectId: row.subjectId,
      scopes: parseJson<string[]>(row.scopes, []),
      revokedAt: row.revokedAt,
      expiresAt: row.expiresAt,
    };
  } else {
    // the subject is knowable only with a binding; without one the pure
    // decision refuses (400) — mirror that honestly before touching consent
    const subjectId = twin ? twin.subjectId : (agentSession?.twinSubjectId ?? null);
    if (subjectId !== null) {
      const covering = await requireConsent(tenantId, subjectId, 'embodiment');
      grant = {
        id: covering.id,
        subjectId: covering.subjectId,
        scopes: parseJson<string[]>(covering.scopes, []),
        revokedAt: covering.revokedAt,
        expiresAt: covering.expiresAt,
      };
    }
  }

  const decision = decideCreateLiveSession({
    twin,
    agentSession,
    grant,
    now: new Date(),
    scope: 'embodiment',
  });
  if (!decision.ok) throw toLiveHttpError(decision.refusal);

  const session = await db.liveSession.create({
    data: {
      tenantId,
      twinId: decision.twinId,
      agentSessionId: input.agentSessionId ?? null,
      consentGrantId: decision.consentGrantId,
      status: 'connecting',
      signaling: JSON.stringify(parseSignalingState(null)),
    },
  });

  await emitEvent(tenantId, 'live.session.opened', 'live_session', session.id, {
    sessionId: session.id,
    twinId: decision.twinId,
    agentSessionId: session.agentSessionId,
    consentGrantId: decision.consentGrantId,
    status: 'connecting',
  });

  const now = new Date();
  const token = signSignalingToken(liveSignalingSecret(), session.id, now);
  const view = liveSessionView({ ...session, twin: null });
  // the twin display name is knowable — re-render with the resolved twin row
  if (twin) {
    return {
      session: { ...view, twinDisplayName: twin.displayName },
      signalingToken: token,
      tokenExpiresAt: new Date(now.getTime() + SIGNALING_TOKEN_TTL_MS).toISOString(),
    };
  }
  return {
    session: view,
    signalingToken: token,
    tokenExpiresAt: new Date(now.getTime() + SIGNALING_TOKEN_TTL_MS).toISOString(),
  };
}

// ─── List / detail ───────────────────────────────────────────────────────────

export async function listLiveSessions(tenantId: string): Promise<LiveSessionSummaryView[]> {
  const sessions = await db.liveSession.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { twin: true },
  });
  return sessions.map(liveSessionSummaryView);
}

export async function getLiveSession(tenantId: string, sessionId: string): Promise<LiveSessionView> {
  const session = await db.liveSession.findFirst({
    where: { id: sessionId, tenantId },
    include: { twin: true },
  });
  if (!session) throw toLiveHttpError(new LiveSessionRefusal(404, 'not_found', `live session "${sessionId}" not found`));
  return liveSessionView(session);
}

// ─── Consent re-verification (fail-closed, the C6 precedent) ────────────────

/**
 * Read-only check of the RECORDED grant (callers hold the session lock).
 * A revoked or expired grant is handled by refuseConsentEnded — revoked
 * consent never silently streams.
 */
async function sessionGrantActive(tenantId: string, session: LiveSession): Promise<boolean> {
  const grant = await db.consentGrant.findFirst({ where: { id: session.consentGrantId, tenantId } });
  return !!grant && !grant.revokedAt && grant.expiresAt.getTime() > Date.now();
}

/** Ends the session (caller holds the lock) and throws the honest 403. */
async function refuseConsentEnded(tenantId: string, session: LiveSession, what: string): Promise<never> {
  await endLiveSessionRow(tenantId, session, 'consent-revoked');
  throw toLiveHttpError(
    new LiveSessionRefusal(
      403,
      'consent_required',
      `the consent grant covering this live session was revoked or expired — the session has been ended; no further ${what} are accepted`,
      { sessionId: session.id, grantId: session.consentGrantId },
    ),
  );
}

// ─── Signaling relay (the state machine) ────────────────────────────────────

export interface RelaySignalResult {
  phase: SignalingPhase;
  status: LiveSessionStatus;
  /** assigned candidate sequence (candidates only). */
  seq: number | null;
}

export async function relaySignal(
  tenantId: string,
  sessionId: string,
  messageInput: unknown,
  signalingToken: string,
): Promise<RelaySignalResult> {
  const session = await db.liveSession.findFirst({ where: { id: sessionId, tenantId } });
  if (!session) {
    throw toLiveHttpError(new LiveSessionRefusal(404, 'not_found', `live session "${sessionId}" not found`));
  }

  // capability check: the short-lived token bound to THIS session
  const check = verifySignalingToken(liveSignalingSecret(), signalingToken, session.id, new Date());
  if (!check.ok) throw toLiveHttpError(check.refusal as LiveSessionRefusal);

  // pure message validation BEFORE taking the lock (honest 400s are cheap)
  const now = new Date();
  const message = normalizeSignalingMessage(messageInput, now);

  // the read-modify-write runs under the per-session lock (see header law)
  return withSessionLock(session.id, async () => {
    const fresh = (await db.liveSession.findUnique({ where: { id: session.id } })) ?? session;
    // consent re-verified INSIDE the lock (fail-closed — revoked ends the session)
    if (!(await sessionGrantActive(tenantId, fresh))) {
      await refuseConsentEnded(tenantId, fresh, 'signaling');
    }
    const state = parseSignalingState(fresh.signaling);
    const status = parseLiveSessionStatus(fresh.status);

    const decision = decideSignalMessage(
      { phase: state.phase, status, offerFrom: state.offer?.from ?? null },
      message,
    );
    if (!decision.ok) throw toLiveHttpError(decision.refusal as LiveSessionRefusal);

    const next = applySignalingMessage(state, message, decision.nextPhase);
    await db.liveSession.update({
      where: { id: fresh.id },
      data: { signaling: JSON.stringify(next) },
    });

    await emitEvent(tenantId, 'live.signal.relayed', 'live_session', fresh.id, {
      sessionId: fresh.id,
      kind: message.kind,
      from: message.from,
      phase: decision.nextPhase,
      ...(message.kind === 'candidate' ? { candidateSeq: next.candidates[next.candidates.length - 1]?.seq ?? null } : {}),
    });

    return {
      phase: decision.nextPhase,
      status,
      seq: message.kind === 'candidate' ? next.candidates[next.candidates.length - 1]?.seq ?? null : null,
    };
  });
}

// ─── Signaling poll (v1 transport: HTTP polling — documented) ───────────────

export async function pollSignaling(
  tenantId: string,
  sessionId: string,
  since?: number,
): Promise<LiveSignalingPollView> {
  const session = await db.liveSession.findFirst({ where: { id: sessionId, tenantId } });
  if (!session) {
    throw toLiveHttpError(new LiveSessionRefusal(404, 'not_found', `live session "${sessionId}" not found`));
  }
  const state = parseSignalingState(session.signaling);
  const sinceSeq = typeof since === 'number' && Number.isFinite(since) && since >= 0 ? since : 0;
  return {
    sessionId: session.id,
    status: parseLiveSessionStatus(session.status),
    phase: state.phase,
    offer: state.offer ? { from: state.offer.from, sdp: state.offer.sdp, relayedAt: state.offer.relayedAt } : null,
    answer: state.answer ? { from: state.answer.from, sdp: state.answer.sdp, relayedAt: state.answer.relayedAt } : null,
    candidates: state.candidates
      .filter((c) => c.seq > sinceSeq)
      .map((c) => ({
        seq: c.seq,
        from: c.from,
        candidate: c.candidate,
        sdpMid: c.sdpMid,
        sdpMLineIndex: c.sdpMLineIndex,
        relayedAt: c.relayedAt,
      })),
    nextSeq: state.nextSeq,
  };
}

// ─── State events (connection / performance / agent) ────────────────────────

export interface SubmitLiveStateResult {
  eventId: string;
  duplicate: boolean;
  status: LiveSessionStatus;
  phase: SignalingPhase;
  currentAgentState: string | null;
}

export async function submitStateEvent(
  tenantId: string,
  sessionId: string,
  input: Record<string, unknown>,
  idempotencyKey: string | undefined,
  signalingToken: string,
): Promise<SubmitLiveStateResult> {
  const session = await db.liveSession.findFirst({ where: { id: sessionId, tenantId } });
  if (!session) {
    throw toLiveHttpError(new LiveSessionRefusal(404, 'not_found', `live session "${sessionId}" not found`));
  }

  // capability check (same fail-closed law as signaling)
  const check = verifySignalingToken(liveSignalingSecret(), signalingToken, session.id, new Date());
  if (!check.ok) throw toLiveHttpError(check.refusal as LiveSessionRefusal);

  // pure validation BEFORE the lock: kind checks + delta normalization
  // (the honest 400s never take the mutex)
  const kind = input.kind;
  let validated: { kind: 'connection'; connectionState: LiveConnectionState } | { kind: 'performance'; delta: ReturnType<typeof normalizePerformanceDelta> } | { kind: 'agent'; agentState: string };
  if (kind === 'connection') {
    const connectionState = input.connectionState;
    if (
      connectionState !== 'connecting' &&
      connectionState !== 'connected' &&
      connectionState !== 'failed' &&
      connectionState !== 'closed'
    ) {
      throw toLiveHttpError(
        new LiveSessionRefusal(
          400,
          'validation_failed',
          'connection state event requires "connectionState": connecting | connected | failed | closed (report what the RTCPeerConnection actually reported — no other values exist)',
          { received: String(connectionState) },
        ),
      );
    }
    validated = { kind: 'connection', connectionState };
  } else if (kind === 'performance') {
    validated = { kind: 'performance', delta: normalizePerformanceDelta(input.delta) };
  } else if (kind === 'agent') {
    const agentState = input.agentState;
    if (typeof agentState !== 'string' || !(LIVE_PERFORMANCE_STATES as readonly string[]).includes(agentState)) {
      throw toLiveHttpError(
        new LiveSessionRefusal(
          400,
          'validation_failed',
          `agent state must be one of the P4 surface states: ${LIVE_PERFORMANCE_STATES.join(', ')}`,
          { received: String(agentState) },
        ),
      );
    }
    validated = { kind: 'agent', agentState };
  } else {
    throw toLiveHttpError(
      new LiveSessionRefusal(
        400,
        'validation_failed',
        'state event "kind" must be "connection", "performance" or "agent"',
        { received: String(kind) },
      ),
    );
  }

  const now = new Date();

  // the state-dependent fold + persist runs under the per-session lock
  return withSessionLock(session.id, async () => {
    const fresh = (await db.liveSession.findUnique({ where: { id: session.id } })) ?? session;
    if (!(await sessionGrantActive(tenantId, fresh))) {
      await refuseConsentEnded(tenantId, fresh, 'state events');
    }
    const state = parseSignalingState(fresh.signaling);
    const status = parseLiveSessionStatus(fresh.status);

    let next: LiveSignalingState = state;
    let nextStatus: LiveSessionStatus = status;
    let event: LiveStateEvent;
    let statusEvent: string | null = null; // live.session.connected|failed|ended

    if (validated.kind === 'connection') {
      const transition = applyConnectionTransition(status, state.phase, validated.connectionState);
      nextStatus = transition.status;
      next = { ...state, phase: transition.phase, lastConnectionState: validated.connectionState };
      event = {
        eventId: crypto.randomUUID(),
        seq: state.nextSeq,
        kind: 'connection',
        state: validated.connectionState,
        delta: null,
        source: 'client',
        timestamp: now.toISOString(),
      };
      if (transition.statusChanged) {
        statusEvent =
          transition.status === 'live'
            ? 'live.session.connected'
            : transition.status === 'failed'
              ? 'live.session.failed'
              : 'live.session.ended';
      }
    } else if (validated.kind === 'performance') {
      event = {
        eventId: crypto.randomUUID(),
        seq: state.nextSeq,
        kind: 'performance',
        state: null,
        delta: validated.delta,
        source: 'client',
        timestamp: now.toISOString(),
      };
    } else {
      next = { ...state, currentAgentState: validated.agentState };
      event = {
        eventId: crypto.randomUUID(),
        seq: state.nextSeq,
        kind: 'agent',
        state: validated.agentState,
        delta: null,
        source: 'client',
        timestamp: now.toISOString(),
      };
    }

    const appended = appendStateEvent(next, event, idempotencyKey);
    if (appended.duplicate) {
      // honest replay: the original event is returned, nothing re-appended
      return {
        eventId: appended.eventId,
        duplicate: true,
        status,
        phase: state.phase,
        currentAgentState: state.currentAgentState,
      };
    }

    await db.liveSession.update({
      where: { id: fresh.id },
      data: {
        status: nextStatus,
        ...(nextStatus === 'ended' && fresh.endedAt === null ? { endedAt: now } : {}),
        signaling: JSON.stringify(appended.state),
      },
    });

    await emitEvent(tenantId, 'live.state.recorded', 'live_session', fresh.id, {
      sessionId: fresh.id,
      eventId: appended.eventId,
      kind: event.kind,
      ...(event.state !== null ? { state: event.state } : {}),
      ...(event.delta !== null ? { delta: event.delta } : {}),
      status: nextStatus,
      idempotent: false,
    });
    if (statusEvent !== null) {
      await emitEvent(tenantId, statusEvent, 'live_session', fresh.id, {
        sessionId: fresh.id,
        status: nextStatus,
        reason: 'peer-reported',
      });
    }

    return {
      eventId: appended.eventId,
      duplicate: false,
      status: nextStatus,
      phase: appended.state.phase,
      currentAgentState: appended.state.currentAgentState,
    };
  });
}

// ─── Explicit teardown (idempotent) ──────────────────────────────────────────

/**
 * LOCK-FREE core: callers either hold the session lock (refuseConsentEnded)
 * or go through endLiveSession (which takes it). Idempotent on ended rows.
 */
async function endLiveSessionRow(
  tenantId: string,
  session: LiveSession,
  reason: 'explicit' | 'peer-closed' | 'consent-revoked',
): Promise<LiveSession> {
  if (parseLiveSessionStatus(session.status) === 'ended') return session; // idempotent
  const now = new Date();
  const state = parseSignalingState(session.signaling);
  const ended = await db.liveSession.update({
    where: { id: session.id },
    data: {
      status: 'ended',
      endedAt: now,
      signaling: JSON.stringify({ ...state, phase: 'closed' }),
    },
  });
  await emitEvent(tenantId, 'live.session.ended', 'live_session', session.id, {
    sessionId: session.id,
    endedAt: now.toISOString(),
    reason,
    eventCount: state.stateEvents.length,
  });
  return ended;
}

/** POST [id]/end — explicit teardown. Idempotent: already-ended returns ok. */
export async function endLiveSession(tenantId: string, sessionId: string): Promise<void> {
  const session = await db.liveSession.findFirst({ where: { id: sessionId, tenantId } });
  if (!session) {
    throw toLiveHttpError(new LiveSessionRefusal(404, 'not_found', `live session "${sessionId}" not found`));
  }
  await withSessionLock(session.id, async () => {
    const fresh = (await db.liveSession.findUnique({ where: { id: session.id } })) ?? session;
    await endLiveSessionRow(tenantId, fresh, 'explicit');
  });
}

// ─── Agent → live bridge (the C6 executor hook) ─────────────────────────────

/**
 * Stream C6 agent-turn states into every live session bound to that agent
 * session (status connecting|live). BEST-EFFORT by law: a live-push failure
 * is logged and never fails the agent turn — the durable turn record is
 * truth, the live log is transport. One bounded event per state; one
 * emitEvent per call (batch summary — the event trail stays proportional).
 */
export async function pushAgentStatesToLiveSessions(
  tenantId: string,
  agentSessionId: string,
  states: { state: PerformanceState; note?: string }[],
): Promise<void> {
  if (states.length === 0) return;
  try {
    const sessions = await db.liveSession.findMany({
      where: {
        tenantId,
        agentSessionId,
        status: { in: ['connecting', 'live'] },
      },
    });
    if (sessions.length === 0) return;

    const now = new Date();
    for (const session of sessions) {
      // each bound session folds under ITS lock (consistent with route writes)
      await withSessionLock(session.id, async () => {
        const fresh = (await db.liveSession.findUnique({ where: { id: session.id } })) ?? session;
        if (parseLiveSessionStatus(fresh.status) === 'ended' || parseLiveSessionStatus(fresh.status) === 'failed') {
          return; // terminal sessions never receive agent pushes
        }
        const state = parseSignalingState(fresh.signaling);
        let next = state;
        for (const s of states) {
          const event: LiveStateEvent = {
            eventId: crypto.randomUUID(),
            seq: next.nextSeq,
            kind: 'agent',
            state: s.state,
            delta: null,
            source: 'agent-runtime',
            timestamp: now.toISOString(),
            ...(s.note ? { meta: { note: s.note } } : {}),
          };
          const appended = appendStateEvent(next, event); // agent pushes are not client-idempotent
          if (appended.duplicate) continue; // unreachable (no key) — kept for shape
          next = appended.state;
          next = { ...next, currentAgentState: s.state };
        }
        await db.liveSession.update({
          where: { id: fresh.id },
          data: { signaling: JSON.stringify(next) },
        });
      });
    }

    await emitEvent(tenantId, 'live.state.recorded', 'live_session', agentSessionId, {
      agentSessionId,
      liveSessionIds: sessions.map((s) => s.id),
      states: states.map((s) => s.state),
      source: 'agent-runtime',
      note: 'agent turn states streamed to bound live sessions',
    });
  } catch (err) {
    // best-effort law: never break the agent turn on a live-push failure
    console.error(
      `[you/live] pushAgentStatesToLiveSessions(${agentSessionId}) failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Convenience wrapper for the executor: map C6 engine events to surface
 * states and push them (the low-latency path — called per event as the
 * engine emits it).
 */
export async function pushAgentTurnEventToLiveSessions(
  tenantId: string,
  agentSessionId: string,
  event: AgentPerformanceEvent,
): Promise<void> {
  const state = agentEventToLiveState(event);
  if (state === null) return; // 'custom' — no honest surface mapping
  await pushAgentStatesToLiveSessions(tenantId, agentSessionId, [
    { state, note: `agent turn event (${event.type})` },
  ]);
}
