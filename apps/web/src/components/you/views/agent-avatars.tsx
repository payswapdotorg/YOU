'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Agent Avatar Studio — AI-provider embodiment as a first-class surface.
// Bodies (capability contracts) × Souls (runtime bindings) × Sessions.
// A Body may be possessed by different Souls without changing its contract
// (ARCHITECTURE §8). Avatar states render ONLY real emitted events.
// ═══════════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import {
  ArrowRight, Bot, Brain, ChevronRight, Ghost, History, Loader2, Lock, MessageSquare,
  Play, RefreshCcw, Send, ShieldAlert, Sparkles, StopCircle, Wrench,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, uid, YouApiError } from '@/lib/you/client/api';
import type {
  AgentAvatarSessionView, AgentBodyView, AgentPerformanceEvent, AgentSoulView, RoutingClass,
} from '@/lib/you/contracts';
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
import { cn } from '@/lib/utils';

const ROUTING_LABEL: Record<RoutingClass, string> = {
  system_one: 'fast routing',
  system_two: 'deliberative routing',
};

function rel(iso?: string | null): string {
  if (!iso) return '—';
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }); } catch { return iso; }
}

function isConsentError(err: unknown): boolean {
  return err instanceof YouApiError && (err.code === 'consent_required' || err.status === 403 || err.status === 409);
}

function isNotImplemented(err: unknown): boolean {
  return err instanceof YouApiError && (err.status === 501 || /not.?implemented/i.test(err.code));
}

// ─── Current avatar state (real events only) ─────────────────────────────────
function currentAvatarState(session: AgentAvatarSessionView | null | undefined) {
  if (!session) return { state: null as AgentPerformanceEvent['type'] | null, at: null as string | null };
  const turnsWithStates = [...(session.turns ?? [])].reverse().filter((t) => t.states?.length);
  const last = turnsWithStates[0];
  const ev = last?.states?.[last.states.length - 1];
  return { state: ev?.type ?? null, at: ev?.timestamp ?? null };
}

function allEvents(session: AgentAvatarSessionView | null | undefined): AgentPerformanceEvent[] {
  if (!session) return [];
  return (session.turns ?? []).flatMap((t) => t.states ?? []);
}

