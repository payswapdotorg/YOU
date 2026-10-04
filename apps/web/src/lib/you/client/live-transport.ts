// ═══════════════════════════════════════════════════════════════════════════
// Live transport — the browser-side RTCPeerConnection wrapper (P6.C7).
//
// A provider-neutral, honest WebRTC transport for live sessions:
//  - signal exchange runs through the real signal route (POST to relay, GET
//    to poll). V1 TRANSPORT IS HTTP POLLING — a documented honest limit, not
//    a hidden WebSocket promise; the poll interval is configurable.
//  - the data channel `you-performance` carries performance state (gaze /
//    expression / speech deltas + agent surface states) as small JSON
//    messages — the low-latency path, fully separate from offline rendering.
//  - the connection lifecycle reports EXACTLY what RTCPeerConnection
//    reports (connecting → connected | failed | closed) through the state
//    route; a live badge can only appear after a REAL peer connection.
//
// Honest limits (documented, no overclaiming):
//  - no default STUN/TURN servers are configured (opts.iceServers is empty
//    by default) — host candidates connect same-machine/localhost peers
//    (the loopback self-test); production deployments inject their own
//    infrastructure via opts.iceServers;
//  - renegotiation is not attempted (the server enforces one offer/answer
//    exchange per session — open a new session instead);
//  - polling continues until close(); transient poll errors surface as
//    transport events and never fabricate a connection state.
// ═══════════════════════════════════════════════════════════════════════════
import { api, uid } from './api';
import type { LivePerformanceDelta } from '../live/live-core';

export type LiveTransportRole = 'initiator' | 'responder';

export type LiveTransportEvent =
  | { type: 'connection'; connectionState: 'connecting' | 'connected' | 'failed' | 'closed' }
  | { type: 'agent-state'; state: string; at: string }
  | { type: 'performance'; delta: LivePerformanceDelta; at: string }
  | { type: 'phase'; phase: string }
  | { type: 'error'; message: string };

export interface LiveTransportOptions {
  sessionId: string;
  signalingToken: string;
  role: LiveTransportRole;
  /** signaling poll interval (default 1200ms — the v1 polling transport). */
  pollMs?: number;
  /** ICE servers; EMPTY by default (host candidates only — see header law). */
  iceServers?: RTCIceServer[];
  onEvent?: (event: LiveTransportEvent) => void;
}

interface ChannelMessage {
  type: 'performance' | 'agent-state';
  delta?: LivePerformanceDelta;
  state?: string;
  at?: string;
}

/**
 * One WebRTC peer bound to one live session. The caller creates two of these
 * (initiator + responder) — in one page for the honest loopback self-test,
 * or across browsers for a real remote peer.
 */
export class LiveTransport {
  readonly sessionId: string;
  readonly role: LiveTransportRole;
  private readonly token: string;
  private readonly pollMs: number;
  private readonly onEvent?: (event: LiveTransportEvent) => void;
  private readonly iceServers: RTCIceServer[];

  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private lastSeq = 0;
  private remoteDescriptionSet = false;
  private closed = false;

  constructor(opts: LiveTransportOptions) {
    this.sessionId = opts.sessionId;
    this.role = opts.role;
    this.token = opts.signalingToken;
    this.pollMs = opts.pollMs ?? 1200;
    this.onEvent = opts.onEvent;
    this.iceServers = opts.iceServers ?? [];
  }

  /** The REAL RTCPeerConnection state (null before connect()). */
  get connectionState(): RTCPeerConnectionState | 'new' {
    return this.pc?.connectionState ?? 'new';
  }

