'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Live — the REALTIME PERFORMANCE surface (P6.C7 — Worker C lane).
//
// What is REAL here (was an honest stub until P6.C7):
//  - /api/v1/live-sessions exists: create (consent-enforced — a grant
//    covering live performance is REQUIRED), list/detail, signaling relay
//    (offer/answer/ICE with an honest state machine), state events
//    (idempotent), explicit end;
//  - the browser transport (lib/you/client/live-transport.ts) wraps a REAL
//    RTCPeerConnection: SDP/ICE exchange through the signal route (HTTP
//    polling in v1 — documented), a `you-performance` data channel, honest
//    connection lifecycle (a `live` badge only appears after a REAL peer
//    reports connected);
//  - agent binding: live sessions bound to a C6 agent session show the
//    agent's REAL turn states (listening → thinking → tool_use → speaking
//    → idle) streamed by the agent.turn executor — the low-latency path,
//    fully separate from offline rendering;
//  - the connection self-test opens TWO real peers through the real relay
//    (labeled self-test — never pretending a remote human connected).
//
// Honest limits kept visible below ("What's real vs gated"): no server-side
// media peer/SFU yet (two browsers connect peer-to-peer through the relay);
// polling transport, no WebSocket/SSE; no live-rendered twin mesh — the
// stage visualizes states only. No fake liveness anywhere.
// ═══════════════════════════════════════════════════════════════════════════
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import {
  Activity, BadgeCheck, Cable, Eye, Loader2, MapIcon, Radio, RefreshCcw, ShieldAlert,
  Sparkles, StopCircle, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, uid, YouApiError } from '@/lib/you/client/api';
import type { LiveSessionSummaryView, LiveSessionView } from '@/lib/you/live/live-core';
import type { AgentPerformanceEvent } from '@/lib/you/contracts';
import { LiveTransport, runLoopbackSelfTest, type LiveTransportEvent } from '@/lib/you/client/live-transport';
import { useYouStore } from '@/hooks/you/use-you-store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { EmptyState, IdChip, PageHeader, SectionCard, StatusBadge } from '@/components/you/shared/primitives';
import { AvatarStage } from '@/components/you/agent/avatar-stage';
import { ApiErrorSurface, useApiErrorSurface } from '@/components/you/shared/degraded-state';
import { QueryError } from '@/components/you/build/confidence';
import { cn } from '@/lib/utils';

function rel(iso?: string | null): string {
  if (!iso) return '—';
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }); } catch { return iso; }
}

function isConsentError(err: unknown): boolean {
  return err instanceof YouApiError && (err.code === 'consent_required' || err.status === 403);
}

// ─── Start-session column (twin/agent + consent grant picker) ───────────────