// ─── Session history (real APIs only) ────────────────────────────────────────
function useSessionHistory(known: AgentAvatarSessionView[]) {
  const events = useQuery({
    queryKey: ['develop-events', 'avatar-history'],
    queryFn: () => api.develop.events({ limit: 100 }),
    staleTime: 15_000,
  });

  const candidateIds = useMemo(() => {
    const ids: string[] = [];
    for (const e of events.data ?? []) {
      if (e.entityId && /avatar/i.test(e.entityType ?? '')) ids.push(e.entityId);
    }
    return [...new Set(ids)].slice(0, 6);
  }, [events.data]);

  const recovered = useQuery({
    queryKey: ['agent-session-history', candidateIds],
    queryFn: async () => {
      const results = await Promise.allSettled(candidateIds.map((id) => api.agents.getSession(id)));
      return results
        .filter((r): r is PromiseFulfilledResult<AgentAvatarSessionView> => r.status === 'fulfilled')
        .map((r) => r.value);
    },
    enabled: candidateIds.length > 0,
  });

  const merged = useMemo(() => {
    const map = new Map<string, AgentAvatarSessionView>();
    for (const s of [...(recovered.data ?? []), ...known]) {
      const prev = map.get(s.id);
      if (!prev || new Date(s.createdAt) >= new Date(prev.createdAt)) map.set(s.id, s);
    }
    return [...map.values()].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [recovered.data, known]);

  return { sessions: merged.slice(0, 8), isRecovering: events.isPending || recovered.isPending };
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
  const [runtimeUnavailable, setRuntimeUnavailable] = useState(false);
  const [swap, setSwap] = useState<{ fromKey: string; fromLabel: string; toKey: string; toLabel: string } | null>(null);
  const [soulPicker, setSoulPicker] = useState('');
  const [endOpen, setEndOpen] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const session = useQuery({
    queryKey: ['agent-session', sessionId],
    queryFn: () => api.agents.getSession(sessionId),
  });
  const souls = useQuery({ queryKey: ['agent-souls'], queryFn: () => api.agents.souls() });

  const data = session.data ?? null;
  const live = data?.status === 'live';
  const { state, at } = currentAvatarState(data);
  const events = allEvents(data);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ block: 'nearest' }); }, [data?.turns.length, session.isFetching]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['agent-session', sessionId] });
    qc.invalidateQueries({ queryKey: ['agent-bodies'] });
  };

  const sendTurn = useMutation({
    mutationFn: () => api.agents.sendTurn(sessionId, message),
    onSuccess: () => {
      setMessage('');
      setRuntimeUnavailable(false);
      qc.invalidateQueries({ queryKey: ['agent-session', sessionId] });
    },
    onError: (err) => {
      if (isNotImplemented(err)) {
        setRuntimeUnavailable(true);
        toast.error('Soul runtime not yet available');
      } else {
        const msg = err instanceof YouApiError ? err.message : 'request failed';
        toast.error(`Turn failed — ${msg}`);
      }
    },
  });

  const possess = useMutation({
    mutationFn: (soulKey: string) => api.agents.possess(data?.bodyId ?? '', soulKey, uid()),
    onSuccess: (_body, soulKey) => {
      const soul = souls.data?.find((s: AgentSoulView) => s.soulKey === soulKey);
      if (data) {
        setSwap({
          fromKey: data.soulKey,
          fromLabel: data.soulLabel,
          toKey: soulKey,
          toLabel: soul?.label ?? soulKey,
        });
      }
      toast.success(`Body possessed by “${soul?.label ?? soulKey}” — same Body contract`);
      setSoulPicker('');
      refresh();
    },
    onError: (err) => {
      const msg = err instanceof YouApiError ? err.message : 'request failed';
      toast.error(`Soul swap failed — ${msg}`);
    },
  });

  const endSession = useMutation({
    mutationFn: () => api.agents.endSession(sessionId),
    onSuccess: () => {
      toast.success('Session ended');
      qc.invalidateQueries({ queryKey: ['agent-session', sessionId] });
      onEnded();
    },
    onError: (err) => {
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
          <span>Couldn’t load session — {session.error instanceof YouApiError ? session.error.message : 'request failed'}</span>
          <Button size="sm" variant="outline" className="h-7" onClick={() => session.refetch()}>Retry</Button>
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Session"
      description={data ? `${data.bodyName} · possessed by ${data.soulLabel}` : undefined}
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
                  <AlertDialogTitle>End this avatar session?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Turns and performance events recorded so far are kept; the avatar becomes unavailable.
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
      {data ? (
        <div className="space-y-4">
          {/* session header */}
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge status={data.status} />
            <Badge variant="outline" className="gap-1 font-mono text-[10px]">
              <Lock className="size-2.5" aria-hidden /> body: {data.bodyName}
            </Badge>
            <Badge variant="outline" className="font-mono text-[10px]">soul: {data.soulKey}</Badge>
            <Badge variant="outline" className="text-[10px]">{ROUTING_LABEL[data.routingClass]}</Badge>
            {data.twinId ? (
              data.twinDisplayName
                ? <Badge variant="outline" className="text-[10px]">twin: {data.twinDisplayName}</Badge>
                : <IdChip id={data.twinId} label="twin" />
            ) : null}
            <IdChip id={data.id} label="session" />
          </div>

          <AvatarStage state={state} stateAt={at} recentEvents={events} ended={!live} />

          {/* soul swap */}
          {live ? (
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Ghost className="size-3.5 text-muted-foreground" aria-hidden />
                <span className="text-xs font-medium">Soul swap</span>
                <span className="text-[11px] text-muted-foreground">mid-session — the Body contract never changes</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Select value={soulPicker || undefined} onValueChange={(v) => setSoulPicker(v)}>
                  <SelectTrigger className="h-8 w-full min-w-44 flex-1 sm:w-56">
                    <SelectValue placeholder={possess.isPending ? 'Possessing…' : 'Possess with another Soul'} />
                  </SelectTrigger>
                  <SelectContent>
                    {souls.data?.filter((s: AgentSoulView) => s.soulKey !== data.soulKey).map((s: AgentSoulView) => (
                      <SelectItem key={s.soulKey} value={s.soulKey}>
                        {s.label} · {ROUTING_LABEL[s.routingClass]}
                      </SelectItem>
                    )) ?? null}
                  </SelectContent>
                </Select>
                <Button
                  size="sm" className="gap-1.5" disabled={!soulPicker || possess.isPending}
                  onClick={() => soulPicker && possess.mutate(soulPicker)}
                >
                  {possess.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Ghost className="size-3.5" aria-hidden />}
                  Swap
                </Button>
              </div>
              {swap ? (
                <div className="mt-3 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <Badge variant="outline" className="gap-1 font-mono text-[10px]">
                      <Lock className="size-2.5" aria-hidden /> {data.bodyName} — unchanged
                    </Badge>
                    <Badge variant="outline" className="font-mono text-[10px] line-through opacity-60">{swap.fromKey}</Badge>
                    <ArrowRight className="size-3 text-muted-foreground" aria-hidden />
                    <Badge variant="outline" className="border-emerald-500/40 font-mono text-[10px] text-emerald-700 dark:text-emerald-400">{swap.toKey}</Badge>
                  </div>
                  <p className="mt-1.5 text-[11px] text-emerald-800 dark:text-emerald-300">
                    Same Body contract — Soul swapped. New turns are recorded under “{swap.toLabel}”.
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* chat */}
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <MessageSquare className="size-3.5" aria-hidden /> Turns
            </div>
            <div className="you-scroll max-h-80 space-y-2.5 overflow-y-auto rounded-lg border bg-muted/20 p-3">
              {data.turns.length ? (
                data.turns.map((turn) => (
                  <div key={turn.id} className={cn('flex flex-col', turn.role === 'user' ? 'items-end' : 'items-start')}>
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
                    <div className="mt-0.5 flex items-center gap-2 px-1 font-mono text-[10px] text-muted-foreground">
                      <span>{new Date(turn.createdAt).toLocaleTimeString()}</span>
                      {turn.role === 'agent' && turn.latencyMs != null ? (
                        <span className="you-num">{Math.round(turn.latencyMs)} ms</span>
                      ) : null}
                      {turn.role === 'agent' && turn.states?.length ? (
                        <span>{turn.states.length} state events</span>
                      ) : null}
                    </div>
                  </div>
                ))
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

            {runtimeUnavailable ? (
              <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-300">
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  Soul runtime not yet available — the backend returned not-implemented for this session. Turns are
                  recorded once the runtime lands; nothing is simulated here.
                </span>
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
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={live ? 'Message the avatar…' : 'Session ended'}
                disabled={!live || sendTurn.isPending}
                className="h-9"
                aria-label="Message"
              />
              <Button type="submit" size="sm" className="gap-1.5" disabled={!live || !message.trim() || sendTurn.isPending}>
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

// ─── Start-session column state ──────────────────────────────────────────────
function StartSessionCard({
  bodies, souls, twins, onStarted,
}: {
  bodies: AgentBodyView[];
  souls: AgentSoulView[];
  twins: { id: string; displayName: string }[];
  onStarted: (sessionId: string) => void;
}) {
  const qc = useQueryClient();
  const navigate = useYouStore((s) => s.navigate);
  const [bodyId, setBodyId] = useState('');
  const [soulKey, setSoulKey] = useState('');
  const [twinId, setTwinId] = useState('none');
  const [consentError, setConsentError] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () =>
      api.agents.startSession(
        { bodyId, soulKey, ...(twinId !== 'none' ? { twinId } : {}) },
        uid(),
      ),
    onSuccess: (session) => {
      setConsentError(null);
      toast.success(`Session started — ${session.bodyName} possessed by ${session.soulLabel}`);
      qc.invalidateQueries({ queryKey: ['agent-bodies'] });
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

  // derive effective selections from loaded catalogs (no effects needed)
  const effectiveBodyId = bodies.some((b) => b.id === bodyId) ? bodyId : '';
  const effectiveSoulKey = souls.some((s) => s.soulKey === soulKey) ? soulKey : '';

  const canStart = !!effectiveBodyId && !!effectiveSoulKey && !start.isPending;

  return (
    <>
      <SectionCard title="Start session" description="Pick a Body, bind a Soul, optionally embody a twin." icon={Play}>
        <div className="space-y-3.5">
          <div className="space-y-1.5">
            <Label className="text-xs">Body <span className="text-muted-foreground">(capability contract)</span></Label>
            <Select value={effectiveBodyId || undefined} onValueChange={setBodyId}>
              <SelectTrigger className="h-9"><SelectValue placeholder={bodies.length ? 'Select body' : 'No bodies yet'} /></SelectTrigger>
              <SelectContent>
                {bodies.map((b) => (
                  <SelectItem key={b.id} value={b.id}>{b.name} · {b.role}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Soul <span className="text-muted-foreground">(runtime binding)</span></Label>
            <Select value={effectiveSoulKey || undefined} onValueChange={setSoulKey}>
              <SelectTrigger className="h-9"><SelectValue placeholder={souls.length ? 'Select soul' : 'No souls in catalog'} /></SelectTrigger>
              <SelectContent>
                {souls.map((s) => (
                  <SelectItem key={s.soulKey} value={s.soulKey}>
                    {s.label} · {ROUTING_LABEL[s.routingClass]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Twin (optional)</Label>
            <Select value={twinId} onValueChange={setTwinId}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None — abstract avatar</SelectItem>
                {twins.map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.displayName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {twinId !== 'none' ? (
              <p className="flex items-start gap-1.5 rounded-md border border-amber-500/25 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-800 dark:text-amber-300">
                <ShieldAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
                Embodiment scope required — attaching a twin means the avatar drives that twin’s representation. The
                subject’s consent grant must include the <span className="font-mono">embodiment</span> scope.
              </p>
            ) : null}
          </div>
          <Button className="w-full gap-1.5" disabled={!canStart} onClick={() => start.mutate()}>
            {start.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
            Start session
          </Button>
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

// ─── View ────────────────────────────────────────────────────────────────────
export function AgentAvatarsView() {
  const [activeId, setActiveId] = useState<string | null>(null);
  // knownSessions accumulated via ref below

  const bodies = useQuery({ queryKey: ['agent-bodies'], queryFn: () => api.agents.bodies() });
  const souls = useQuery({ queryKey: ['agent-souls'], queryFn: () => api.agents.souls() });
  const twins = useQuery({ queryKey: ['twins'], queryFn: () => api.twins.list() });
  const session = useQuery({
    queryKey: ['agent-session', activeId],
    queryFn: () => api.agents.getSession(activeId as string),
    enabled: !!activeId,
  });

  // track every session we have real data for (for the history list) by
  // reading the query cache — every fetched session lives under
  // ['agent-session', id]. Read-only cache access keeps this compiler-safe.
  const qc = useQueryClient();
  const knownSessions = useMemo(
    () => qc
      .getQueriesData<AgentAvatarSessionView>({ queryKey: ['agent-session'] })
      .map(([, d]) => d)
      .filter((d): d is AgentAvatarSessionView => !!d),
    [qc, session.data],
  );

  const history = useSessionHistory(knownSessions);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Embodiment"
        title="Agent Avatars"
        description="AI-provider embodiment: a Body is reusable capability/role/tool infrastructure; a Soul is an LLM/VLM/runtime binding. Bodies stay identical while Souls swap — the LLM is never the renderer (ARCHITECTURE §8)."
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
              hint="A Body is a reusable role/capability/tool contract — create one with “New Body”, then bind any Soul to it."
            />
          ) : (
            <div className="you-scroll max-h-[560px] space-y-2.5 overflow-y-auto">
              {bodies.data.map((b) => {
                const inSession = !!activeId && session.data?.bodyId === b.id && session.data?.status === 'live';
                return (
                  <div
                    key={b.id}
                    className={cn(
                      'rounded-lg border bg-card p-3 transition-colors',
                      inSession && 'border-emerald-500/40 ring-1 ring-emerald-500/20',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium">{b.name}</span>
                          <span className="you-num font-mono text-[10px] text-muted-foreground">v{b.version}</span>
                        </div>
                        <Badge variant="outline" className="mt-1 text-[10px]">{b.role}</Badge>
                      </div>
                      {inSession ? <StatusBadge status="live" /> : null}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {b.capabilities.slice(0, 4).map((c) => (
                        <Badge key={c} variant="outline" className="font-mono text-[9px] text-muted-foreground">{c}</Badge>
                      ))}
                      {b.capabilities.length > 4 ? (
                        <Badge variant="outline" className="font-mono text-[9px] text-muted-foreground">+{b.capabilities.length - 4}</Badge>
                      ) : null}
                    </div>
                    {b.tools.length ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {b.tools.slice(0, 3).map((t) => (
                          <span key={t} className="inline-flex items-center gap-1 rounded border border-dashed px-1.5 font-mono text-[9px] text-muted-foreground">
                            <Wrench className="size-2.5" aria-hidden />{t}
                          </span>
                        ))}
                        {b.tools.length > 3 ? (
                          <span className="font-mono text-[9px] text-muted-foreground">+{b.tools.length - 3} tools</span>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t pt-2">
                      <span className="text-[10px] text-muted-foreground">possessed by:</span>
                      {b.possessions?.length ? (
                        b.possessions.slice(-3).map((s) => (
                          <Badge key={s.id} variant="outline" className="max-w-32 truncate font-mono text-[9px]">{s.soulKey}</Badge>
                        ))
                      ) : (
                        <span className="text-[10px] text-muted-foreground/70">never</span>
                      )}
                    </div>
                    <div className="mt-1.5"><IdChip id={b.id} label="body" /></div>
                  </div>
                );
              })}
            </div>
          )}
        </SectionCard>

        {/* ── Souls ── */}
        <SectionCard
          title="Soul Catalog"
          description={`${souls.data?.length ?? 0} runtime bindings`}
          icon={Ghost}
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
              title="No Souls in the catalog"
              hint="Souls are LLM/VLM/runtime bindings registered by the soul catalog on the backend. None are registered yet."
            />
          ) : (
            <>
              <div className="you-scroll max-h-[560px] space-y-2.5 overflow-y-auto">
                {souls.data.map((s) => (
                  <div key={s.id} className="rounded-lg border bg-card p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{s.label}</div>
                        <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={`${s.provider} · ${s.model}`}>
                          {s.provider} · {s.model}
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-[9px]',
                          s.routingClass === 'system_one'
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                            : 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400',
                        )}
                      >
                        {ROUTING_LABEL[s.routingClass]}
                      </Badge>
                      {typeof s.params.thinking === 'boolean' ? (
                        <Badge variant="outline" className="gap-1 text-[9px]">
                          <Brain className="size-2.5" aria-hidden /> thinking {s.params.thinking ? 'on' : 'off'}
                        </Badge>
                      ) : null}
                      {typeof s.params.temperature === 'number' ? (
                        <span className="you-num font-mono text-[10px] text-muted-foreground">temp {s.params.temperature}</span>
                      ) : null}
                    </div>
                    <div className="mt-1.5 font-mono text-[10px] text-muted-foreground">{s.soulKey}</div>
                  </div>
                ))}
              </div>
              <p className="mt-3 border-t pt-3 text-[11px] leading-relaxed text-muted-foreground">
                <span className="font-mono">system_one</span> / <span className="font-mono">system_two</span> are
                routing classes — fast vs deliberative profiles — not provider identities. Any Soul can possess any
                Body without changing the Body’s contract.
              </p>
            </>
          )}
        </SectionCard>

        {/* ── Session ── */}
        {activeId ? (
          <SessionPanel sessionId={activeId} onEnded={() => { /* session refetch shows ended state */ }} />
        ) : (
          <StartSessionCard
            bodies={bodies.data ?? []}
            souls={souls.data ?? []}
            twins={twins.data?.map((t) => ({ id: t.id, displayName: t.displayName })) ?? []}
            onStarted={setActiveId}
          />
        )}
      </div>

      {/* ── Session history ── */}
      <SectionCard
        title="Session history"
        description="Sessions started in this window, plus sessions discovered from the tenant event log."
        icon={History}
      >
        {history.isRecovering && !history.sessions.length ? (
          <div className="space-y-2.5">{[0, 1].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        ) : !history.sessions.length ? (
          <EmptyState
            icon={History}
            title="No avatar sessions yet"
            hint="Start a session above — the history list is assembled from real sessions only (API v1 has no list-sessions endpoint; history is recovered from events)."
          />
        ) : (
          <div className="max-h-72 you-scroll overflow-y-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Body</th>
                  <th className="px-3 py-2 font-medium">Soul</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Turns</th>
                  <th className="px-3 py-2 text-right font-medium">Started</th>
                  <th className="px-3 py-2" aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {history.sessions.map((s) => (
                  <tr key={s.id} className="border-b last:border-0">
                    <td className="max-w-32 truncate px-3 py-2 font-medium">{s.bodyName}</td>
                    <td className="max-w-32 truncate px-3 py-2 font-mono text-xs text-muted-foreground">{s.soulKey}</td>
                    <td className="px-3 py-2"><StatusBadge status={s.status} /></td>
                    <td className="you-num px-3 py-2 text-right font-mono text-xs">{s.turns.length}</td>
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