  private emit(event: LiveTransportEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      /* callback errors never break the transport */
    }
  }

  private reportConnection(state: 'connecting' | 'connected' | 'failed' | 'closed'): void {
    this.emit({ type: 'connection', connectionState: state });
    // best-effort server record — the local state is truth for the UI even
    // if this POST fails (the poll-based monitor re-derives it server-side)
    void api.live
      .submitState(this.sessionId, { kind: 'connection', connectionState: state }, this.token, uid())
      .catch(() => undefined);
  }

  // ─── connect (role-aware) ────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.pc) return;
    if (typeof RTCPeerConnection === 'undefined') {
      throw new Error('RTCPeerConnection is not available in this environment — the live transport requires a browser');
    }
    this.pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.reportConnection('connecting');

    this.pc.onconnectionstatechange = () => {
      const s = this.pc?.connectionState;
      if (s === 'connected') this.reportConnection('connected');
      else if (s === 'failed') this.reportConnection('failed');
      else if (s === 'disconnected') this.emit({ type: 'error', message: 'peer connection reported disconnected — ICE is probing' });
      else if (s === 'closed') this.reportConnection('closed');
    };

    this.pc.onicecandidate = (event) => {
      const candidate = event.candidate?.candidate;
      if (!candidate) return; // end-of-candidates marker — nothing to relay
      void api.live
        .signal(
          this.sessionId,
          {
            kind: 'candidate',
            from: this.role,
            candidate,
            sdpMid: event.candidate?.sdpMid ?? null,
            sdpMLineIndex: event.candidate?.sdpMLineIndex ?? null,
          },
          this.token,
        )
        .catch((err) => this.emit({ type: 'error', message: `ICE candidate relay failed — ${describeError(err)}` }));
    };

    if (this.role === 'initiator') {
      // the initiator owns the data channel and sends the offer
      this.channel = this.pc.createDataChannel('you-performance');
      this.wireChannel(this.channel);
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      await api.live.signal(
        this.sessionId,
        { kind: 'offer', from: 'initiator', sdp: offer.sdp ?? '' },
        this.token,
      );
      this.emit({ type: 'phase', phase: 'offered' });
    } else {
      // the responder waits for the offer on the first poll
      this.pc.ondatachannel = (event) => {
        this.channel = event.channel;
        this.wireChannel(this.channel);
      };
    }

    this.startPolling();
  }

  private wireChannel(channel: RTCDataChannel): void {
    channel.onopen = () => {
      // the channel is open; the connection event still comes from the pc
      // itself (never fabricate `connected` from an open channel alone)
    };
    channel.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as ChannelMessage;
        if (message.type === 'performance' && message.delta) {
          this.emit({ type: 'performance', delta: message.delta, at: message.at ?? new Date().toISOString() });
        } else if (message.type === 'agent-state' && message.state) {
          this.emit({ type: 'agent-state', state: message.state, at: message.at ?? new Date().toISOString() });
        }
      } catch {
        this.emit({ type: 'error', message: 'received a non-JSON data channel message — skipped (the channel speaks JSON only)' });
      }
    };
  }

  // ─── signaling poll loop (the documented v1 transport) ───────────────────

  private startPolling(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.pollMs);
  }

  private async pollOnce(): Promise<void> {
    if (this.polling || this.closed || !this.pc) return;
    this.polling = true;
    try {
      const view = await api.live.pollSignal(this.sessionId, this.lastSeq);
      // phase progression (honest — from the server's state machine)
      // apply the remote answer (initiator) or the remote offer (responder)
      if (this.role === 'initiator' && view.answer && !this.remoteDescriptionSet) {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: view.answer.sdp });
        this.remoteDescriptionSet = true;
        this.emit({ type: 'phase', phase: 'answered' });
      }
      if (this.role === 'responder' && view.offer && !this.remoteDescriptionSet) {
        await this.pc.setRemoteDescription({ type: 'offer', sdp: view.offer.sdp });
        this.remoteDescriptionSet = true;
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        await api.live.signal(this.sessionId, { kind: 'answer', from: 'responder', sdp: answer.sdp ?? '' }, this.token);
        this.emit({ type: 'phase', phase: 'answered' });
      }
      // trickle the REMOTE candidates (skip our own — the poll carries both)
      for (const candidate of view.candidates) {
        if (candidate.seq <= this.lastSeq) continue;
        this.lastSeq = candidate.seq;
        if (candidate.from === this.role) continue;
        try {
          await this.pc.addIceCandidate({
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid ?? undefined,
            sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
          });
        } catch (err) {
          this.emit({ type: 'error', message: `addIceCandidate skipped — ${describeError(err)}` });
        }
      }
    } catch (err) {
      this.emit({ type: 'error', message: `signaling poll failed — ${describeError(err)}` });
    } finally {
      this.polling = false;
    }
  }

  // ─── performance state over the data channel (low latency) ───────────────

  /** Send one performance delta — data channel when open, state route otherwise. */
  async sendPerformance(delta: LivePerformanceDelta): Promise<void> {
    const message: ChannelMessage = { type: 'performance', delta, at: new Date().toISOString() };
    if (this.channel && this.channel.readyState === 'open') {
      this.channel.send(JSON.stringify(message));
      return;
    }
    // honest fallback: the channel is not open yet — persist via the state
    // route so the delta is not silently dropped
    await api.live.submitState(this.sessionId, { kind: 'performance', delta }, this.token, uid());
  }

  /** Send one agent surface state over the data channel (peer-driven state). */
  async sendAgentState(state: string): Promise<void> {
    const message: ChannelMessage = { type: 'agent-state', state, at: new Date().toISOString() };
    if (this.channel && this.channel.readyState === 'open') {
      this.channel.send(JSON.stringify(message));
      return;
    }
    await api.live.submitState(this.sessionId, { kind: 'agent', agentState: state }, this.token, uid());
  }

  // ─── teardown ─────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    try {
      this.channel?.close();
    } catch {
      /* already closed */
    }
    const pc = this.pc;
    this.pc = null;
    try {
      pc?.close();
    } catch {
      /* already closed */
    }
    this.reportConnection('closed');
    // explicit teardown: the server records the ended status + closed phase
    await api.live.end(this.sessionId).catch(() => undefined);
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * The honest loopback self-test: TWO real RTCPeerConnections (initiator +
 * responder) exchanging REAL SDP/ICE through the REAL signal route, with a
 * REAL data channel between them. It proves the relay + transport work
 * end-to-end without pretending a remote human is connected — the caller
 * labels it as a self-test in the UI.
 */
