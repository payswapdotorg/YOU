'use client';
// Evidence Requests — the targeted-evidence worklist (P6.B5, Worker B lane).
// Every open request from HTIR deficiency analysis, with the closed feedback
// loop: Fulfill → GUIDED F1 capture (server-enforced consent gate, capability-
// focused protocol steps, out-of-scope steps pre-waived + disclosed) →
// complete flips the request fulfilled → review → TwinVersion linkage →
// (opportunistic) the B4 deficiency delta for the new version.
// Params: { requestId } opens the detail dialog for that request.
//
// Honesty laws (B1+B2/B8 bar): loading only while a query is actually in
// flight; the empty states distinguish "no requests yet" from "no matches for
// the filters"; the B4 deficiencies panel fetches OPPORTUNISTICALLY — a 404
// (B4 not deployed) hides the delta and shows the honest pending note, it is
// never treated as an error; a request whose fulfillment capture is in
// progress reads "open · fulfillment in progress" (status flips only at
// complete — no fake progress).
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { EmptyState, IdChip, PageHeader, StatusBadge } from '@/components/you/shared/primitives';
import { QueryError, RowSkeletons } from '@/components/you/build/confidence';
import { useYouStore } from '@/hooks/you/use-you-store';
import { api, uid, YouApiError } from '@/lib/you/client/api';
import type { CaptureSessionView, EvidenceRequestView } from '@/lib/you/contracts';
import type { DeficiencyRecordView } from '@/lib/you/client/api';
import {
  Camera, CircleCheck, Loader2, Minus, RotateCw, Target, TrendingDown,
  TrendingUp, UserRound,
} from 'lucide-react';
import { toast } from 'sonner';
import { F1CaptureFlow } from '../build/f1-capture-flow';
import { CaptureSessionPanel } from '../build/capture-session-panel';
import { F1ConsentGateDialog } from '../build/f1-consent-dialog';
import { timeAgo } from '../build/format';

const TERMINAL: CaptureSessionView['status'][] = ['complete', 'failed'];
type StatusFilter = 'all' | 'open' | 'fulfilled' | 'expired';

