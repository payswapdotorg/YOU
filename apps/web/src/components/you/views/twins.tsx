'use client';
// Twins — list mode ↔ detail mode. The create flow chains straight into the
// consent gate (capture is consent-gated by design). `params` from the store:
//   { action: 'create' }              → open the create dialog
//   { twinId }                        → open detail for that twin
//   { tab: 'versions'|'capture'|... } → preselect the detail tab
//   { captureSessionId }              → focus that session in the Capture tab
//   { consentPending: true }          → consent-retry banner after a partial create
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, IdChip, PageHeader, StatusBadge } from '@/components/you/shared/primitives';
import { useYouStore } from '@/hooks/you/use-you-store';
import { api } from '@/lib/you/client/api';
import type { TwinView } from '@/lib/you/contracts';
import { Plus, RotateCw, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { ConsentGrantDialog } from '../build/consent-dialog';
import { TwinCreateDialog } from '../build/twin-create-dialog';
import { ConfidenceBar, QueryError } from '../build/confidence';
import { TwinDetail, TWIN_TABS, type TwinTab } from '../build/twin-detail';
import { timeAgo } from '../build/format';

function isTwinTab(v: unknown): v is TwinTab {
  return typeof v === 'string' && (TWIN_TABS as readonly string[]).includes(v);
}

function TwinCard({
  twin, detailPending, detailError, confidence, evidenceCount, onOpen,
}: {
  twin: TwinView;
  detailPending: boolean;
  detailError: boolean;
  confidence: number | null | undefined;
  evidenceCount: number | null;
  onOpen: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      aria-label={`Open twin ${twin.displayName}`}
      className="flex w-full cursor-pointer flex-col rounded-xl border bg-card p-5 text-left shadow-sm transition-all hover:border-foreground/20 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold">{twin.displayName}</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {twin.personName ?? 'person not named'}
          </div>
        </div>
        <StatusBadge status={twin.status} />
      </div>
      <div className="mt-4 space-y-2.5">
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span className="you-num">v{twin.currentVersion}</span>
          <span className="you-num" title={twin.createdAt}>created {timeAgo(twin.createdAt)}</span>
        </div>
        <div>
          <div className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground/70">confidence</div>
          {detailPending ? (
            <Skeleton className="h-4 w-full" />
          ) : detailError ? (
            <span className="text-[11px] text-muted-foreground/60">detail unavailable</span>
          ) : (
            <ConfidenceBar value={confidence} />
          )}
        </div>
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>evidence</span>
          {detailPending ? (
            <Skeleton className="h-4 w-8" />
          ) : detailError ? (
            <span className="text-muted-foreground/60">—</span>
          ) : (
            <span className="you-num font-medium text-foreground/80">{evidenceCount ?? 0} assets</span>
          )}
        </div>
      </div>
      <div className="mt-4 border-t pt-3">
        <IdChip id={twin.id} label="" />
      </div>
    </div>
  );
}

export function TwinsView() {
  const params = useYouStore((s) => s.params);

  // ── Local view state ───────────────────────────────────────────────────────
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedTwinId, setSelectedTwinId] = useState<string | null>(null);
  const [tab, setTab] = useState<TwinTab>('versions');
  const [focusSessionId, setFocusSessionId] = useState<string | null>(null);
  const [consentPending, setConsentPending] = useState(false);
  // Create-flow consent gate: the twin awaiting its consent grant.
  const [consentFor, setConsentFor] = useState<TwinView | null>(null);

  // ── Store params → view state ──────────────────────────────────────────────
  // Applied during render (React "adjust state when inputs change" pattern —
  // handles both mount-time and update-time params), then consumed below.
  const [prevParams, setPrevParams] = useState<unknown>(null);
  if (params !== prevParams) {
    setPrevParams(params);
    if (params) {
      if (params.action === 'create') setCreateOpen(true);
      if (typeof params.twinId === 'string') { setSelectedTwinId(params.twinId); setTab('versions'); }
      if (isTwinTab(params.tab)) setTab(params.tab);
      if (typeof params.captureSessionId === 'string') { setFocusSessionId(params.captureSessionId); setTab('capture'); }
      if (params.consentPending === true) setConsentPending(true);
    }
  }
  // Consume in the external store after commit — don't re-trigger on later visits.
  useEffect(() => {
    if (params) useYouStore.setState({ params: null });
  }, [params]);

  // ── List query + per-twin details (confidence/evidence on cards) ──────────
  const twinsQ = useQuery({ queryKey: ['twins'], queryFn: api.twins.list });
  const twins = useMemo(() => twinsQ.data ?? [], [twinsQ.data]);

  // Detail fetches power the card extras. NOTE: wave-1 list endpoint carries
  // neither confidence nor evidence counts — these come from twin detail.
  const detailQueries = useQueries({
    queries: twins.map((t) => ({
      queryKey: ['twin', t.id],
      queryFn: () => api.twins.get(t.id),
      staleTime: 10_000,
      retry: 1,
    })),
  });
  const detailById = useMemo(() => {
    const m = new Map<string, {
      pending: boolean; error: boolean;
      confidence: number | null | undefined; evidence: number | null;
    }>();
    detailQueries.forEach((q, i) => {
      const t = twins[i];
      if (!t) return;
      if (q.isPending) { m.set(t.id, { pending: true, error: false, confidence: null, evidence: null }); return; }
      if (q.isError) { m.set(t.id, { pending: false, error: true, confidence: null, evidence: null }); return; }
      const d = q.data;
      const latest = [...(d?.versions ?? [])].sort((a, b) => b.version - a.version)[0];
      m.set(t.id, {
        pending: false,
        error: false,
        confidence: latest?.confidenceSummary?.overall ?? null,
        evidence: (d?.captures ?? []).reduce((n, c) => n + (c.assets?.length ?? 0), 0),
      });
    });
    return m;
  }, [detailQueries, twins]);

  // ── Detail mode ────────────────────────────────────────────────────────────
  if (selectedTwinId) {
    return (
      <TwinDetail
        twinId={selectedTwinId}
        tab={tab}
        onTabChange={setTab}
        focusSessionId={focusSessionId}
        onFocusSession={(id) => setFocusSessionId(id)}
        onBack={() => { setSelectedTwinId(null); setFocusSessionId(null); setConsentPending(false); }}
        consentPending={consentPending}
      />
    );
  }

  // ── List mode ──────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Build"
        title="Twins"
        description="Persistent human objects — authorized captures compiled into immutable HTIR versions."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void twinsQ.refetch()} className="gap-1.5" disabled={twinsQ.isFetching}>
              <RotateCw className="size-3.5" aria-hidden /> Refresh
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
              <Plus className="size-3.5" aria-hidden /> Create Twin
            </Button>
          </>
        }
      />

      {twinsQ.isPending ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-xl border bg-card p-5">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="mt-2 h-3 w-20" />
              <Skeleton className="mt-6 h-4 w-full" />
              <Skeleton className="mt-3 h-4 w-2/3" />
            </div>
          ))}
        </div>
      ) : twinsQ.isError ? (
        <QueryError error={twinsQ.error} title="Could not load twins" onRetry={() => void twinsQ.refetch()} />
      ) : twins.length === 0 ? (
        <EmptyState
          icon={UserRound}
          title="No twins yet"
          hint="Create your first twin to start the canonical flow: consent-gated capture → reconstruction → performance → render."
          action={
            <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
              <Plus className="size-3.5" aria-hidden /> Create Twin
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {twins.map((twin) => {
            const d = detailById.get(twin.id);
            return (
              <TwinCard
                key={twin.id}
                twin={twin}
                detailPending={d?.pending ?? false}
                detailError={d?.error ?? false}
                confidence={d?.confidence}
                evidenceCount={d?.evidence ?? null}
                onOpen={() => { setSelectedTwinId(twin.id); setTab('versions'); setFocusSessionId(null); }}
              />
            );
          })}
        </div>
      )}

      {/* Create flow: form → (parent) consent gate → detail */}
      <TwinCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(twin) => setConsentFor(twin)}
      />

      <ConsentGrantDialog
        open={!!consentFor}
        onOpenChange={(open) => {
          if (open) return;
          // Closed without a grant — partial-failure path: open the twin detail
          // with an honest consent-retry state (capture stays blocked).
          const t = consentFor;
          setConsentFor(null);
          if (t) {
            toast.info('Consent not granted', {
              description: 'The twin exists, but capture and reconstruction stay blocked until consent is granted.',
            });
            setConsentPending(true);
            setSelectedTwinId(t.id);
            setTab('capture');
          }
        }}
        subjectId={consentFor?.subjectId ?? ''}
        purpose={`Create and reconstruct digital twin “${consentFor?.displayName ?? ''}”`}
        onGranted={() => {
          const t = consentFor;
          setConsentFor(null);
          if (t) {
            setConsentPending(false);
            setSelectedTwinId(t.id);
            setTab('capture');
          }
        }}
      />
    </div>
  );
}

export default TwinsView;
