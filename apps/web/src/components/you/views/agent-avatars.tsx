'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Agent Avatar Studio — P6.C6 production Body/Soul runtime surface.
//
// Bodies (visual/physical avatar assets bound to a TwinVersion + role/tool
// contract) × Souls (personality/behavior configuration bound to a Twin) ×
// Sessions binding (Twin, Body, Soul) with consent provenance. Turns run as
// durable agent.turn jobs through the resilience stack; the chat below is
// REAL turn history (states = emitted performance events, per-turn seed and
// model provenance, honest job-status joins). Degraded/error states follow
// the B8 pattern (typed envelopes, retry guidance, consent surfaces).
//
// P6.B7 — embodiment surface: the avatar stage is driven by the PURE
// deriveEmbodimentState() state machine (lib/you/agent/embodiment.ts) over
// the real session/turn/job join — the FULL P4 state set with an honest WHY
// (turn transparency), a user interrupt of the in-flight turn (interrupted →
// idle), inactivity idle + re-engage, and per-soul provider status from the
// C5 registry health (lib/you/agent/soul-providers.ts). No fake liveness.
// ═══════════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import {
  Bot, ChevronRight, Ghost, Hand, History, Loader2, Lock, MessageSquare, Play, RefreshCcw,
  Send, ShieldAlert, Sparkles, StopCircle, Wrench, Dices,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, uid, YouApiError } from '@/lib/you/client/api';
import type {
  AgentRuntimeBodyView, AgentRuntimeSessionSummaryView, AgentRuntimeSessionView,
  AgentRuntimeSoulView, AgentRuntimeTurnView,
} from '@/lib/you/agent/runtime-core';
import type { AgentPerformanceEvent } from '@/lib/you/contracts';
import { deriveEmbodimentState } from '@/lib/you/agent/embodiment';
import { resolveSoulProviderBinding, type SoulProviderStatusRow } from '@/lib/you/agent/soul-providers';
import { useYouStore } from '@/hooks/you/use-you-store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { BodyCreateDialog } from '@/components/you/agent/body-create-dialog';
import { SoulCreateDialog } from '@/components/you/agent/soul-create-dialog';
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

function isUnavailable(err: unknown): boolean {
  return err instanceof YouApiError && (err.status === 503 || err.code === 'service_unavailable');
}

// ─── Embodiment state (P6.B7 — derived, never animated) ──────────────────────
function allEvents(session: AgentRuntimeSessionView | null | undefined): AgentPerformanceEvent[] {
  if (!session) return [];
  return (session.turns ?? []).flatMap((t) => t.states ?? []);
}

/** A turn exchange is still being driven by its durable job. */
function turnJobPending(turn: AgentRuntimeTurnView): boolean {
  return turn.jobId !== null && (turn.jobStatus === 'queued' || turn.jobStatus === 'running');
}

// ─── Lifecycle control (activate/deactivate) ─────────────────────────────────
function LifecycleButtons({
  kind, id, status,
}: { kind: 'body' | 'soul'; id: string; status: string }) {
  const qc = useQueryClient();
  const mutate = useMutation({
    mutationFn: async (action: 'activate' | 'deactivate'): Promise<{ name: string; status: string }> => {
      const updated =
        kind === 'body'
          ? await api.agentRuntime.updateBody(id, { action }, uid())
          : await api.agentRuntime.updateSoul(id, { action }, uid());
      return { name: updated.name, status: updated.status };
    },
    onSuccess: (updated) => {
      toast.success(`${kind === 'body' ? 'Body' : 'Soul'} “${updated.name}” is now ${updated.status}`);
      qc.invalidateQueries({ queryKey: [kind === 'body' ? 'agent-runtime-bodies' : 'agent-runtime-souls'] });
    },
    onError: (err) => {
      const msg = err instanceof YouApiError ? err.message : 'request failed';
      toast.error(`Lifecycle transition failed — ${msg}`);
    },
  });
  return (
    <div className="flex gap-1.5">
      {status !== 'active' ? (
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={mutate.isPending}
          onClick={() => mutate.mutate('activate')}>
          {mutate.isPending && mutate.variables === 'activate' ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Play className="size-3" aria-hidden />}
          Activate
        </Button>
      ) : (
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs text-amber-700 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-400"
          disabled={mutate.isPending} onClick={() => mutate.mutate('deactivate')}>
          {mutate.isPending && mutate.variables === 'deactivate' ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <StopCircle className="size-3" aria-hidden />}
          Deactivate
        </Button>
      )}
    </div>
  );
}

