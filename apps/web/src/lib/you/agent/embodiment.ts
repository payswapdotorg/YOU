// ═══════════════════════════════════════════════════════════════════════════
// Embodiment state machine (Worker B lane, P6.B7) — the avatar-UX pure half.
//
// The FULL P4 state set (docs/PHASE_6_HANDOFF.md): listening, reading, typing,
// thinking, tool_use, speaking, interrupted, idle, unavailable.
//
// Honesty laws enforced by this module:
// - NO FAKE LIVENESS: every state deriveEmbodimentState() returns is derived
//   from REAL runtime data only — the C6 session/turn API join (turn job
//   status, the durable job's running step with its detail, the agent turn's
//   recorded performance events) plus real user-side UI events (composer
//   focus/typing, an acknowledged interrupt). There is no animation loop
//   pretending activity; unknown is unknown.
// - THE WHY IS THE STATE: every derivation carries an honest human-readable
//   `why` (turn transparency) — the avatar stage renders it under the state
//   chip so a viewer can always tell WHAT the avatar is doing and WHY.
// - THE TABLE IS THE RUNTIME: EMBODIMENT_TRANSITIONS encodes the direct legal
//   arcs of the turn lifecycle as the C6 runtime actually sequences them
//   (submit → intake steps → model → tool rounds → persist → reply). Illegal
//   direct arcs (e.g. idle → speaking: a reply cannot appear without a
//   submitted turn) are rejected by canTransition(). Polling may SKIP states
//   between observations (a fast local turn can complete inside one poll
//   interval) — that is an honest sampling gap, not a state-machine violation;
//   the table governs the model, not the sampling.
// - THRESHOLDS ARE DISCLOSED, NOT FABRICATED: the runtime does not model
//   playback duration (the engine's speaking event carries durationMs: null —
//   "playback duration is modeled later by performance tracks"). The
//   speaking→idle settle and the generic inactivity threshold both use the
//   single documented IDLE_AFTER_MS constant below.
//
// Zero-import module (erasable TS only — every import is `import type`), the
// runtime-core precedent: importable from node:test contract suites directly.
// ═══════════════════════════════════════════════════════════════════════════
import type { AgentPerformanceEvent } from '../contracts';

// ─── The P4 state set ────────────────────────────────────────────────────────

export const EMBODIMENT_STATES = [
  'listening', 'reading', 'typing', 'thinking', 'tool_use',
  'speaking', 'interrupted', 'idle', 'unavailable',
] as const;

export type EmbodimentState = (typeof EMBODIMENT_STATES)[number];

// ─── The transition table (direct legal arcs of the C6 turn lifecycle) ────────
//
// idle        → listening (user engages the composer) | reading (turn submitted)
//               | unavailable (session ended / chat seam degraded)
// listening   → reading (turn submitted) | idle (composer left idle)
//               | unavailable (session ended)
// reading     → thinking (model called) | unavailable (intake failed)
//               | interrupted (user interrupt)          [queued + load/consent/enforce steps]
// thinking    → tool_use (tool round) | typing (persisting) | unavailable | interrupted
// tool_use    → thinking (follow-up model call) | typing (persisting) | unavailable | interrupted
// typing      → speaking (reply recorded) | unavailable | interrupted   [persist step]
// speaking    → idle (inactivity threshold) | listening | reading (next turn) | unavailable
// interrupted → idle (settles) | listening (re-engage) | reading (new turn) | unavailable
// unavailable → listening | reading (recovery: a new submitted turn) | idle (settles)
//
// Notable ILLEGAL direct arcs (per the runtime's real sequencing):
// idle/listening → thinking|tool_use|typing|speaking (a turn must be submitted
// and taken in first — reading), reading → typing|tool_use|speaking (the model
// is called before anything else), tool_use → speaking (a tool result requires
// a follow-up model call), typing → anything but speaking/unavailable/interrupted
// (persist is the turn's terminal act), speaking → thinking|tool_use|typing (a
// NEW turn passes through reading), interrupted → thinking|tool_use|typing|speaking
// (an interrupted turn settles or re-engages; it cannot resume mid-flight).

export const EMBODIMENT_TRANSITIONS: Readonly<Record<EmbodimentState, readonly EmbodimentState[]>> = {
  idle: ['listening', 'reading', 'unavailable'],
  listening: ['reading', 'idle', 'unavailable'],
  reading: ['thinking', 'unavailable', 'interrupted'],
  thinking: ['tool_use', 'typing', 'unavailable', 'interrupted'],
  tool_use: ['thinking', 'typing', 'unavailable', 'interrupted'],
  typing: ['speaking', 'unavailable', 'interrupted'],
  speaking: ['idle', 'listening', 'reading', 'unavailable'],
  interrupted: ['idle', 'listening', 'reading', 'unavailable'],
  unavailable: ['listening', 'reading', 'idle'],
};

/** Is the direct arc from → to legal per the runtime's turn lifecycle? */
export function canTransition(from: EmbodimentState, to: EmbodimentState): boolean {
  if (from === to) return true; // holding a state is always legal
  return EMBODIMENT_TRANSITIONS[from]?.includes(to) ?? false;
}