export async function runLoopbackSelfTest(
  sessionId: string,
  signalingToken: string,
  onEvent?: (event: LiveTransportEvent) => void,
  opts?: { pollMs?: number },
): Promise<{
  connected: boolean;
  initiator: LiveTransport;
  responder: LiveTransport;
  roundTripMs: number | null;
}> {
  let performanceSeen: (() => void) | null = null;
  const route = (event: LiveTransportEvent): void => {
    if (event.type === 'performance') performanceSeen?.();
    try {
      onEvent?.(event);
    } catch {
      /* best-effort */
    }
  };

  const initiator = new LiveTransport({
    sessionId,
    signalingToken,
    role: 'initiator',
    pollMs: opts?.pollMs ?? 400, // faster polling: the self-test is interactive
    onEvent: route,
  });
  const responder = new LiveTransport({
    sessionId,
    signalingToken,
    role: 'responder',
    pollMs: opts?.pollMs ?? 400,
    onEvent: route,
  });

  await initiator.connect();
  await responder.connect();

  // wait (bounded) for the REAL peer connection to connect
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (initiator.connectionState === 'connected' && responder.connectionState === 'connected') break;
    if (initiator.connectionState === 'failed' || responder.connectionState === 'failed') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const connected =
    initiator.connectionState === 'connected' && responder.connectionState === 'connected';

  // round-trip proof: a performance delta over the REAL data channel
  let roundTripMs: number | null = null;
  if (connected) {
    await new Promise<void>((resolve) => {
      const startedAt = Date.now();
      const timer = setTimeout(resolve, 5000); // bounded wait — never hangs
      performanceSeen = () => {
        roundTripMs = Date.now() - startedAt;
        clearTimeout(timer);
        resolve();
      };
      void initiator.sendPerformance({ expression: 'self-test', intensity: 0.5 }).catch(() => resolve());
    });
    performanceSeen = null;
  }

  return { connected, initiator, responder, roundTripMs };
}