// ─── Chat column ─────────────────────────────────────────────────────────────
function SessionPanel({
  sessionId, onEnded,
}: {
  sessionId: string;
  onEnded: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useYouStore((s) => s.navigate);
  const [message, setMessage] = useState('');
  const [consentError, setConsentError] = useState<string | null>(null);
  const [endOpen, setEndOpen] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // P6.B7 embodiment inputs — all REAL signals, no fabricated liveness:
  const [composerActive, setComposerActive] = useState(false); // the user is composing (a UI event)
  const [interruptedJobs, setInterruptedJobs] = useState<string[]>([]); // acknowledged interrupts
  const [degradedWhy, setDegradedWhy] = useState<string | null>(null); // last submit refused by the breaker
  const [, setClockTick] = useState(0); // UI clock for the DOCUMENTED idle threshold (state still derives from real data)

  const session = useQuery({
    queryKey: ['agent-runtime-session', sessionId],
    queryFn: () => api.agentRuntime.getSession(sessionId),
    // poll while a durable turn job is in flight (and the session is live)
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || data.status !== 'live') return false;
      return data.turns.some(turnJobPending) ? 1200 : false;
    },
  });

  const data = session.data ?? null;
  const live = data?.status === 'live';
  const events = allEvents(data);

  // P6.B7 — the embodiment state machine: a PURE derivation over the real
  // session/turn/job join + the real UI signals above. Never animated.
  const embodied = deriveEmbodimentState({
    sessionStatus: data?.status ?? 'live',
    endedAt: data?.endedAt ?? null,
    turns: data?.turns ?? [],
    composerActive,
    interruptedJobIds: interruptedJobs,
    providerDegradedWhy: degradedWhy,
  });

  // the settle clock: the inactivity threshold (60s, documented in
  // embodiment.ts) needs a re-render to land — a cheap 15s tick while the
  // panel is mounted. The tick changes NOTHING by itself: the state still
  // derives from real runtime data only.
  useEffect(() => {
    const t = setInterval(() => setClockTick((x) => x + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ block: 'nearest' }); }, [data?.turns.length, session.isFetching]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['agent-runtime-session', sessionId] });
    qc.invalidateQueries({ queryKey: ['agent-runtime-sessions'] });
  };

  const sendTurn = useMutation({
    mutationFn: () => api.agentRuntime.sendTurn(sessionId, message, uid()),
    onSuccess: () => {
      setMessage('');
      setConsentError(null);
      setDegradedWhy(null); // a submit the breaker ACCEPTED clears the degraded flag
      qc.invalidateQueries({ queryKey: ['agent-runtime-session', sessionId] });
    },
    onError: (err) => {
      turnErrors.clear();
      if (turnErrors.capture(err)) return;
      if (isConsentError(err)) {
        setConsentError(err instanceof YouApiError ? err.message : 'consent_required');
      } else if (isUnavailable(err)) {
        const secs = err instanceof YouApiError && err.retryAfterMs ? Math.ceil(err.retryAfterMs / 1000) : null;
        setDegradedWhy(
          `chat provider unavailable — the accept-time circuit breaker refused this turn${secs ? ` (cooling, ~${secs}s)` : ''}; retrying is safe`,
        );
        toast.error(`Chat provider unavailable — retrying is safe${secs ? ` (circuit breaker cooling, ~${secs}s)` : ''}`);
      } else {
        const msg = err instanceof YouApiError ? err.message : 'request failed';
        toast.error(`Turn failed — ${msg}`);
      }
    },
  });

  // P6.B7 — user interrupt of the in-flight turn (honest: queued → effective
  // cancellation; running → durable request that may still complete)
  const interruptTurn = useMutation({
    mutationFn: () => api.agentRuntime.interruptTurn(sessionId, uid()),
    onSuccess: (result) => {
      setInterruptedJobs((ids) => (ids.includes(result.jobId) ? ids : [...ids, result.jobId]));
      if (result.effective) {
        toast.success('Turn cancelled before the runtime picked it up', { description: result.note });
      } else {
        toast.info('Interrupt recorded — the running turn may still complete', { description: result.note });
      }
      qc.invalidateQueries({ queryKey: ['agent-runtime-session', sessionId] });
    },
    onError: (err) => {
      const msg = err instanceof YouApiError ? err.message : 'request failed';
      toast.error(`Interrupt failed — ${msg}`);
    },
  });

  // P6.B8: typed error surfaces for this panel's three mutation flows.
  // capture() runs BEFORE the toasts: 503/429 provider refusals become
  // inline retry guidance; everything capture() declines keeps its toast.
  // Consent (403) is never captured, so its dedicated flow stays intact.
  const turnErrors = useApiErrorSurface('Avatar turn');
  const endErrors = useApiErrorSurface('Session end');

  const endSession = useMutation({
    mutationFn: () => api.agentRuntime.endSession(sessionId),
    onSuccess: () => {
      toast.success('Session ended — turns and events are kept');
      qc.invalidateQueries({ queryKey: ['agent-runtime-session', sessionId] });
      qc.invalidateQueries({ queryKey: ['agent-runtime-sessions'] });
      onEnded();
    },
    onError: (err) => {
      endErrors.clear();
      if (endErrors.capture(err)) return;
      const msg = err instanceof YouApiError ? err.message : 'request failed';
      toast.error(`End failed — ${msg}`);
    },
  });

  if (session.isPending) {
    return (
      <SectionCard title="Session" icon={Bot}>
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
      <SectionCard title="Session" icon={Bot}>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-xs text-red-700 dark:text-red-400">
          <QueryError error={session.error} compact onRetry={() => void session.refetch()} title="Could not load session" />
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Session"
      description={data ? `${data.bodyName} v${data.bodyVersion} · ${data.soulName} v${data.soulVersion}` : undefined}
      icon={Bot}
      actions={
        <>
          <Button variant="ghost" size="icon" className="size-7" aria-label="Refresh session" onClick={refresh} disabled={session.isFetching}>
            <RefreshCcw className={session.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'} aria-hidden />
          </Button>
          {live ? (
            <AlertDialog open={endOpen} onOpenChange={setEndOpen}>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="outline" className="gap-1.5 text-red-700 hover:text-red-700 dark:text-red-400 dark:hover:text-red-400">
                  <StopCircle className="size-3.5" aria-hidden /> End
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>End this agent session?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Teardown is explicit: turns, events and provenance recorded so far are kept; the avatar becomes
                    unavailable. The bound Body and Soul stay untouched.
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
          {/* P6.B8 — session-end flow errors: typed 503/429 refusals render
              inline retry guidance instead of a bare toast. */}
          <ApiErrorSurface surface={endErrors} onRetry={() => endSession.mutate()} retrying={endSession.isPending} />
        </>
      }
    >
      {data ? (
        <div className="space-y-4">
          {/* session header */}
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge status={data.status} />
            <Badge variant="outline" className="gap-1 font-mono text-[10px]">
              <Lock className="size-2.5" aria-hidden /> body: {data.bodyName} v{data.bodyVersion}
            </Badge>
            <Badge variant="outline" className="font-mono text-[10px]">soul: {data.soulName} v{data.soulVersion}</Badge>
            <Badge variant="outline" className="text-[10px]">twin: {data.twinDisplayName}</Badge>
            {data.consentGrantId ? (
              <Badge variant="outline" className="gap-1 text-[10px] text-emerald-700 dark:text-emerald-400">
                <ShieldAlert className="size-2.5" aria-hidden /> consent {data.consentGrantId.slice(0, 10)}…
              </Badge>
            ) : null}
            <Badge variant="outline" className="gap-1 font-mono text-[10px]">
              <Dices className="size-2.5" aria-hidden /> seed {data.seed}
            </Badge>
            <IdChip id={data.id} label="session" />
          </div>

          <AvatarStage state={embodied.state} stateAt={embodied.since} why={embodied.why} recentEvents={events} ended={!live} />

          {/* P6.B7 — idle after inactivity with a real re-engage action
              (focus the composer → the avatar listens) */}
          {live && !embodied.inFlight && embodied.state === 'idle' ? (
            <div className="flex justify-center">
              <Button
                size="sm" variant="outline" className="h-8 gap-1.5 text-xs"
                onClick={() => inputRef.current?.focus()}
              >
                <MessageSquare className="size-3.5" aria-hidden /> Re-engage the avatar
              </Button>
            </div>
          ) : null}

          {/* chat */}
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <MessageSquare className="size-3.5" aria-hidden /> Turns
            </div>
            <div className="you-scroll max-h-80 space-y-2.5 overflow-y-auto rounded-lg border bg-muted/20 p-3">
              {data.turns.length ? (
                data.turns.map((turn) => <TurnBubble key={turn.id} turn={turn} />)
              ) : (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  No turns yet — send the first message to drive the avatar.
                </p>
              )}
              {sendTurn.isPending ? (
                <div className="flex items-start">
                  <div className="flex items-center gap-1.5 rounded-xl border bg-card px-3 py-2">
                    {[0, 1, 2].map((i) => (
                      <span key={i} className="you-pulse size-1.5 rounded-full bg-muted-foreground" style={{ animationDelay: `${i * 0.2}s` }} aria-hidden />
                    ))}
                  </div>
                </div>
              ) : null}
              <div ref={chatEndRef} />
            </div>

            {consentError ? (
              <div className="mt-2 rounded-lg border border-amber-500/35 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">
                <div className="flex items-start gap-2">
                  <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <div>
                    <div className="font-medium">Consent required</div>
                    <p className="mt-0.5">{consentError} — consent is explicit, scoped and re-verified on every turn.</p>
                    <button type="button" onClick={() => navigate('trust')}
                      className="mt-1 inline-flex items-center gap-1 font-medium underline decoration-amber-500/50 underline-offset-4">
                      Review consent grants in Trust <ChevronRight className="size-3" aria-hidden />
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            <form
              className="mt-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (message.trim() && live && !sendTurn.isPending) sendTurn.mutate();
              }}
            >
              <Input
                ref={inputRef}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onFocus={() => setComposerActive(true)}
                onBlur={() => setComposerActive(false)}
                placeholder={live ? 'Message the avatar…' : 'Session ended'}
                disabled={!live || sendTurn.isPending}
                className="h-9"
                aria-label="Message"
              />
              {embodied.inFlight && live ? (
                <Button
                  type="button" size="sm" variant="outline"
                  className="h-11 gap-1.5 text-amber-700 hover:text-amber-700 sm:h-9 dark:text-amber-400 dark:hover:text-amber-400"
                  disabled={interruptTurn.isPending}
                  onClick={() => interruptTurn.mutate()}
                  aria-label="Interrupt the in-flight turn"
                >
                  {interruptTurn.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Hand className="size-3.5" aria-hidden />}
                  <span className="hidden sm:inline">Interrupt</span>
                </Button>
              ) : null}
              <Button type="submit" size="sm" className="h-11 gap-1.5 sm:h-9" disabled={!live || !message.trim() || sendTurn.isPending}>
                {sendTurn.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Send className="size-3.5" aria-hidden />}
                Send
              </Button>
            </form>
          </div>

          {!live ? (
            <div className="flex items-center justify-between rounded-lg border border-dashed px-3 py-2.5">
              <span className="text-xs text-muted-foreground">Ended {rel(data.endedAt)}</span>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => navigate('agent-avatars')}>
                <Play className="size-3.5" aria-hidden /> Start a new session
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </SectionCard>
  );
}

// ─── One turn bubble (chat message + honest provenance + job state) ──────────
function TurnBubble({ turn }: { turn: AgentRuntimeTurnView }) {
  const failed = turn.jobStatus === 'failed' || turn.jobStatus === 'dead';
  const cancelled = turn.jobStatus === 'cancelled';
  const pending = turnJobPending(turn);
  return (
    <div className={cn('flex flex-col', turn.role === 'user' ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[88%] rounded-xl px-3 py-2 text-sm',
          turn.role === 'user'
            ? 'bg-primary text-primary-foreground'
            : 'border bg-card text-card-foreground',
        )}
      >
        {turn.content}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-2 px-1 font-mono text-[10px] text-muted-foreground">
        <span>{new Date(turn.createdAt).toLocaleTimeString()}</span>
        {turn.role === 'agent' && turn.latencyMs != null ? (
          <span className="you-num">{Math.round(turn.latencyMs)} ms</span>
        ) : null}
        {turn.role === 'agent' && turn.model ? <span>{turn.model}</span> : null}
        {turn.role === 'agent' && turn.seed != null ? (
          <span className="inline-flex items-center gap-0.5"><Dices className="size-2.5" aria-hidden /> seed {turn.seed}</span>
        ) : null}
        {turn.role === 'agent' && turn.states?.length ? (
          <span>{turn.states.length} state events</span>
        ) : null}
        {pending ? (
          <span className="you-pulse inline-flex items-center gap-1 text-sky-700 dark:text-sky-400">
            <Loader2 className="size-2.5 animate-spin" aria-hidden /> turn job {turn.jobStatus}
            {turn.jobStep?.detail ? <span className="text-muted-foreground"> · {turn.jobStep.detail}</span> : null}
          </span>
        ) : null}
        {cancelled ? (
          <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
            <Hand className="size-2.5" aria-hidden /> interrupted — cancelled while queued; no reply was produced
          </span>
        ) : null}
      </div>
      {failed && turn.jobError ? (
        <div className="mt-1 max-w-[88%] rounded-lg border border-red-500/25 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-700 dark:text-red-400">
          <span className="font-medium">Turn {turn.jobStatus === 'dead' ? 'dead-lettered' : 'failed'} — </span>
          <span className="font-mono">{turn.jobError.slice(0, 220)}{turn.jobError.length > 220 ? '…' : ''}</span>
          <div className="mt-0.5 text-red-600/80 dark:text-red-400/80">
            Bounded retries were spent before this outcome; the message is preserved. Dead-lettered turns are
            inspectable by operators in Maintenance → dead jobs.
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── Start-session column ────────────────────────────────────────────────────
function StartSessionCard({
  bodies, souls, onStarted,
}: {
  bodies: AgentRuntimeBodyView[];
  souls: AgentRuntimeSoulView[];
  onStarted: (sessionId: string) => void;
}) {
  const qc = useQueryClient();
  const navigate = useYouStore((s) => s.navigate);
  const [bodyId, setBodyId] = useState('');
  const [soulId, setSoulId] = useState('');
  const [consentError, setConsentError] = useState<string | null>(null);

  const activeBodies = bodies.filter((b) => b.status === 'active');
  const activeSouls = souls.filter((s) => s.status === 'active');

  const start = useMutation({
    mutationFn: () => api.agentRuntime.createSession({ bodyId, soulId }, uid()),
    onSuccess: (session) => {
      setConsentError(null);
      toast.success(`Session started — ${session.bodyName} × ${session.soulName} for twin ${session.twinDisplayName}`);
      qc.invalidateQueries({ queryKey: ['agent-runtime-sessions'] });
      onStarted(session.id);
    },
    onError: (err) => {
      if (isConsentError(err)) {
        setConsentError(err instanceof YouApiError ? err.message : 'consent_required');
      } else {
        const msg = err instanceof YouApiError ? err.message : 'request failed';
        toast.error(`Start failed — ${msg}`);
      }
    },
  });

  // derive effective selections from loaded lists (no effects needed)
  const effectiveBodyId = activeBodies.some((b) => b.id === bodyId) ? bodyId : '';
  const effectiveSoulId = activeSouls.some((s) => s.id === soulId) ? soulId : '';
  const canStart = !!effectiveBodyId && !!effectiveSoulId && !start.isPending;

  const chosenSoul = activeSouls.find((s) => s.id === effectiveSoulId);

  return (
    <>
      <SectionCard
        title="Start session"
        description="Bind a Body and a Soul — the session’s twin comes from the Soul and must match the Body’s visual binding."
        icon={Play}
      >
        <div className="space-y-3.5">
          <div className="space-y-1.5">
            <Label className="text-xs">Body <span className="text-muted-foreground">(active only)</span></Label>
            <Select value={effectiveBodyId || undefined} onValueChange={setBodyId}>
              <SelectTrigger className="h-9"><SelectValue placeholder={activeBodies.length ? 'Select body' : 'No active bodies'} /></SelectTrigger>
              <SelectContent>
                {activeBodies.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name} · {b.role}{b.twinDisplayName ? ` · ${b.twinDisplayName}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {bodies.length > 0 && activeBodies.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                Bodies exist but none are active — activate one from the list (lifecycle is explicit).
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Soul <span className="text-muted-foreground">(active only)</span></Label>
            <Select value={effectiveSoulId || undefined} onValueChange={setSoulId}>
              <SelectTrigger className="h-9"><SelectValue placeholder={activeSouls.length ? 'Select soul' : 'No active souls'} /></SelectTrigger>
              <SelectContent>
                {activeSouls.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name} · {s.twinDisplayName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {souls.length > 0 && activeSouls.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                Souls exist but none are active — activate one from the list.
              </p>
            ) : null}
          </div>
          {chosenSoul ? (
            <p className="flex items-start gap-1.5 rounded-md border border-amber-500/25 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-800 dark:text-amber-300">
              <ShieldAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
              Embodiment scope required — the session binds twin <span className="font-medium">{chosenSoul.twinDisplayName}</span>;
              the subject’s consent grant must include <span className="font-mono">embodiment</span> (server-enforced, re-verified per turn).
            </p>
          ) : null}
          <Button className="w-full gap-1.5" disabled={!canStart} onClick={() => start.mutate()}>
            {start.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
            Start session
          </Button>
          {bodies.length === 0 || souls.length === 0 ? (
            <p className="border-t pt-3 text-[11px] text-muted-foreground">
              Create a Body{souls.length === 0 ? ' and a Soul' : ''} above first — sessions need one active Body and one active Soul.
            </p>
          ) : null}
        </div>
      </SectionCard>

      {consentError ? (
        <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-4">
          <div className="flex items-start gap-2.5">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
            <div className="space-y-2">
              <div className="text-sm font-medium text-amber-900 dark:text-amber-200">Consent required</div>
              <p className="text-xs text-amber-800 dark:text-amber-300">
                {consentError} — the embodiment scope for this subject is not granted. Consent is explicit, scoped and
                server-enforced.
              </p>
              <button
                type="button"
                onClick={() => navigate('trust')}
                className="inline-flex items-center gap-1 text-xs font-medium text-amber-900 underline decoration-amber-500/50 underline-offset-4 transition-colors hover:decoration-amber-600 dark:text-amber-200"
              >
                Review consent grants in Trust <ChevronRight className="size-3" aria-hidden />
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

// ─── One Soul card + the P6.B7 per-soul provider status surface ──────────────
function SoulCard({
  soul: s, providers, providersPending, providersError,
}: {
  soul: AgentRuntimeSoulView;
  providers: SoulProviderStatusRow[] | null;
  providersPending: boolean;
  providersError: boolean;
}) {
  // per-soul provider status — resolved from the C5 registry health rows
  // (env-config + chat-adapter + breaker). Honest unknown while loading/error.
  let providerStatus: { ok: boolean; reason: string } | null = null;
  if (providers) {
    const resolved = resolveSoulProviderBinding(s.provider, providers);
    providerStatus = { ok: resolved.available, reason: resolved.reason };
  }
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{s.name}</span>
            <span className="you-num font-mono text-[10px] text-muted-foreground">v{s.version}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <Badge variant="outline" className="gap-1 text-[10px] text-emerald-700 dark:text-emerald-400">
              <Lock className="size-2.5" aria-hidden /> twin: {s.twinDisplayName}
            </Badge>
            <Badge variant="outline" className="font-mono text-[10px]">{s.provider} · {s.model}</Badge>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <StatusBadge status={s.status} />
          <LifecycleButtons kind="soul" id={s.id} status={s.status} />
        </div>
      </div>
      {/* P6.B7 — provider status surface (registry health, fail-closed) */}
      <div className="mt-1.5" aria-label={`Provider status for soul ${s.name}`}>
        {providersPending ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
            <Loader2 className="size-2.5 animate-spin" aria-hidden /> resolving provider status…
          </span>
        ) : providersError ? (
          <span className="text-[10px] text-muted-foreground">
            provider status unknown — the registry list failed; retry from the New Soul dialog
          </span>
        ) : providerStatus ? (
          <span
            className={cn(
              'inline-flex items-start gap-1 text-[10px] leading-snug',
              providerStatus.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400',
            )}
            title={providerStatus.reason}
          >
            <span
              className={cn('mt-1 inline-block size-1.5 shrink-0 rounded-full', providerStatus.ok ? 'bg-emerald-500' : 'bg-amber-500')}
              aria-hidden
            />
            provider {s.provider}: {providerStatus.ok ? 'available' : 'unavailable'} — {providerStatus.reason}
          </span>
        ) : null}
      </div>
      {s.persona.tagline ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">“{s.persona.tagline}”</p>
      ) : null}
      {s.persona.traits.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {s.persona.traits.slice(0, 5).map((t) => (
            <Badge key={t} variant="outline" className="text-[9px]">{t}</Badge>
          ))}
        </div>
      ) : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className="text-[9px] text-muted-foreground">can:</span>
        {s.manifest.can.length ? s.manifest.can.map((c) => (
          <Badge key={c} variant="outline" className="border-emerald-500/30 font-mono text-[9px] text-emerald-700 dark:text-emerald-400">{c}</Badge>
        )) : <span className="font-mono text-[9px] text-muted-foreground">nothing</span>}
        {s.manifest.cannot.length ? (
          <span className="text-[9px] text-muted-foreground">· cannot: {s.manifest.cannot.join(', ')}</span>
        ) : null}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-0.5"><Dices className="size-2.5" aria-hidden /> seed {s.seed}</span>
        {typeof s.params.thinking === 'boolean' ? <span>thinking {s.params.thinking ? 'on' : 'off'}</span> : null}
        {typeof s.params.temperature === 'number' ? <span>temp {s.params.temperature}</span> : <span>temp seeded/turn</span>}
      </div>
      <div className="mt-2 border-t pt-2"><IdChip id={s.id} label="soul" /></div>
    </div>
  );
}

// ─── View ────────────────────────────────────────────────────────────────────
export function AgentAvatarsView() {
  const [activeId, setActiveId] = useState<string | null>(null);

  const bodies = useQuery({ queryKey: ['agent-runtime-bodies'], queryFn: () => api.agentRuntime.bodies() });
  const souls = useQuery({ queryKey: ['agent-runtime-souls'], queryFn: () => api.agentRuntime.souls() });
  const sessions = useQuery({ queryKey: ['agent-runtime-sessions'], queryFn: () => api.agentRuntime.sessions() });
  // P6.B7 — the C5 registry provider health (Soul wiring + per-soul status)
  const providers = useQuery({ queryKey: ['agent-providers'], queryFn: () => api.agentRuntime.providers() });

  // keep the session list fresh when a session view exists (turn counts)
  const sessionList = useMemo<AgentRuntimeSessionSummaryView[]>(
    () => sessions.data ?? [],
    [sessions.data],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Embodiment"
        title="Agent Avatars"
        description="The production Body/Soul runtime: a Body binds visual avatar assets to a TwinVersion and declares what it CAN and CANNOT do; a Soul is twin-bound personality with versioned, seed-recorded behavior; sessions bind (Twin, Body, Soul) under consent and run turns through the resilience stack."
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)]">
        {/* ── Bodies ── */}
        <SectionCard
          title="Agent Bodies"
          description={`${bodies.data?.length ?? 0} contracts`}
          icon={Bot}
          actions={<BodyCreateDialog />}
        >
          {bodies.isPending ? (
            <div className="space-y-2.5">{[0, 1].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
          ) : bodies.isError ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-xs text-red-700 dark:text-red-400">
              <span>Couldn’t load bodies — {bodies.error instanceof YouApiError ? bodies.error.message : 'request failed'}</span>
              <Button size="sm" variant="outline" className="h-7" onClick={() => bodies.refetch()}>Retry</Button>
            </div>
          ) : !bodies.data?.length ? (
            <EmptyState
              icon={Bot}
              title="No Bodies yet"
              hint="A Body binds a twin’s visual assets (TwinVersion) and declares an honest capability manifest. Create one, activate it, then bind any Soul."
            />
          ) : (
            <div className="you-scroll max-h-[560px] space-y-2.5 overflow-y-auto">
              {bodies.data.map((b) => (
                <div key={b.id} className="rounded-lg border bg-card p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{b.name}</span>
                        <span className="you-num font-mono text-[10px] text-muted-foreground">v{b.version}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        <Badge variant="outline" className="text-[10px]">{b.role}</Badge>
                        {b.twinDisplayName ? (
                          <Badge variant="outline" className="gap-1 text-[10px] text-emerald-700 dark:text-emerald-400">
                            <Lock className="size-2.5" aria-hidden /> twin: {b.twinDisplayName}
                            {b.twinVersionNumber != null ? ` v${b.twinVersionNumber}` : ''}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] text-muted-foreground">abstract</Badge>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1.5">
                      <StatusBadge status={b.status} />
                      <LifecycleButtons kind="body" id={b.id} status={b.status} />
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <span className="text-[9px] text-muted-foreground">can:</span>
                    {b.manifest.can.length ? b.manifest.can.map((c) => (
                      <Badge key={c} variant="outline" className="border-emerald-500/30 font-mono text-[9px] text-emerald-700 dark:text-emerald-400">{c}</Badge>
                    )) : (
                      <span className="font-mono text-[9px] text-muted-foreground">nothing</span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <span className="text-[9px] text-muted-foreground">cannot:</span>
                    {b.manifest.cannot.length ? b.manifest.cannot.map((c) => (
                      <Badge key={c} variant="outline" className="border-dashed font-mono text-[9px] text-muted-foreground line-through opacity-70">{c}</Badge>
                    )) : (
                      <span className="font-mono text-[9px] text-muted-foreground">nothing</span>
                    )}
                  </div>
                  {b.tools.length ? (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {b.tools.map((t) => (
                        <span key={t} className="inline-flex items-center gap-1 rounded border border-dashed px-1.5 font-mono text-[9px] text-muted-foreground">
                          <Wrench className="size-2.5" aria-hidden />{t}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className="mt-2 border-t pt-2"><IdChip id={b.id} label="body" /></div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        {/* ── Souls ── */}
        <SectionCard
          title="Agent Souls"
          description={`${souls.data?.length ?? 0} twin-bound personalities`}
          icon={Ghost}
          actions={(
            <SoulCreateDialog
              providers={providers.data ?? []}
              providersPending={providers.isPending}
              providersError={providers.isError}
              onRetryProviders={() => void providers.refetch()}
            />
          )}
        >
          {souls.isPending ? (
            <div className="space-y-2.5">{[0, 1].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
          ) : souls.isError ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-xs text-red-700 dark:text-red-400">
              <span>Couldn’t load souls — {souls.error instanceof YouApiError ? souls.error.message : 'request failed'}</span>
              <Button size="sm" variant="outline" className="h-7" onClick={() => souls.refetch()}>Retry</Button>
            </div>
          ) : !souls.data?.length ? (
            <EmptyState
              icon={Ghost}
              title="No Souls yet"
              hint="A Soul is personality/behavior configuration bound to a Twin — versioned, seed-recorded, reproducible. Create one and activate it."
            />
          ) : (
            <div className="you-scroll max-h-[560px] space-y-2.5 overflow-y-auto">
              {souls.data.map((s) => (
                <SoulCard key={s.id} soul={s} providers={providers.data ?? null} providersPending={providers.isPending} providersError={providers.isError} />
              ))}
            </div>
          )}
        </SectionCard>

        {/* ── Session ── */}
        {activeId ? (
          <SessionPanel sessionId={activeId} onEnded={() => { /* session refetch shows ended state */ }} />
        ) : (
          <StartSessionCard
            bodies={bodies.data ?? []}
            souls={souls.data ?? []}
            onStarted={setActiveId}
          />
        )}
      </div>

      {/* ── Session history (real list endpoint) ── */}
      <SectionCard
        title="Session history"
        description="Sessions bound in this tenant (newest first) — from the runtime’s list endpoint, nothing reconstructed."
        icon={History}
      >
        {sessions.isPending ? (
          <div className="space-y-2.5">{[0, 1].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        ) : sessions.isError ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-xs text-red-700 dark:text-red-400">
            <span>Couldn’t load sessions — {sessions.error instanceof YouApiError ? sessions.error.message : 'request failed'}</span>
            <Button size="sm" variant="outline" className="h-7" onClick={() => sessions.refetch()}>Retry</Button>
          </div>
        ) : !sessionList.length ? (
          <EmptyState
            icon={History}
            title="No agent sessions yet"
            hint="Start a session above — every session binds (Twin, Body, Soul) with consent provenance and records real turn history."
          />
        ) : (
          <div className="max-h-72 you-scroll overflow-y-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Twin</th>
                  <th className="px-3 py-2 font-medium">Body</th>
                  <th className="px-3 py-2 font-medium">Soul</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Turns</th>
                  <th className="px-3 py-2 text-right font-medium">Started</th>
                  <th className="px-3 py-2" aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {sessionList.map((s) => (
                  <tr key={s.id} className="border-b last:border-0">
                    <td className="max-w-28 truncate px-3 py-2 font-medium">{s.twinDisplayName}</td>
                    <td className="max-w-28 truncate px-3 py-2 text-xs">
                      {s.bodyName} <span className="font-mono text-[10px] text-muted-foreground">v{s.bodyVersion}</span>
                    </td>
                    <td className="max-w-28 truncate px-3 py-2 text-xs">
                      {s.soulName} <span className="font-mono text-[10px] text-muted-foreground">v{s.soulVersion}</span>
                    </td>
                    <td className="px-3 py-2"><StatusBadge status={s.status} /></td>
                    <td className="you-num px-3 py-2 text-right font-mono text-xs">{s.turnCount}</td>
                    <td className="px-3 py-2 text-right text-xs text-muted-foreground">{rel(s.createdAt)}</td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        size="sm" variant="ghost" className="h-7 gap-1 text-xs"
                        onClick={() => setActiveId(s.id)}
                      >
                        Open<ChevronRight className="size-3" aria-hidden />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
export default AgentAvatarsView;