export function EvidenceRequestsView() {
  const params = useYouStore((s) => s.params);
  const navigate = useYouStore((s) => s.navigate);
  const [openId, setOpenId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [capabilityFilter, setCapabilityFilter] = useState<string>('all');

  // the filtered display query (dogfoods the server-side ?status=&capability=)
  const requestsQ = useQuery({
    queryKey: ['evidence-requests', 'list', statusFilter, capabilityFilter],
    queryFn: () => api.artifacts.evidenceRequests({
      ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
      ...(capabilityFilter !== 'all' ? { capability: capabilityFilter } : {}),
    }),
  });
  // unfiltered companion (capability options + the "any requests at all" test)
  const allQ = useQuery({
    queryKey: ['evidence-requests', 'all'],
    queryFn: () => api.artifacts.evidenceRequests(),
    staleTime: 15_000,
  });
  const twinsQ = useQuery({ queryKey: ['twins'], queryFn: api.twins.list });

  const twinById = useMemo(() => {
    const m = new Map<string, { displayName: string; subjectId: string }>();
    for (const t of twinsQ.data ?? []) m.set(t.id, { displayName: t.displayName, subjectId: t.subjectId });
    return m;
  }, [twinsQ.data]);

  const capabilities = useMemo(() => {
    const set = new Set<string>();
    for (const r of allQ.data ?? []) if (r.capability) set.add(r.capability);
    return [...set].sort();
  }, [allQ.data]);

  const requests = requestsQ.data ?? [];
  const total = allQ.data?.length ?? 0;
  const filtersActive = statusFilter !== 'all' || capabilityFilter !== 'all';

  // Consume { requestId } param → open that request's dialog (captures.tsx
  // render-phase pattern; the param is cleared in the store after commit).
  const [prevParams, setPrevParams] = useState<unknown>(null);
  if (params !== prevParams) {
    setPrevParams(params);
    if (params && typeof params.requestId === 'string') setOpenId(params.requestId);
  }
  useEffect(() => {
    if (params) useYouStore.setState({ params: null });
  }, [params]);

  const open = openId
    ? (allQ.data?.find((r) => r.id === openId) ?? requests.find((r) => r.id === openId) ?? null)
    : null;

  const refresh = () => {
    void requestsQ.refetch();
    void allQ.refetch();
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Build"
        title="Evidence Requests"
        description="Targeted additional-evidence requests with the closed loop: fulfill through a consent-gated guided capture, review, TwinVersion linkage — the request reads fulfilled only when the capture completes."
        actions={
          <Button variant="outline" size="sm" onClick={refresh} className="gap-1.5" disabled={requestsQ.isFetching}>
            <RotateCw className="size-3.5" aria-hidden /> Refresh
          </Button>
        }
      />

      {/* filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as StatusFilter)}
        >
          <SelectTrigger aria-label="Filter by status" className="h-9 w-36">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Status: all</SelectItem>
            <SelectItem value="open">open</SelectItem>
            <SelectItem value="fulfilled">fulfilled</SelectItem>
            <SelectItem value="expired">expired</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={capabilityFilter}
          onValueChange={setCapabilityFilter}
          disabled={capabilities.length === 0}
        >
          <SelectTrigger aria-label="Filter by capability" className="h-9 w-48">
            <SelectValue placeholder={capabilities.length === 0 ? 'No capabilities yet' : 'Capability'} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Capability: all</SelectItem>
            {capabilities.map((c) => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filtersActive ? (
          <Button
            variant="ghost" size="sm" className="gap-1.5"
            onClick={() => { setStatusFilter('all'); setCapabilityFilter('all'); }}
          >
            <Minus className="size-3.5" aria-hidden /> Clear filters
          </Button>
        ) : null}
        <span className="you-num ml-auto text-xs text-muted-foreground">
          {requests.length} shown{filtersActive && total > 0 ? ` · ${total} total` : ''}
        </span>
      </div>

      {requestsQ.isPending ? (
        <RowSkeletons rows={5} />
      ) : requestsQ.isError ? (
        <QueryError error={requestsQ.error} title="Could not load evidence requests" onRetry={refresh} />
      ) : requests.length === 0 && filtersActive && total > 0 ? (
        <EmptyState
          icon={Target}
          title="No requests match the current filters"
          hint="Try clearing the status or capability filter."
          action={
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => { setStatusFilter('all'); setCapabilityFilter('all'); }}>
              <Minus className="size-3.5" aria-hidden /> Clear filters
            </Button>
          }
        />
      ) : requests.length === 0 ? (
        <EmptyState
          icon={Target}
          title="No evidence requests yet"
          hint="Requests come from deficiency analysis on a twin version — compile a twin, review the surfaced deficiencies and request targeted evidence from there."
          action={
            <Button size="sm" onClick={() => navigate('twins')} className="gap-1.5">
              <UserRound className="size-3.5" aria-hidden /> Go to Twins
            </Button>
          }
        />
      ) : (
        <div className="rounded-xl border bg-card shadow-sm">
          <div className="overflow-x-auto you-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Request</TableHead>
                  <TableHead>Capability</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Fulfillment</TableHead>
                  <TableHead>Age</TableHead>
                  <TableHead className="w-16"><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests.map((r) => (
                  <TableRow
                    key={r.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open evidence request for ${r.capability}: ${r.reason}`}
                    className="cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    onClick={() => setOpenId(r.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(r.id); }
                    }}
                  >
                    <TableCell><IdChip id={r.id} label="" /></TableCell>
                    <TableCell>
                      <span className="rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                        {r.capability}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-64">
                      <span className="block truncate text-[13px]">{r.reason}</span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={r.status} />
                      {r.status === 'open' && r.captureSessionId ? (
                        <span className="ml-1.5 text-[11px] text-muted-foreground">in progress</span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {r.captureSessionId ? (
                        <IdChip id={r.captureSessionId} label="" />
                      ) : (
                        <span className="text-[12px] text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="you-num whitespace-nowrap text-[13px] text-muted-foreground">
                      {timeAgo(r.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Button variant="outline" size="sm" className="h-7 text-[11.5px]" onClick={(e) => { e.stopPropagation(); setOpenId(r.id); }}>
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {open ? (
        <RequestDetailDialog
          request={open}
          twinById={twinById}
          twinsPending={twinsQ.isPending}
          onClose={() => setOpenId(null)}
          onChanged={refresh}
        />
      ) : null}
    </div>
  );
}

// ─── detail dialog: the request + the fulfillment flow + the closed loop ─────

function RequestDetailDialog({
  request, twinById, twinsPending, onClose, onChanged,
}: {
  request: EvidenceRequestView;
  twinById: Map<string, { displayName: string; subjectId: string }>;
  twinsPending: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const [twinId, setTwinId] = useState<string>('');
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentHint, setConsentHint] = useState<string | undefined>();
  const [missingStatements, setMissingStatements] = useState<string[] | undefined>();

  const linkedSessionId = request.captureSessionId ?? null;

  // the linked capture session — the SAME cache entry F1CaptureFlow observes
  // internally (['capture', id]), so both poll/refresh together
  const sessionQ = useQuery({
    queryKey: ['capture', linkedSessionId],
    queryFn: () => api.captures.get(linkedSessionId as string),
    enabled: !!linkedSessionId,
    refetchInterval: (q) => {
      const data = q.state.data as CaptureSessionView | undefined;
      return data && TERMINAL.includes(data.status) ? false : 2_500;
    },
  });
  const session = sessionQ.data ?? null;
  const sessionTwin = session ? twinById.get(session.twinId) : undefined;

  // closed loop: when the linked session reaches a terminal state, refresh the
  // request list (complete flips the request fulfilled server-side)
  const sessionStatus = session?.status;
  useEffect(() => {
    if (sessionStatus && TERMINAL.includes(sessionStatus)) {
      void qc.invalidateQueries({ queryKey: ['evidence-requests'] });
    }
  }, [sessionStatus, qc]);

  const startFulfillment = useMutation({
    mutationFn: () => api.artifacts.fulfillEvidenceRequest(request.id, twinId, { idem: uid(), guided: true }),
    onSuccess: (res) => {
      toast.success('Guided fulfillment capture started', {
        description: 'The request is linked and stays open until this capture completes — walk the subject through the focused protocol steps.',
      });
      void qc.invalidateQueries({ queryKey: ['evidence-requests'] });
      void qc.invalidateQueries({ queryKey: ['capture', res.captureSession.id] });
      void qc.invalidateQueries({ queryKey: ['captures'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
      onChanged();
    },
    onError: (err) => {
      if (err instanceof YouApiError && err.code === 'consent_required') {
        const rec = err.details && typeof err.details === 'object' ? (err.details as Record<string, unknown>) : null;
        const missing = Array.isArray(rec?.missingStatements)
          ? (rec?.missingStatements as string[])
          : Array.isArray(rec?.invalidStatements) ? (rec?.invalidStatements as string[]) : [];
        setConsentHint(err.message);
        setMissingStatements(missing.length > 0 ? missing : undefined);
        setConsentOpen(true);
        return;
      }
      if (err instanceof YouApiError && err.code === 'conflict') {
        // in-progress fulfillment → surface it, the dialog will pick the link up
        const rec = err.details && typeof err.details === 'object' ? (err.details as Record<string, unknown>) : null;
        if (rec && typeof rec.captureSessionId === 'string') {
          toast.info('A fulfillment capture is already in progress', {
            description: 'Resuming the linked session — complete it to close the request.',
          });
          void qc.invalidateQueries({ queryKey: ['evidence-requests'] });
          onChanged();
          return;
        }
      }
      toast.error('Could not start fulfillment', { description: err instanceof Error ? err.message : 'Unexpected error' });
    },
  });

  const inProgress = request.status === 'open' && linkedSessionId && (!session || !TERMINAL.includes(session.status));
  const twins = [...twinById.entries()];

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto you-scroll">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 text-sm">
            Evidence request <IdChip id={request.id} label="" />
          </DialogTitle>
          <DialogDescription>
            capability <span className="font-mono text-[12px]">{request.capability}</span>
            {' · '}created {timeAgo(request.createdAt)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* request summary */}
          <section aria-label="Request details" className="space-y-2 rounded-lg border bg-muted/25 p-4 text-[12px] leading-relaxed">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={request.status} />
              <span className="rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                {request.capability}
              </span>
              {inProgress ? (
                <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10.5px] text-amber-700 dark:text-amber-400">
                  fulfillment in progress
                </span>
              ) : null}
              {request.twinVersionId ? <IdChip id={request.twinVersionId} label="twin version" /> : null}
            </div>
            <p><span className="font-semibold text-muted-foreground">Reason:</span> {request.reason}</p>
            <p><span className="font-semibold text-muted-foreground">Instructions:</span> {request.instructions}</p>
            <p><span className="font-semibold text-muted-foreground">Expected signal:</span> {request.expectedSignal}</p>
            <p className="text-muted-foreground"><span className="font-semibold">Scope:</span> <span className="font-mono text-[11px]">{request.scope}</span></p>
          </section>

          {/* fulfillment start (open, not yet linked) */}
          {request.status === 'open' && !linkedSessionId ? (
            <section aria-label="Start fulfillment" className="space-y-3 rounded-lg border p-4">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Fulfill with guided capture</h4>
              <p className="text-[12px] text-muted-foreground">
                Walks the operator through the consent-gated guided F1 capture focused on
                <span className="font-mono text-[11px]"> {request.capability}</span> — out-of-scope steps are pre-waived
                and disclosed at review. The request reads <span className="font-medium">fulfilled</span> when the capture completes.
              </p>
              {twinsPending ? (
                <Skeleton className="h-9 w-56" />
              ) : twins.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">
                  No twins exist yet — create a twin first (the fulfillment capture belongs to one).
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={twinId} onValueChange={setTwinId}>
                    <SelectTrigger aria-label="Twin to fulfill with" className="h-11 w-56 sm:h-9">
                      <SelectValue placeholder="Select twin" />
                    </SelectTrigger>
                    <SelectContent>
                      {twins.map(([id, t]) => (
                        <SelectItem key={id} value={id}>{t.displayName}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    className="h-11 gap-1.5 sm:h-9"
                    onClick={() => startFulfillment.mutate()}
                    disabled={startFulfillment.isPending || !twinId}
                    title={!twinId ? 'Pick the twin whose subject will be captured' : 'Start the guided fulfillment capture (consent-gated)'}
                  >
                    {startFulfillment.isPending
                      ? <Loader2 className="size-3.5 animate-spin" aria-hidden />
                      : <Camera className="size-3.5" aria-hidden />}
                    Start guided fulfillment
                  </Button>
                </div>
              )}
            </section>
          ) : null}

          {/* linked session: the flow + the closed loop */}
          {linkedSessionId ? (
            <section aria-label="Fulfillment capture" className="space-y-3">
              {sessionQ.isPending ? (
                <RowSkeletons rows={3} />
              ) : sessionQ.isError ? (
                <QueryError
                  error={sessionQ.error}
                  title="Could not load the fulfillment capture"
                  onRetry={() => void sessionQ.refetch()}
                />
              ) : session ? (
                <>
                  {/* closed-loop strip (honest, from persisted state only) */}
                  {session.status === 'complete' ? (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.05] px-4 py-2.5 text-[12px]">
                      <span className="flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400">
                        <CircleCheck className="size-3.5" aria-hidden />
                        {request.status === 'fulfilled' ? 'Request fulfilled' : 'Capture completed'}
                      </span>
                      {session.manifest ? (
                        <span className="you-num text-muted-foreground">
                          manifest {session.manifest.totals.verified}/{session.manifest.totals.assets} assets hash-verified
                        </span>
                      ) : null}
                      <span className="text-muted-foreground">
                        review →{' '}
                        {session.review?.status === 'promoted' && session.review.twinVersionId ? (
                          <span className="you-num">
                            TwinVersion v{session.review.twinVersionNumber} · {session.review.twinVersionId.slice(0, 14)}…
                          </span>
                        ) : session.review?.status === 'rejected' ? 'rejected (verdict recorded)' : (
                          'pending — approve in the flow below to link the TwinVersion'
                        )}
                      </span>
                    </div>
                  ) : null}
                  {session.status === 'failed' ? (
                    <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/[0.05] px-4 py-2.5 text-[12px] text-red-600 dark:text-red-400">
                      The fulfillment capture failed — the request stays open; start a new fulfillment when ready.
                    </p>
                  ) : null}

                  {/* the B4 delta (opportunistic) — only meaningful with a completed capture */}
                  {session.status === 'complete' ? (
                    <DeficiencyDeltaPanel
                      twinId={session.twinId}
                      twinVersionId={session.review?.twinVersionId ?? request.twinVersionId ?? null}
                    />
                  ) : null}

                  {session.protocol ? (
                    <F1CaptureFlow
                      twinId={session.twinId}
                      twinName={sessionTwin?.displayName}
                      subjectId={sessionTwin?.subjectId}
                      session={session}
                    />
                  ) : (
                    <CaptureSessionPanel
                      twinId={session.twinId}
                      session={session}
                      onConsentRequired={() => undefined}
                    />
                  )}
                </>
              ) : (
                <p className="text-[12px] text-muted-foreground">
                  The linked capture session no longer exists (it may have been deleted).
                </p>
              )}
            </section>
          ) : null}

          {request.status === 'expired' ? (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-4 py-2.5 text-[12px] text-amber-700 dark:text-amber-400">
              This request expired — its TTL window passed without a completed fulfillment. A new request can be raised
              from the twin version&apos;s deficiencies.
            </p>
          ) : null}
        </div>

        <F1ConsentGateDialog
          open={consentOpen}
          onOpenChange={(o) => !o && setConsentOpen(false)}
          subjectId={twinId ? twinById.get(twinId)?.subjectId ?? '' : ''}
          twinName={twinId ? twinById.get(twinId)?.displayName ?? '' : ''}
          missingHint={consentHint}
          missingStatements={missingStatements}
          onGranted={() => {
            setConsentOpen(false);
            setConsentHint(undefined);
            setMissingStatements(undefined);
            // the grant now covers capture — retry the fulfillment start
            if (twinId) startFulfillment.mutate();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

// ─── B4 deficiency delta (opportunistic; 404 → honest pending note) ─────────

function DeficiencyDeltaPanel({
  twinId, twinVersionId,
}: {
  twinId: string;
  twinVersionId?: string | null;
}) {
  const q = useQuery({
    queryKey: ['deficiencies', twinId],
    queryFn: () => api.twins.deficiencies(twinId),
    retry: false,
    staleTime: 30_000,
  });

  // 404 → B4 is not deployed: hide the delta, show the honest pending note
  if (q.isError) {
    const err = q.error;
    if (err instanceof YouApiError && err.status === 404) {
      return (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-muted/25 px-4 py-2.5 text-[12px] text-muted-foreground">
          <TrendingUp className="size-3.5 shrink-0" aria-hidden />
          <span>
            Deficiency re-evaluation pending B4 — the deficiency visualization service is not available in this
            deployment, so the improved/regressed delta for this version cannot be shown.
          </span>
        </div>
      );
    }
    return (
      <QueryError
        error={err}
        title="Could not load the deficiency delta"
        onRetry={() => void q.refetch()}
        compact
      />
    );
  }

  if (q.isPending) return <Skeleton className="h-10 w-full rounded-lg" />;

  // tolerant read: top-level array or { deficiencies: [...] } — B4's exact
  // contract is frozen by the parallel lane, nothing is fabricated here
  const payload = q.data;
  const records: DeficiencyRecordView[] | null = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { deficiencies?: DeficiencyRecordView[] }).deficiencies)
      ? (payload as { deficiencies: DeficiencyRecordView[] }).deficiencies
      : null;

  if (!records) {
    return (
      <div className="flex items-center gap-2 rounded-lg border bg-muted/25 px-4 py-2.5 text-[12px] text-muted-foreground">
        <TrendingUp className="size-3.5 shrink-0" aria-hidden />
        <span>B4 responded, but the deficiency payload shape is not recognized by this view — no delta rendered.</span>
      </div>
    );
  }

  const byCapability = new Map<string, { open: number; resolved: number }>();
  for (const r of records) {
    const key = r.capability ?? r.region ?? 'other';
    const entry = byCapability.get(key) ?? { open: 0, resolved: 0 };
    if (typeof r.status === 'string' && ['resolved', 'closed', 'addressed'].includes(r.status)) entry.resolved += 1;
    else entry.open += 1;
    byCapability.set(key, entry);
  }

  return (
    <div className="space-y-2 rounded-lg border bg-muted/25 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Deficiency delta (B4) {twinVersionId ? <span className="you-num normal-case">· for the new version</span> : null}
        </h4>
        <span className="you-num text-[11px] text-muted-foreground">
          {records.length} record{records.length === 1 ? '' : 's'}
        </span>
      </div>
      {records.length === 0 ? (
        <p className="flex items-center gap-1.5 text-[12px] text-emerald-700 dark:text-emerald-400">
          <TrendingUp className="size-3.5" aria-hidden /> No open deficiencies reported for this twin — the fulfillment
          closed the recorded gaps.
        </p>
      ) : (
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {[...byCapability.entries()].map(([cap, counts]) => (
            <li key={cap} className="flex items-center justify-between gap-2 rounded-md border bg-card px-2.5 py-1.5 text-[12px]">
              <span className="font-mono text-[11px] text-muted-foreground">{cap}</span>
              <span className="flex items-center gap-2">
                {counts.open > 0 ? (
                  <span className="you-num flex items-center gap-1 text-amber-700 dark:text-amber-400">
                    <TrendingDown className="size-3" aria-hidden /> {counts.open} open
                  </span>
                ) : null}
                {counts.resolved > 0 ? (
                  <span className="you-num flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                    <TrendingUp className="size-3" aria-hidden /> {counts.resolved} resolved
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default EvidenceRequestsView;