// ─── Inactivity threshold ────────────────────────────────────────────────────

/**
 * The single documented inactivity threshold: with no in-flight turn job, no
 * composer activity and no interrupt pending, the avatar settles to idle after
 * this long. 60s is a PRESENTATION choice (disclosed here), not a measured
 * runtime property — the runtime emits no playback or attention durations.
 */
export const IDLE_AFTER_MS = 60_000;

// ─── Input shapes (mirrors the session-view join the Studio already holds) ────

export interface EmbodimentJobStepView {
  key: string;
  label: string;
  status: string;
  detail?: string;
}

export interface EmbodimentTurnSnapshot {
  role: 'user' | 'agent';
  createdAt: string;
  /** the durable agent.turn job driving this exchange (user turns). */
  jobId?: string | null;
  /** queued|provisioning|running|collecting|succeeded|failed|cancelled|unavailable|dead */
  jobStatus?: string | null;
  jobError?: string | null;
  jobProgress?: number | null;
  /** the job's current RUNNING step (in-flight only; null when idle/none). */
  jobStep?: EmbodimentJobStepView | null;
  jobFinishedAt?: string | null;
  /** recorded performance events (agent turns; thinking → tool_use → … → speaking). */
  states?: AgentPerformanceEvent[];
}

export interface EmbodimentDeriveInput {
  sessionStatus: 'live' | 'ended';
  endedAt?: string | null;
  /** ordered oldest → newest, the session view's turn list. */
  turns: EmbodimentTurnSnapshot[];
  /** the user is composing in the chat input (a REAL UI event, not a timer). */
  composerActive?: boolean;
  /** jobs the user interrupted (acknowledged by the interrupt API). */
  interruptedJobIds?: string[];
  /**
   * honest degraded-chat flag: set when the LAST turn SUBMIT was refused by
   * the accept-time circuit breaker (503) — the chat seam is genuinely
   * unavailable until a later submit succeeds.
   */
  providerDegradedWhy?: string | null;
  /** injectable clock (tests); defaults to Date.now(). */
  now?: number | string | Date;
  /** inactivity threshold override (tests); defaults to IDLE_AFTER_MS. */
  idleAfterMs?: number;
}