function StartLiveCard({ onCreated }: { onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const navigate = useYouStore((s) => s.navigate);
  const createErrors = useApiErrorSurface('Live session create');
  const [mode, setMode] = useState<'twin' | 'agent'>('twin');
  const [twinId, setTwinId] = useState('');
  const [agentSessionId, setAgentSessionId] = useState('');
  const [grantId, setGrantId] = useState('');

  const twins = useQuery({ queryKey: ['twins'], queryFn: () => api.twins.list() });
  const agentSessions = useQuery({ queryKey: ['agent-runtime-sessions'], queryFn: () => api.agentRuntime.sessions() });
  const grants = useQuery({ queryKey: ['consent-grants'], queryFn: () => api.consent.list() });

  const liveAgentSessions = (agentSessions.data ?? []).filter((s) => s.status === 'live');
  const selectedTwin = (twins.data ?? []).find((t) => t.id === twinId) ?? null;
  const selectedAgentSession = liveAgentSessions.find((s) => s.id === agentSessionId) ?? null;
  // the consent subject for the current selection (twin-bound or via the agent session's twin)
  const subjectId = mode === 'twin' ? (selectedTwin?.subjectId ?? null) : null;

  // covering grants: active, embodiment scope, matching subject (twin mode —
  // the server re-validates everything; this picker only PRESENTS candidates)
  const coveringGrants = (grants.data ?? []).filter((g) => {
    if (g.revokedAt) return false;
    if (new Date(g.expiresAt).getTime() <= Date.now()) return false;
    if (!g.scopes.includes('embodiment')) return false;
    if (mode === 'twin') return subjectId === null || g.subjectId === subjectId;
    return true; // agent mode: the server resolves/validates the grant
  });

  const create = useMutation({
    mutationFn: () => {
      const body: { twinId?: string; agentSessionId?: string; consentGrantId?: string } = {};
      if (mode === 'twin' && twinId) body.twinId = twinId;
      if (mode === 'agent' && agentSessionId) body.agentSessionId = agentSessionId;
      if (grantId) body.consentGrantId = grantId;
      return api.live.create(body, uid());
    },
    onSuccess: (result) => {
      toast.success(`Live session opened (${result.session.status}) — a signaling token was minted (valid ~10 min)`);
      setGrantId('');
      // hold the signaling token in memory for this browser tab (never persisted)
      liveTokens.set(result.session.id, result.signalingToken);
      qc.invalidateQueries({ queryKey: ['live-sessions'] });
      onCreated(result.session.id);
    },
    onError: (err) => {
      createErrors.clear();
      if (createErrors.capture(err)) return;
      if (isConsentError(err)) {
        toast.error(err instanceof YouApiError ? err.message : 'consent_required — a grant covering live performance is required');
      } else {
        toast.error(`Live session create failed — ${err instanceof YouApiError ? err.message : 'request failed'}`);
      }
    },
  });

  const canCreate =
    mode === 'twin'
      ? !!twinId && (coveringGrants.length > 0 || grants.isSuccess)
      : !!agentSessionId;

  return (
    <SectionCard
      title="Open a live session"
      description="Consent-enforced: a grant covering live performance (embodiment) is required before a session can open."
      icon={Radio}
    >
      {twins.isPending || grants.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-2/3" />
        </div>
      ) : twins.isError || grants.isError ? (
        <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-xs text-red-700 dark:text-red-400">
          <QueryError
            error={twins.error ?? grants.error}
            compact
            onRetry={() => { void twins.refetch(); void grants.refetch(); }}
            title="Could not load twins or consent grants"
          />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-2">
            <Label className="text-xs text-muted-foreground">Drive the live performance with</Label>
            <div className="flex gap-1.5">
              <Button
                type="button" size="sm" variant={mode === 'twin' ? 'default' : 'outline'}
                className="gap-1.5" onClick={() => { setMode('twin'); setAgentSessionId(''); setGrantId(''); }}
              >
                <Eye className="size-3.5" aria-hidden /> A twin (human-driven)
              </Button>
              <Button
                type="button" size="sm" variant={mode === 'agent' ? 'default' : 'outline'}
                className="gap-1.5" onClick={() => { setMode('agent'); setTwinId(''); setGrantId(''); }}
              >
                <Activity className="size-3.5" aria-hidden /> An agent session
              </Button>
            </div>
          </div>

          {mode === 'twin' ? (
            <div className="grid gap-1.5">
              <Label htmlFor="live-twin" className="text-xs text-muted-foreground">Twin</Label>
              <Select value={twinId || undefined} onValueChange={(v) => { setTwinId(v); setGrantId(''); }}>
                <SelectTrigger id="live-twin" className="h-9">
                  <SelectValue placeholder={(twins.data ?? []).length ? 'Pick the twin to perform live' : 'No twins yet'} />
                </SelectTrigger>
                <SelectContent>
                  {(twins.data ?? []).map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.displayName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="live-agent" className="text-xs text-muted-foreground">
                Agent session (live only — its turn states drive the live surface)
              </Label>
              <Select value={agentSessionId || undefined} onValueChange={setAgentSessionId}>
                <SelectTrigger id="live-agent" className="h-9">
                  <SelectValue placeholder={liveAgentSessions.length ? 'Pick a live agent session' : 'No live agent sessions'} />
                </SelectTrigger>
                <SelectContent>
                  {liveAgentSessions.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.twinDisplayName} · {s.soulName} · {s.turnCount} turns
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Send turns in Agent Avatars — bound live sessions stream the real turn states here.
              </p>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="live-grant" className="text-xs text-muted-foreground">
              Consent grant{mode === 'twin' ? ' (covering live performance for this twin\'s subject)' : ' (optional — resolved server-side)'}
            </Label>
            <Select value={grantId || undefined} onValueChange={setGrantId} disabled={coveringGrants.length === 0}>
              <SelectTrigger id="live-grant" className="h-9">
                <SelectValue
                  placeholder={
                    coveringGrants.length
                      ? 'Pick a covering grant (or let the server resolve one)'
                      : mode === 'twin' && twinId
                        ? 'No covering grant for this twin — grant consent first'
                        : 'Server resolves a covering grant at create'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {coveringGrants.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.purpose.slice(0, 40)} · expires {rel(g.expiresAt)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {mode === 'twin' && twinId && coveringGrants.length === 0 ? (
              <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 p-2.5 text-[11px] text-amber-800 dark:text-amber-300">
                <div className="flex items-start gap-2">
                  <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <div>
                    No active grant with the <span className="font-mono">embodiment</span> scope covers this twin&apos;s subject —
                    a live session cannot open without one.
                    <button type="button" onClick={() => navigate('trust')}
                      className="ml-1 font-medium underline decoration-amber-500/50 underline-offset-4">
                      Grant consent in Trust
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <Button className="gap-1.5" disabled={!canCreate || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
            Open live session
          </Button>
          <ApiErrorSurface surface={createErrors} onRetry={() => create.mutate()} retrying={create.isPending} />
        </div>
      )}
    </SectionCard>
  );
}

// ─── Session list ────────────────────────────────────────────────────────────

function SessionList({
  sessions, selectedId, onSelect,
}: {
  sessions: LiveSessionSummaryView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <SectionCard
      title="Live sessions"
      description="Newest first — status is honest: `live` appears only after a real peer connection reported connected."
      icon={Radio}
    >
      <div className="you-scroll max-h-96 space-y-1.5 overflow-y-auto pr-1">
        {sessions.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            No live sessions yet — open one on the left.
          </p>
        ) : (
          sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(s.id)}
              className={cn(
                'you-focus flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                s.id === selectedId ? 'border-foreground/25 bg-muted/50' : 'border-transparent bg-muted/20 hover:border-foreground/15',
              )}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {s.twinDisplayName ?? 'twin (via agent session)'}
                </span>
                <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">
                  {s.agentSessionId ? 'agent-bound · ' : ''}{s.eventCount} events · {rel(s.createdAt)}
                </span>
              </span>
              <StatusBadge status={s.status} />
            </button>
          ))
        )}
      </div>
    </SectionCard>
  );
}

// ─── Live state monitor (connection + current performance/agent state) ──────

function agentStateOf(session: LiveSessionView): string | null {
  if (session.status === 'ended' || session.status === 'failed') return 'unavailable';
  return session.currentAgentState;
}

function stageEvents(session: LiveSessionView): AgentPerformanceEvent[] {
  // only agent-state events drive the stage (connection/performance events
  // are transport facts, not avatar states — honest separation)
  return session.stateEvents
    .filter((e) => e.kind === 'agent' && e.state !== null)
    .map((e) => ({
      eventId: e.eventId,
      sessionId: session.id,
      type: e.state as AgentPerformanceEvent['type'],
      timestamp: e.timestamp,
      durationMs: null,
      source: 'application' as const,
      payload: { liveSource: e.source },
    }));
}

function LiveMonitorPanel({ sessionId, onEnded }: { sessionId: string; onEnded: () => void }) {
  const qc = useQueryClient();
  const [endOpen, setEndOpen] = useState(false);
  const [selfTest, setSelfTest] = useState<'idle' | 'running' | 'connected' | 'failed'>('idle');
  const [selfTestRoundTripMs, setSelfTestRoundTripMs] = useState<number | null>(null);
  const transportsRef = useRef<{ initiator: LiveTransport; responder: LiveTransport } | null>(null);
  const eventsEndRef = useRef<HTMLDivElement>(null);
  const endErrors = useApiErrorSurface('Live session end');

  const session = useQuery({
    queryKey: ['live-session', sessionId],
    queryFn: () => api.live.get(sessionId),
    // poll while the session is still an active surface (the v1 transport)
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || data.status === 'ended' || data.status === 'failed') return false;
      return 1500;
    },
  });

  const data = session.data ?? null;
  const active = data?.status === 'connecting' || data?.status === 'live';
  const token = liveTokens.get(sessionId) ?? null;

  useEffect(() => { eventsEndRef.current?.scrollIntoView({ block: 'nearest' }); }, [data?.stateEvents.length, session.isFetching]);

  // teardown self-test transports when switching sessions / unmounting
  useEffect(() => {
    const held = transportsRef.current;
    return () => {
      void held?.initiator.close();
      void held?.responder.close();
    };
  }, [sessionId]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['live-session', sessionId] });
    qc.invalidateQueries({ queryKey: ['live-sessions'] });
  };

  const endSession = useMutation({
    mutationFn: () => api.live.end(sessionId),
    onSuccess: () => {
      toast.success('Live session ended — the state-event ring and signaling state are kept');
      refresh();
      onEnded();
    },
    onError: (err) => {
      endErrors.clear();
      if (endErrors.capture(err)) return;
      toast.error(`End failed — ${err instanceof YouApiError ? err.message : 'request failed'}`);
    },
  });

  const runSelfTest = async () => {
    if (!token) return;
    if (data && data.phase !== 'new') {
      toast.error(`This session already exchanged an offer (phase ${data.phase}) — the self-test needs a fresh session`);
      return;
    }
    setSelfTest('running');
    setSelfTestRoundTripMs(null);
    try {
      const result = await runLoopbackSelfTest(sessionId, token, undefined, { pollMs: 350 });
      transportsRef.current = { initiator: result.initiator, responder: result.responder };
      if (result.connected) {
        setSelfTest('connected');
        setSelfTestRoundTripMs(result.roundTripMs);
        toast.success(`Loopback self-test connected${result.roundTripMs !== null ? ` — data channel round trip ${result.roundTripMs}ms` : ''}`);
      } else {
        setSelfTest('failed');
        toast.error('Self-test did not connect — see the connection trail in the event log');
      }
      refresh();
    } catch (err) {
      setSelfTest('failed');
      toast.error(`Self-test failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (session.isPending) {
    return (
      <SectionCard title="Live monitor" icon={Activity}>
        <div className="space-y-3">
          <Skeleton className="h-44 w-full" />
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-24 w-full" />
        </div>
      </SectionCard>
    );
  }
  if (session.isError) {
    return (
      <SectionCard title="Live monitor" icon={Activity}>
        <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-xs text-red-700 dark:text-red-400">
          <QueryError error={session.error} compact onRetry={() => void session.refetch()} title="Could not load live session" />
        </div>
      </SectionCard>
    );
  }
  if (!data) {
    return null; // pending without error and without data — the skeletons above cover the boot
  }

  const agentState = agentStateOf(data);
  const stage = stageEvents(data);

  return (
    <SectionCard
      title="Live monitor"
      description={data ? (data.twinDisplayName ? `twin: ${data.twinDisplayName}` : 'agent-session-bound') : undefined}
      icon={Activity}
      actions={
        <>
          <Button variant="ghost" size="icon" className="size-7" aria-label="Refresh session" onClick={refresh} disabled={session.isFetching}>
            <RefreshCcw className={session.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'} aria-hidden />
          </Button>
          {active ? (
            <AlertDialog open={endOpen} onOpenChange={setEndOpen}>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="outline" className="gap-1.5 text-red-700 hover:text-red-700 dark:text-red-400 dark:hover:text-red-400">
                  <StopCircle className="size-3.5" aria-hidden /> End
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>End this live session?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Teardown is explicit and idempotent: the state-event ring and relayed signaling state are kept for
                    inspection; the session becomes terminal (no further signaling or state events). The bound twin and
                    any agent session stay untouched.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={(e) => { e.preventDefault(); endSession.mutate(); setEndOpen(false); }}
                    className="bg-red-600 text-white hover:bg-red-700"
                  >
                    {endSession.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                    End session
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </>
      }
    >
      <div className="space-y-4">
        {/* session header */}
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={data.status} />
          <Badge variant="outline" className="font-mono text-[10px]">phase: {data.phase}</Badge>
          {data.agentSessionId ? (
            <Badge variant="outline" className="gap-1 text-[10px] text-violet-700 dark:text-violet-400">
              <Activity className="size-2.5" aria-hidden /> agent session bound
            </Badge>
          ) : null}
          {data.lastConnectionState ? (
            <Badge variant="outline" className="text-[10px]">peer: {data.lastConnectionState}</Badge>
          ) : (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">peer: not reported</Badge>
          )}
          <Badge variant="outline" className="gap-1 text-[10px] text-emerald-700 dark:text-emerald-400">
            <ShieldAlert className="size-2.5" aria-hidden /> consent {data.consentGrantId.slice(0, 10)}…
          </Badge>
          <IdChip id={data.id} label="live" />
        </div>

        {/* the twin stage reacts to REAL agent states (agent-bound sessions stream them) */}
        <AvatarStage state={(agentState as AgentPerformanceEvent['type']) ?? null} stateAt={null} recentEvents={stage} ended={!active} />

        {/* connection self-test (labeled honestly) */}
        <div className="rounded-lg border border-dashed px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs">
              <Cable className="size-3.5 text-muted-foreground" aria-hidden />
              <span className="font-medium">Connection self-test</span>
              <span className="text-muted-foreground">— two real peers through the real relay (this page is both)</span>
            </div>
            <div className="flex items-center gap-2">
              {selfTest !== 'idle' ? (
                <StatusBadge status={selfTest === 'connected' ? 'succeeded' : selfTest === 'failed' ? 'failed' : 'running'} />
              ) : null}
              {selfTestRoundTripMs !== null ? (
                <span className="you-num text-[11px] text-muted-foreground">round trip {selfTestRoundTripMs}ms</span>
              ) : null}
              <Button
                size="sm" variant="outline" className="h-7 gap-1 text-xs"
                disabled={!token || !active || data.phase !== 'new' || selfTest === 'running'}
                onClick={() => void runSelfTest()}
                title={token ? undefined : 'No signaling token in memory — tokens are minted at create and never persisted'}
              >
                {selfTest === 'running' ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Cable className="size-3" aria-hidden />}
                Run
              </Button>
            </div>
          </div>
          {!token ? (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              No signaling token in memory for this session (tokens are minted at create, held in this tab only, and never
              persisted). Monitoring keeps working; submitting signals needs a fresh session.
            </p>
          ) : data.phase !== 'new' ? (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              The relay already exchanged an offer/answer on this session (phase {data.phase}) — the self-test needs a fresh
              session.
            </p>
          ) : null}
        </div>

        {/* the live state-event ring (bounded, newest last) */}
        <div>
          <div className="mb-2 flex items-center justify-between text-xs font-medium text-muted-foreground">
            <span>State events (bounded ring — newest last)</span>
            <span className="you-num">{data.stateEvents.length}</span>
          </div>
          <div className="you-scroll max-h-72 space-y-1 overflow-y-auto rounded-lg border bg-muted/20 p-2.5">
            {data.stateEvents.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                No state events yet — connection reports, performance deltas and agent states land here.
              </p>
            ) : (
              data.stateEvents.map((e) => (
                <div key={e.eventId} className="flex items-center gap-2 rounded-md px-1.5 py-1 font-mono text-[11px]">
                  <span className="you-num w-10 shrink-0 text-muted-foreground">#{e.seq}</span>
                  <span
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
                      e.kind === 'connection'
                        ? 'bg-zinc-500/12 text-zinc-600 dark:text-zinc-400'
                        : e.kind === 'agent'
                          ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400'
                          : 'bg-amber-500/12 text-amber-700 dark:text-amber-400',
                    )}
                  >
                    {e.kind === 'connection' ? '⇄' : e.kind === 'agent' ? '◉' : '✦'} {e.kind}
                    {e.state ? `: ${e.state}` : ''}
                  </span>
                  {e.delta ? (
                    <span className="truncate text-muted-foreground">
                      {e.delta.expression ? `expr:${e.delta.expression} ` : ''}
                      {e.delta.speech ? `speech:"${e.delta.speech.slice(0, 40)}" ` : ''}
                      {e.delta.gaze ? `gaze(${e.delta.gaze.x},${e.delta.gaze.y}) ` : ''}
                      {e.delta.intensity !== undefined ? `i:${e.delta.intensity}` : ''}
                    </span>
                  ) : null}
                  <span className="ml-auto shrink-0 text-muted-foreground">
                    {new Date(e.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              ))
            )}
            <div ref={eventsEndRef} />
          </div>
        </div>

        {/* relay facts */}
        <div className="grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-3">
          <div className="rounded-lg border bg-muted/20 px-2.5 py-2">
            <div className="font-medium text-foreground">Offer / answer</div>
            <div>{data.signaling.hasOffer ? 'relayed' : '—'} / {data.signaling.hasAnswer ? 'relayed' : '—'}</div>
          </div>
          <div className="rounded-lg border bg-muted/20 px-2.5 py-2">
            <div className="font-medium text-foreground">ICE candidates</div>
            <div className="you-num">{data.signaling.candidateCount} relayed</div>
          </div>
          <div className="rounded-lg border bg-muted/20 px-2.5 py-2">
            <div className="font-medium text-foreground">Consent grant</div>
            <IdChip id={data.consentGrantId} label="" className="mt-0.5 max-w-full" />
          </div>
        </div>

        {!active ? (
          <div className="flex items-center justify-between rounded-lg border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
            <span>{data.status === 'failed' ? 'Connection failed — terminal in v1; open a new session to retry' : `Ended ${rel(data.endedAt)}`}</span>
            <Trash2 className="size-3.5 opacity-40" aria-hidden />
          </div>
        ) : null}

        <ApiErrorSurface surface={endErrors} onRetry={() => endSession.mutate()} retrying={endSession.isPending} />
      </div>
    </SectionCard>
  );
}

// ─── In-tab signaling token registry (never persisted) ─────────────────────

const liveTokens = new Map<string, string>();

// ─── The view ────────────────────────────────────────────────────────────────

export function LiveView() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const sessions = useQuery({ queryKey: ['live-sessions'], queryFn: () => api.live.sessions() });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Build"
        title="Live"
        description="Realtime, interactive avatar sessions over WebRTC — low-latency performance state, fully separate from offline rendering."
        actions={<Badge variant="outline" className="gap-1.5 text-muted-foreground"><Radio className="size-3" aria-hidden /> v1 transport</Badge>}
      />

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <div className="space-y-4">
          <StartLiveCard onCreated={setSelectedId} />
          {sessions.isPending ? (
            <SectionCard title="Live sessions" icon={Radio}>
              <Skeleton className="h-24 w-full" />
            </SectionCard>
          ) : sessions.isError ? (
            <SectionCard title="Live sessions" icon={Radio}>
              <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-xs text-red-700 dark:text-red-400">
                <QueryError error={sessions.error} compact onRetry={() => void sessions.refetch()} title="Could not load live sessions" />
              </div>
            </SectionCard>
          ) : (
            <SessionList sessions={sessions.data ?? []} selectedId={selectedId} onSelect={setSelectedId} />
          )}
        </div>

        {selectedId ? (
          <LiveMonitorPanel sessionId={selectedId} onEnded={() => setSelectedId(null)} />
        ) : (
          <SectionCard title="Live monitor" icon={Activity}>
            <EmptyState
              icon={Radio}
              title="Select a live session"
              hint="Open a session (left) and pick it in the list — the monitor shows the real connection phase, the current agent state, and the bounded state-event stream."
            />
          </SectionCard>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <SectionCard title="What's real now" icon={BadgeCheck}>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex gap-2"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-emerald-500/70" aria-hidden />The live-session API: consent-enforced create (a grant covering live performance is REQUIRED), signaling relay with an honest offer→answer→candidates state machine, idempotent state events, explicit teardown.</li>
            <li className="flex gap-2"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-emerald-500/70" aria-hidden />A real browser WebRTC transport: RTCPeerConnection + <span className="font-mono text-xs">you-performance</span> data channel; the connection self-test connects two real peers through the real relay.</li>
            <li className="flex gap-2"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-emerald-500/70" aria-hidden />Agent-bound sessions stream the C6 runtime&apos;s REAL turn states (listening → thinking → tool_use → speaking → idle) — send turns in Agent Avatars and watch them land here.</li>
            <li className="flex gap-2"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-emerald-500/70" aria-hidden />A <span className="font-mono text-xs">live</span> badge only appears after a real peer connection reports <span className="font-mono text-xs">connected</span> — never fabricated.</li>
          </ul>
        </SectionCard>
        <SectionCard title="What's still gated" icon={MapIcon}>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex gap-2"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden />No server-side media peer/SFU yet — two browsers connect peer-to-peer through the relay; a hosted realtime avatar renderer is future work.</li>
            <li className="flex gap-2"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden />The v1 signal exchange is HTTP polling (documented) — WebSocket/SSE push lands with the media peer.</li>
            <li className="flex gap-2"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden />No STUN/TURN defaults — host candidates connect same-machine/localhost peers; production deployments inject their own infrastructure.</li>
            <li className="flex gap-2"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden />The twin stage visualizes live STATES only — realtime-rendered twin meshes from live performance streams are Stage 6+.</li>
          </ul>
        </SectionCard>
      </div>
    </div>
  );
}
export default LiveView;
