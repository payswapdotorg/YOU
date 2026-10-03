'use client';
// Trust — Consent & Provenance. Consent grants are explicit, purpose-bound,
// revocable and server-enforced; the provenance tab is the event ledger; the
// policies tab is clearly-labeled policy documentation (not live config).
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { EmptyState, IdChip, PageHeader, StatusBadge } from '@/components/you/shared/primitives';
import { useYouStore } from '@/hooks/you/use-you-store';
import { api } from '@/lib/you/client/api';
import type { ConsentGrantView } from '@/lib/you/contracts';
import {
  Activity, BookOpen, Box, FileClock, Fingerprint, Gauge, HeartPulse, History, KeyRound,
  Loader2, Lock, MessageSquareOff, Plus, Scale, ScanFace, Search, ShieldCheck, Unplug,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { QueryError, RowSkeletons } from '../build/confidence';
import { payloadSummary, timeAbs, timeAgo } from '../build/format';

const TRUST_TABS = ['consent', 'provenance', 'policies'] as const;
type TrustTab = (typeof TRUST_TABS)[number];

function grantState(g: ConsentGrantView): { state: 'active' | 'revoked' | 'expired'; label: string } {
  if (g.revokedAt) return { state: 'revoked', label: 'revoked' };
  if (new Date(g.expiresAt).getTime() <= Date.now()) return { state: 'expired', label: 'expired' };
  return { state: 'active', label: 'active' };
}

function ScopeBadges({ scopes }: { scopes: ConsentGrantView['scopes'] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {(scopes ?? []).map((s) => (
        <Badge key={s} variant="outline" className="px-1.5 font-mono text-[10.5px] text-muted-foreground">{s}</Badge>
      ))}
    </span>
  );
}

function ConsentTab() {
  const qc = useQueryClient();
  const navigate = useYouStore((s) => s.navigate);
  const grantsQ = useQuery({ queryKey: ['consent'], queryFn: api.consent.list });
  const [revokeId, setRevokeId] = useState<string | null>(null);

  const revoke = useMutation({
    mutationFn: (id: string) => api.consent.revoke(id),
    onSuccess: () => {
      toast.success('Consent revoked', { description: 'Future capture, reconstruction and render operations for this subject are now blocked.' });
      void qc.invalidateQueries({ queryKey: ['consent'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
      setRevokeId(null);
    },
    onError: (err) => {
      toast.error('Could not revoke consent', { description: err instanceof Error ? err.message : 'Unexpected error' });
    },
  });

  const grants = useMemo(
    () => [...(grantsQ.data ?? [])].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [grantsQ.data],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-xl border bg-card px-5 py-4 text-[13px]">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
        <p className="leading-relaxed text-muted-foreground">
          Grants are <span className="font-medium text-foreground">explicit, purpose-bound, revocable and server-enforced</span>.
          Applications receive derived outputs only — raw biometric evidence is never included in grant outputs.
          Revocation blocks future operations immediately; historical TwinVersions remain immutable.
        </p>
      </div>

      {grantsQ.isPending ? (
        <RowSkeletons rows={4} />
      ) : grantsQ.isError ? (
        <QueryError error={grantsQ.error} title="Could not load consent grants" onRetry={() => void grantsQ.refetch()} />
      ) : grants.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No consent grants yet"
          hint="Grants are created when you create a twin (the consent gate) or unblock a consent-gated capture."
          action={(
            <Button size="sm" className="gap-1.5" onClick={() => navigate('twins', { action: 'create' })}>
              <Plus className="size-3.5" aria-hidden /> Create Twin
            </Button>
          )}
        />
      ) : (
        <div className="rounded-xl border bg-card shadow-sm">
          <div className="overflow-x-auto you-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Subject</TableHead>
                  <TableHead>Purpose</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead>Operations</TableHead>
                  <TableHead>Outputs</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-24"><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {grants.map((g) => {
                  const { state, label } = grantState(g);
                  const expiring = formatDistanceToNow(new Date(g.expiresAt), { addSuffix: true });
                  return (
                    <TableRow key={g.id}>
                      <TableCell><IdChip id={g.subjectId} label="" /></TableCell>
                      <TableCell className="max-w-52">
                        <span className="block truncate text-[13px]" title={g.purpose}>{g.purpose}</span>
                        <span className="you-num block text-[11px] text-muted-foreground" title={g.createdAt}>
                          granted {timeAgo(g.createdAt)}
                        </span>
                      </TableCell>
                      <TableCell><ScopeBadges scopes={g.scopes} /></TableCell>
                      <TableCell className="max-w-36">
                        {g.operations?.length ? (
                          <span className="block truncate font-mono text-[11px] text-muted-foreground" title={g.operations.join(', ')}>
                            {g.operations.join(', ')}
                          </span>
                        ) : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="max-w-36">
                        {g.outputs?.length ? (
                          <span className="block truncate font-mono text-[11px] text-muted-foreground" title={g.outputs.join(', ')}>
                            {g.outputs.join(', ')}
                          </span>
                        ) : <span className="text-muted-foreground">derived only</span>}
                      </TableCell>
                      <TableCell className={cn('you-num whitespace-nowrap text-[13px]', state !== 'active' ? 'text-muted-foreground line-through' : state === 'active' && g.expiresAt ? 'text-foreground' : '')}>
                        <span title={timeAbs(g.expiresAt)}>{expiring}</span>
                      </TableCell>
                      <TableCell>
                        {state === 'active'
                          ? <StatusBadge status="active" />
                          : <StatusBadge status={state === 'revoked' ? 'revoked' : 'expired'} />}
                        <span className="sr-only">{label}</span>
                      </TableCell>
                      <TableCell>
                        {state === 'active' ? (
                          <AlertDialog open={revokeId === g.id} onOpenChange={(o) => !o && setRevokeId(null)}>
                            <AlertDialogTrigger asChild>
                              <Button variant="outline" size="sm" className="h-7 text-[11.5px] text-red-600 hover:text-red-600 dark:text-red-400 dark:hover:text-red-400" onClick={() => setRevokeId(g.id)}>
                                Revoke
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Revoke this consent grant?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  Revocation is immediate and server-enforced: future capture, reconstruction,
                                  render and embodiment operations for this subject will be blocked. Historical
                                  TwinVersions remain immutable. This cannot be undone — a new grant would be
                                  required to resume operations.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Keep grant</AlertDialogCancel>
                                <AlertDialogAction
                                  className="bg-red-600 text-white hover:bg-red-700"
                                  onClick={(e) => { e.preventDefault(); revoke.mutate(g.id); }}
                                  disabled={revoke.isPending}
                                >
                                  {revoke.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                                  Revoke consent
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}

function ProvenanceTab() {
  const eventsQ = useQuery({ queryKey: ['events'], queryFn: () => api.develop.events({ limit: 100 }) });
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');

  const events = useMemo(() => [...(eventsQ.data ?? [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  ), [eventsQ.data]);

  const types = useMemo(() => Array.from(new Set(events.map((e) => e.type))).sort(), [events]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return events.filter((e) => {
      if (typeFilter !== 'all' && e.type !== typeFilter) return false;
      if (!q) return true;
      return (
        e.type.toLowerCase().includes(q)
        || e.entityType.toLowerCase().includes(q)
        || (e.entityId ?? '').toLowerCase().includes(q)
        || payloadSummary(e.payload, 400).toLowerCase().includes(q)
      );
    });
  }, [events, search, typeFilter]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search type, entity or payload…"
            className="h-9 pl-8 text-[13px]"
            aria-label="Search events"
          />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger size="sm" className="w-48" aria-label="Filter by event type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types ({events.length})</SelectItem>
            {types.map((t) => (
              <SelectItem key={t} value={t}>{t}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {eventsQ.isPending ? (
        <RowSkeletons rows={6} />
      ) : eventsQ.isError ? (
        <QueryError error={eventsQ.error} title="Could not load the event ledger" onRetry={() => void eventsQ.refetch()} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={History}
          title={events.length === 0 ? 'No events recorded yet' : 'No events match this filter'}
          hint={events.length === 0 ? 'Every consent change, capture, compile, render and lab run lands in this ledger.' : 'Try clearing the search or picking another type.'}
        />
      ) : (
        <ul className="max-h-96 space-y-1.5 overflow-y-auto you-scroll pr-1" aria-label="Event ledger">
          {filtered.map((e) => (
            <li key={e.id} className="rounded-lg border bg-card px-3.5 py-2.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="shrink-0 rounded border bg-muted/60 px-1.5 py-0.5 font-mono text-[10.5px] font-medium">
                  {e.type}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs">
                  <span className="font-medium">{e.entityType}</span>
                  {e.entityId ? <IdChip id={e.entityId} label="" className="ml-1.5" /> : null}
                </span>
                <span className="you-num shrink-0 text-[11px] text-muted-foreground" title={timeAbs(e.createdAt)}>
                  {timeAgo(e.createdAt)}
                </span>
              </div>
              {payloadSummary(e.payload) ? (
                <p className="mt-1 truncate font-mono text-[10.5px] text-muted-foreground" title={payloadSummary(e.payload, 400)}>
                  {payloadSummary(e.payload)}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-muted-foreground">
        Showing {filtered.length} of {events.length} recent events — the full ledger is queryable via the Develop API.
      </p>
    </div>
  );
}

function PoliciesTab() {
  const policies: { icon: typeof ShieldCheck; title: string; body: string }[] = [
    { icon: Fingerprint, title: 'Derived-not-raw default', body: 'Applications receive derived outputs, not raw biometric evidence, by default. Large media stays in object storage; relational records hold metadata and hashes.' },
    { icon: Lock, title: 'Private storage, signed URLs', body: 'Object storage uses private buckets. Evidence and artifacts are only reachable through short-lived signed URLs.' },
    { icon: Box, title: 'Sandboxed processing', body: 'Media processing is sandboxed and resource bounded.' },
    { icon: ShieldCheck, title: 'Explicit scoped consent', body: 'Consent grants are explicit, purpose-bound, revocable and time-bound. Server-side enforcement, not UI promises.' },
    { icon: ScanFace, title: 'Liveness challenges', body: 'Capture sessions can require active liveness challenges. Identity/liveness evidence is distinct from visual similarity.' },
    { icon: Scale, title: 'Separated confidence', body: 'Ownership/verification confidence is tracked separately from reconstruction fidelity — neither implies the other.' },
    { icon: FileClock, title: 'Provenance on every render', body: 'Every render records twin/version/model/pipeline/provenance; C2PA-compatible provenance is attached where supported.' },
    { icon: HeartPulse, title: 'Clinical gating', body: 'Clinical representations require domain-specific permissions and evidence. No implied medical validity — ever.' },
    { icon: Unplug, title: 'Fail-closed adapters', body: 'Provider adapters are fail-closed when policy or terms are unresolved. Free tiers are accelerators, never hard dependencies.' },
    { icon: MessageSquareOff, title: 'Feedback isolation', body: 'User feedback cannot silently alter canonical data. Feedback creates review requests; evidence stays immutable.' },
    { icon: KeyRound, title: 'Secrets outside domain records', body: 'Secrets live outside domain records — no credentials inside twins, versions or artifacts.' },
    { icon: Gauge, title: 'Sensitive-operation gates', body: 'Identity export, realistic impersonation, voice cloning, medical generation and bulk generation are gated by tenant policy, audit and rate limits.' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-5 py-4 text-[13px]">
        <BookOpen className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
        <p className="leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">Policy documentation.</span> These cards summarize the
          platform controls defined in the YOU security &amp; privacy policy. They describe how the infrastructure
          behaves — they are not live, tenant-editable configuration.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {policies.map((p) => (
          <section key={p.title} className="rounded-xl border bg-card p-4">
            <h3 className="flex items-center gap-2 text-[13px] font-semibold">
              <p.icon className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden /> {p.title}
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{p.body}</p>
          </section>
        ))}
      </div>

      <section className="rounded-xl border bg-card p-5">
        <h3 className="text-sm font-semibold">Consent examples from the policy</h3>
        <ul className="mt-3 space-y-2 text-[13px] leading-relaxed text-muted-foreground">
          <li className="rounded-lg border bg-muted/30 px-3.5 py-2.5">
            A dating application may receive <span className="font-medium text-foreground">render permission</span> for social
            content — but not permission to export biometric captures or train models.
          </li>
          <li className="rounded-lg border bg-muted/30 px-3.5 py-2.5">
            An AI provider may drive an avatar session while the person retains ownership of the twin and can{' '}
            <span className="font-medium text-foreground">revoke the embodiment grant</span>.
          </li>
          <li className="rounded-lg border bg-muted/30 px-3.5 py-2.5">
            A feedback request may authorize <span className="font-medium text-foreground">one additional capture</span> for
            one stated reconstruction deficiency.
          </li>
        </ul>
      </section>
    </div>
  );
}

export function TrustView() {
  const params = useYouStore((s) => s.params);
  const [tab, setTab] = useState<TrustTab>('consent');

  // Render-phase param adjustment; consumed in the store after commit.
  const [prevParams, setPrevParams] = useState<unknown>(null);
  if (params !== prevParams) {
    setPrevParams(params);
    if (params && typeof params.tab === 'string' && (TRUST_TABS as readonly string[]).includes(params.tab)) {
      setTab(params.tab as TrustTab);
    }
  }
  useEffect(() => {
    if (params) useYouStore.setState({ params: null });
  }, [params]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Trust"
        title="Consent & Provenance"
        description="Who authorized what, for how long, and an append-only ledger of what happened."
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as TrustTab)}>
        <TabsList className="h-10 w-full justify-start overflow-x-auto you-scroll p-1 sm:w-auto">
          <TabsTrigger value="consent" className="gap-1.5 text-[13px]"><ShieldCheck className="size-3.5" aria-hidden /> Consent</TabsTrigger>
          <TabsTrigger value="provenance" className="gap-1.5 text-[13px]"><Activity className="size-3.5" aria-hidden /> Provenance</TabsTrigger>
          <TabsTrigger value="policies" className="gap-1.5 text-[13px]"><BookOpen className="size-3.5" aria-hidden /> Policies</TabsTrigger>
        </TabsList>
        <TabsContent value="consent" className="mt-4"><ConsentTab /></TabsContent>
        <TabsContent value="provenance" className="mt-4"><ProvenanceTab /></TabsContent>
        <TabsContent value="policies" className="mt-4"><PoliciesTab /></TabsContent>
      </Tabs>
    </div>
  );
}

export default TrustView;