export interface EmbodimentDerived {
  state: EmbodimentState;
  /** anchor timestamp for the state (event/turn/job time; null when none). */
  since: string | null;
  /** the transparency line — always set, always honest. */
  why: string;
  /** a turn job is currently queued/running. */
  inFlight: boolean;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function ts(value: number | string | Date): number {
  const t = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? t : NaN;
}

function rel(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function clip(text: string | null | undefined, max = 160): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Is this turn's job still driving the exchange? (Mirrors the Studio's
 * turnJobPending — queued/running only; cancelled/failed/dead are terminal.)
 */
export function embodimentTurnPending(turn: EmbodimentTurnSnapshot): boolean {
  return turn.jobId != null && (turn.jobStatus === 'queued' || turn.jobStatus === 'running');
}

// ─── The in-flight phase mapping (job step → state + why) ─────────────────────

/**
 * Map the durable job's CURRENT running step to the honest embodiment state.
 * The agent.turn executor reports steps: load → consent → enforce → reply →
 * persist; inside `reply` the executor re-reports a running detail
 * ("waiting on model — …" / "tool round N: <tool>") via the engine's onPhase
 * seam, which is what makes tool-level transparency observable at the API.
 */
function inFlightState(turn: EmbodimentTurnSnapshot): { state: EmbodimentState; why: string } {
  if (turn.jobStatus === 'queued') {
    return { state: 'reading', why: 'turn queued — waiting for the runtime to pick it up' };
  }
  const step = turn.jobStep;
  if (!step || step.status !== 'running') {
    return { state: 'reading', why: 'turn running — awaiting the first step report' };
  }
  switch (step.key) {
    case 'load':
      return { state: 'reading', why: 'reading the session, pinned Body/Soul snapshots and history' };
    case 'consent':
      return { state: 'reading', why: 're-verifying embodiment consent (server-enforced, fail-closed)' };
    case 'enforce':
      return { state: 'reading', why: 'enforcing the capability manifests (server-side)' };
    case 'persist':
      return { state: 'typing', why: 'recording the reply — events, seed and latency' };
    case 'reply': {
      const detail = step.detail?.trim() ?? '';
      if (detail.startsWith('tool round')) {
        return { state: 'tool_use', why: detail };
      }
      if (detail.startsWith('waiting on model')) {
        return { state: 'thinking', why: detail };
      }
      return { state: 'thinking', why: 'running the Soul — LLM turns + bounded tool rounds' };
    }
    default:
      // unknown step key: honest generic — the step label IS the truth
      return { state: 'reading', why: clip(step.label) || 'turn running' };
  }
}

// ─── The derivation (pure; per data snapshot, no hidden state) ───────────────

export function deriveEmbodimentState(input: EmbodimentDeriveInput): EmbodimentDerived {
  const nowMs = ts(input.now ?? Date.now());
  const idleAfter = input.idleAfterMs ?? IDLE_AFTER_MS;

  // 1. an ended session makes the avatar permanently unavailable
  if (input.sessionStatus !== 'live') {
    const at = input.endedAt ?? null;
    return {
      state: 'unavailable',
      since: at,
      why: at ? `session ended ${rel(ts(at), nowMs)} — the avatar is unavailable (start a new session to re-engage)` : 'session ended — the avatar is unavailable',
      inFlight: false,
    };
  }

  const turns = input.turns ?? [];

  // 2. honest degraded chat seam (the last submit was refused by the breaker)
  if (input.providerDegradedWhy) {
    return { state: 'unavailable', since: null, why: input.providerDegradedWhy, inFlight: false };
  }

  // 3. a live turn job drives the avatar (latest pending user turn wins)
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn.role === 'user' && embodimentTurnPending(turn)) {
      const interrupted = (input.interruptedJobIds ?? []).includes(turn.jobId ?? '');
      if (interrupted) {
        return {
          state: 'interrupted',
          since: turn.createdAt,
          why:
            turn.jobStatus === 'queued'
              ? 'you interrupted this turn — cancellation pending pickup (the queued job is cancelled before it runs)'
              : 'you interrupted this turn — the runtime has no cooperative cancel seam, so the in-flight turn may still complete and be recorded',
          inFlight: true,
        };
      }
      const phase = inFlightState(turn);
      return { state: phase.state, since: turn.createdAt, why: phase.why, inFlight: true };
    }
  }

  // 4. the latest user turn's terminal outcome (sticky until the next submit)
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn.role !== 'user' || !turn.jobId) continue;
    if (turn.jobStatus === 'failed' || turn.jobStatus === 'dead') {
      return {
        state: 'unavailable',
        since: turn.jobFinishedAt ?? turn.createdAt,
        why: `last turn ${turn.jobStatus === 'dead' ? 'dead-lettered' : 'failed'} — ${clip(turn.jobError) || 'no error recorded'}; send a message to retry`,
        inFlight: false,
      };
    }
    if (turn.jobStatus === 'cancelled') {
      const at = turn.jobFinishedAt ?? turn.createdAt;
      if (Number.isFinite(ts(at)) && nowMs - ts(at) < idleAfter) {
        return {
          state: 'interrupted',
          since: at,
          why: 'turn interrupted — cancelled before the runtime picked it up; no reply was produced',
          inFlight: false,
        };
      }
    }
    break; // the latest jobbed user turn is the outcome anchor
  }

  // 5. the user is composing — the avatar attends (a real UI event)
  if (input.composerActive) {
    return { state: 'listening', since: null, why: 'listening — you are composing a message', inFlight: false };
  }

  // 6/7. last real activity: a completed agent turn speaks until the idle threshold
  // (-Infinity seed: NaN comparisons never win, which would silence the threshold)
  let lastActivityAt = -Infinity;
  for (const turn of turns) {
    const t = ts(turn.createdAt);
    if (Number.isFinite(t) && t > lastActivityAt) lastActivityAt = t;
    for (const ev of turn.states ?? []) {
      const e = ts(ev.timestamp);
      if (Number.isFinite(e) && e > lastActivityAt) lastActivityAt = e;
    }
    const f = ts(turn.jobFinishedAt ?? NaN);
    if (Number.isFinite(f) && f > lastActivityAt) lastActivityAt = f;
  }

  if (turns.length === 0) {
    return {
      state: 'idle',
      since: null,
      why: 'idle — awaiting the first message; send one to drive the avatar',
      inFlight: false,
    };
  }

  if (Number.isFinite(lastActivityAt) && nowMs - lastActivityAt >= idleAfter) {
    return {
      state: 'idle',
      since: new Date(lastActivityAt).toISOString(),
      why: `idle — no activity for ${rel(lastActivityAt, nowMs)} (inactivity threshold ${Math.round(idleAfter / 1000)}s); send a message to re-engage`,
      inFlight: false,
    };
  }

  // within the activity window: the avatar reflects the last recorded
  // embodiment event ('custom' track frames are not lifecycle states — skip)
  let lastEvent: AgentPerformanceEvent | null = null;
  for (const turn of turns) {
    for (const ev of turn.states ?? []) {
      if (ev.type !== 'custom') lastEvent = ev;
    }
  }
  if (lastEvent) {
    return {
      state: lastEvent.type as EmbodimentState,
      since: lastEvent.timestamp,
      why: `last recorded event — ${lastEvent.type} ${rel(ts(lastEvent.timestamp), nowMs)} (the runtime does not model playback duration; the next turn or the ${Math.round(idleAfter / 1000)}s inactivity threshold settles this to idle)`,
      inFlight: false,
    };
  }

  return {
    state: 'idle',
    since: Number.isFinite(lastActivityAt) ? new Date(lastActivityAt).toISOString() : null,
    why: 'idle — the session is live with no turn in flight',
    inFlight: false,
  };
}
