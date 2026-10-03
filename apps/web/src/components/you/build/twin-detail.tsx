'use client';
// Twin detail — the studio core surface: header actions (capture, reconstruct,
// delete), and the Versions / Capture / Improve / Compare tabs. All state is
// canonical backend state; jobs poll the durable job endpoint.
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, IdChip, StatusBadge } from '@/components/you/shared/primitives';
import { ApiErrorSurface, useApiErrorSurface } from '@/components/you/shared/degraded-state';
import { useJob } from '@/hooks/you/use-job';
import { useYouStore } from '@/hooks/you/use-you-store';
import { api, uid, YouApiError } from '@/lib/you/client/api';
import type { CaptureSessionView, TwinView, TwinVersionView } from '@/lib/you/contracts';
import {
  ArrowLeft, Camera, FileBox, GitBranch, GitCompareArrows, Hammer, History,
  Loader2, Plus, ShieldCheck, Trash2, TriangleAlert,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ConfidenceBar, QueryError, RowSkeletons } from './confidence';
import { ConsentGrantDialog } from './consent-dialog';
import { CaptureSessionPanel } from './capture-session-panel';
import { F1CaptureFlow } from './f1-capture-flow';
import { F1ConsentGateDialog } from './f1-consent-dialog';
import { EvidenceRequestCard } from './evidence-request-card';
import { HtirInspector } from './htir-inspector';
import { JobStepsPanel } from './job-panel';
import { ProvenancePanel } from './provenance';
import { VersionCompare } from './version-compare';
import { timeAgo } from './format';

export const TWIN_TABS = ['versions', 'capture', 'improve', 'compare'] as const;
export type TwinTab = (typeof TWIN_TABS)[number];

const SESSION_TERMINAL: CaptureSessionView['status'][] = ['complete', 'failed'];
// P6.B8: `dead` (dead-letter terminal, P6.A6-FULL) included — a dead compile
// job is NOT running; treating it as live would spin forever.
const JOB_TERMINAL = ['succeeded', 'failed', 'cancelled', 'unavailable', 'dead'];

// LIMITATION (documented for TL): the frozen wave-1 client has no endpoint to
// list Solution Artifacts by twin version. The "Open Solution Artifact" button
// can therefore only appear for compiles executed in THIS browser session —
// the twin.compile job output carries solutionArtifactId (+ twinVersionId when
// known). Compiles from other sessions surface their artifacts through the
// Renders view and the event ledger instead.
const sessionArtifactsByVersion = new Map<string, string>();
const sessionArtifactsByTwin = new Map<string, string>();

type TwinDetailData = TwinView & { versions: TwinVersionView[]; captures: CaptureSessionView[] };

export function TwinDetail({
  twinId, tab, onTabChange, focusSessionId, onFocusSession, onBack, consentPending,
}: {
  twinId: string;
  tab: TwinTab;
  onTabChange: (t: TwinTab) => void;
  focusSessionId?: string | null;
  onFocusSession: (id: string) => void;
  onBack: () => void;
  consentPending?: boolean;
}) {
  const qc = useQueryClient();
  const navigate = useYouStore((s) => s.navigate);

  const detailQ = useQuery({
    queryKey: ['twin', twinId],
    queryFn: () => api.twins.get(twinId),
    refetchInterval: (q) => {
      const d = q.state.data as TwinDetailData | undefined;
      if (!d?.captures?.length) return false;
      const activeSession = d.captures.some((c) => !SESSION_TERMINAL.includes(c.status));
      return activeSession ? 2_500 : false;
    },
  });

  const consentQ = useQuery({ queryKey: ['consent'], queryFn: api.consent.list });
  const twin = detailQ.data;

  const [consentOpen, setConsentOpen] = useState(false);
  const [consentHint, setConsentHint] = useState<string | undefined>();
  // P6.B3 — guided F1 capture flow consent gate (the six F1 statements)
  const [f1ConsentOpen, setF1ConsentOpen] = useState(false);
  const [f1ConsentHint, setF1ConsentHint] = useState<string | undefined>();
  const [f1MissingStatements, setF1MissingStatements] = useState<string[] | undefined>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  // Sorted newest-first (plain derivable state, memoized).
  const versions = useMemo(
    () => [...(twin?.versions ?? [])].sort((a, b) => b.version - a.version),
    [twin?.versions],
  );

  // ── Reconstruct (twin.compile) ────────────────────────────────────────────
  const [compileJobId, setCompileJobId] = useState<string | null>(null);
  const [compileOpen, setCompileOpen] = useState(false);
  // P6.B8: typed error surface for the compile route's honest refusals (503
  // service_unavailable — provider circuit breaker open; 429 rate-limited).
  // Renders retry guidance derived from retryAfterMs and fires ONE automatic
  // retry after the backend's window; cleared on success.
  const compileErrors = useApiErrorSurface('Twin reconstruction');
  const compile = useMutation({
    mutationFn: () => api.twins.compile(twinId, {}, uid()),
    onSuccess: ({ jobId }) => {
      compileErrors.clear();
      setCompileJobId(jobId);
      setCompileOpen(true);
    },
    onError: (err) => {
      // honest degraded/rate-limited surfaces with retry guidance — not toasts
      if (compileErrors.capture(err)) return;
      toast.error('Could not start reconstruction', { description: err instanceof Error ? err.message : 'Unexpected error' });
    },
  });
  const { job: compileJob } = useJob(compileJobId);

  useEffect(() => {
    if (!compileJob || compileJob.status !== 'succeeded') return;
    const out = (compileJob.output ?? {}) as Record<string, unknown>;
    const artifactId = typeof out.solutionArtifactId === 'string' ? out.solutionArtifactId : null;
    const versionId = typeof out.twinVersionId === 'string' ? out.twinVersionId : null;
    if (artifactId) {
      if (versionId) sessionArtifactsByVersion.set(versionId, artifactId);
      sessionArtifactsByTwin.set(twinId, artifactId);
    }
    toast.success('Reconstruction complete', {
      description: versionId
        ? 'A new immutable TwinVersion was created from the evidence set.'
        : 'The new TwinVersion is now listed under Versions.',
      action: {
        label: 'Open version',
        onClick: () => {
          onTabChange('versions');
          setCompileOpen(false);
        },
      },
    });
    onTabChange('versions');
  }, [compileJob?.status]);

  useEffect(() => {
    if (compileJob && (compileJob.status === 'failed' || compileJob.status === 'cancelled' || compileJob.status === 'unavailable')) {
      toast.error('Reconstruction failed', { description: compileJob.error ?? `Job ended as ${compileJob.status}.` });
    }
    // P6.B8: dead is a DIFFERENT terminal state — retry budget exhausted.
    // The dead-letter surface (JobStepsPanel) carries the full explanation;
    // the toast only signals the terminal transition honestly.
    if (compileJob && compileJob.status === 'dead') {
      toast.error('Reconstruction is dead — retry budget exhausted', {
        description: 'The job was moved to the dead-letter queue. Operators can replay it from the maintenance console.',
      });
    }
  }, [compileJob?.status]);

  // ── Mutations ─────────────────────────────────────────────────────────────
  const startSession = useMutation({
    mutationFn: () => api.captures.start(twinId, {}, uid()),
    onSuccess: (session) => {
      toast.success('Capture session started', { description: 'Work through the checklist — evidence is immutable once uploaded.' });
      onFocusSession(session.id);
      void qc.invalidateQueries({ queryKey: ['twin', twinId] });
      void qc.invalidateQueries({ queryKey: ['captures'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (err) => {
      toast.error('Could not start capture session', { description: err instanceof Error ? err.message : 'Unexpected error' });
    },
  });

  // P6.B3 — start the GUIDED F1 capture flow (consent gate enforced server-
  // side; a consent_required refusal opens the F1 statements dialog with the
  // machine-readable missingStatements list)
  const startF1 = useMutation({
    mutationFn: () => api.captures.f1.start(twinId, uid()),
    onSuccess: (session) => {
      toast.success('Guided F1 capture started', {
        description: 'Walk the subject through the 8 steps — instructions are persisted with the capture.',
      });
      onFocusSession(session.id);
      void qc.invalidateQueries({ queryKey: ['twin', twinId] });
      void qc.invalidateQueries({ queryKey: ['captures'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (err) => {
      if (err instanceof YouApiError && err.code === 'consent_required') {
        const rec = err.details && typeof err.details === 'object' ? (err.details as Record<string, unknown>) : null;
        const missing = Array.isArray(rec?.missingStatements)
          ? (rec?.missingStatements as string[])
          : Array.isArray(rec?.invalidStatements) ? (rec?.invalidStatements as string[]) : [];
        setF1ConsentHint(err.message);
        setF1MissingStatements(missing.length > 0 ? missing : undefined);
        setF1ConsentOpen(true);
        return;
      }
      toast.error('Could not start guided F1 capture', { description: err instanceof Error ? err.message : 'Unexpected error' });
    },
  });

  const removeTwin = useMutation({
    mutationFn: () => api.twins.remove(twinId),
    onSuccess: () => {
      toast.success('Twin deleted');
      void qc.invalidateQueries({ queryKey: ['twins'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
      onBack();
    },
    onError: (err) => {
      toast.error('Could not delete twin', { description: err instanceof Error ? err.message : 'Unexpected error' });
    },
  });

  // ── Loading / error shells ────────────────────────────────────────────────
  if (detailQ.isPending) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" aria-label="Back to twins" onClick={onBack}><ArrowLeft className="size-4" /></Button>
          <Skeleton className="h-8 w-48" />
        </div>
        <Skeleton className="h-10 w-full rounded-lg" />
        <RowSkeletons rows={4} />
      </div>
    );
  }
  if (detailQ.isError || !twin) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5"><ArrowLeft className="size-3.5" aria-hidden /> Back to twins</Button>
        <QueryError error={detailQ.error ?? new Error('Twin not found')} title="Could not load this twin" onRetry={() => void detailQ.refetch()} />
      </div>
    );
  }

  // ── Derived state (non-hook) ─────────────────────────────────────────────
  const selectedVersion = versions.find((v) => v.id === selectedVersionId) ?? versions[0] ?? null;
  const latestVersion = versions[0] ?? null;

  const sessions = twin.captures ?? [];
  const activeSessions = sessions.filter((s) => !SESSION_TERMINAL.includes(s.status));
  const doneSessions = sessions.filter((s) => SESSION_TERMINAL.includes(s.status));
  const orderedActive = focusSessionId
    ? [...activeSessions].sort((a, b) => Number(b.id === focusSessionId) - Number(a.id === focusSessionId))
    : activeSessions;
  const evidenceCount = sessions.reduce((n, s) => n + (s.assets?.length ?? 0), 0);

  const grants = consentQ.data ?? [];
  const activeGrants = grants.filter(
    (g) => g.subjectId === twin.subjectId && !g.revokedAt && new Date(g.expiresAt).getTime() > Date.now(),
  );
  const hasCaptureConsent = activeGrants.some((g) => g.scopes.includes('capture'));

  const artifactId = selectedVersion
    ? sessionArtifactsByVersion.get(selectedVersion.id)
      ?? (selectedVersion.id === latestVersion?.id ? sessionArtifactsByTwin.get(twinId) : undefined)
    : undefined;

  const compileRunning = compileJobId && compileJob && !JOB_TERMINAL.includes(compileJob.status);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5 px-2 text-muted-foreground">
          <ArrowLeft className="size-3.5" aria-hidden /> Twins
        </Button>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-2xl font-semibold tracking-tight">{twin.displayName}</h1>
              <StatusBadge status={twin.status} />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {twin.personName ? <span>person: <span className="font-medium text-foreground/80">{twin.personName}</span></span> : null}
              <span className="you-num">v{twin.currentVersion}</span>
              <IdChip id={twin.id} label="twin" />
              <IdChip id={twin.subjectId} label="subject" />
              <span className="you-num" title={twin.createdAt}>created {timeAgo(twin.createdAt)}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => onTabChange('capture')} className="gap-1.5">
              <Camera className="size-3.5" aria-hidden /> New capture
            </Button>
            <Button
              size="sm"
              onClick={() => compile.mutate()}
              disabled={compile.isPending || !!compileRunning || evidenceCount === 0}
              className="gap-1.5"
              title={evidenceCount === 0 ? 'Upload evidence in a capture session first' : 'Compile evidence into a new immutable TwinVersion'}
            >
              {compile.isPending || compileRunning ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Hammer className="size-3.5" aria-hidden />}
              Reconstruct
            </Button>
            <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5 text-red-600 hover:text-red-600 dark:text-red-400 dark:hover:text-red-400">
                  <Trash2 className="size-3.5" aria-hidden /> Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete “{twin.displayName}”?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently removes the twin and its versions from this environment. The action
                    cannot be undone. Uploaded evidence and consent grants are audit records and may be
                    retained server-side.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-red-600 text-white hover:bg-red-700"
                    onClick={(e) => { e.preventDefault(); removeTwin.mutate(); }}
                    disabled={removeTwin.isPending}
                  >
                    {removeTwin.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                    Delete twin
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </div>

      {/* Consent retry banner (partial create-flow failure) */}
      {consentPending && !hasCaptureConsent ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3 text-[13px]">
          <TriangleAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
          <span className="min-w-0 flex-1">
            Consent was not granted — capture and reconstruction stay blocked until an active grant exists for this subject.
          </span>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => { setConsentHint(undefined); setConsentOpen(true); }}>
            <ShieldCheck className="size-3.5" aria-hidden /> Grant consent
          </Button>
        </div>
      ) : null}

      {/* Background compile progress (dialog closed) */}
      {compileJobId && !compileOpen && compileJob && !JOB_TERMINAL.includes(compileJob.status) ? (
        <button
          type="button"
          onClick={() => setCompileOpen(true)}
          className="you-focus flex w-full items-center gap-3 rounded-xl border bg-card px-4 py-3 text-left text-[13px] transition-colors hover:bg-muted/40"
        >
          <Loader2 className="size-4 shrink-0 animate-spin text-amber-600 dark:text-amber-400" aria-hidden />
          <span className="min-w-0 flex-1">Reconstruction in progress — viewing live job steps</span>
          <StatusBadge status={compileJob.status} />
        </button>
      ) : null}

      {/* P6.B8 — honest error surface: the compile route refused with a
          typed 503 (provider unavailable) or 429 (rate-limited). Retry
          guidance derives from the backend's retryAfterMs (one automatic
          retry after the window); nothing is running, nothing is fabricated. */}
      <ApiErrorSurface
        surface={compileErrors}
        onRetry={() => compile.mutate()}
        retrying={compile.isPending}
      />

      <Tabs value={tab} onValueChange={(v) => onTabChange(v as TwinTab)}>
        <TabsList className="h-10 w-full justify-start overflow-x-auto you-scroll p-1 sm:w-auto">
          <TabsTrigger value="versions" className="gap-1.5 text-[13px]"><GitBranch className="size-3.5" aria-hidden /> Versions</TabsTrigger>
          <TabsTrigger value="capture" className="gap-1.5 text-[13px]"><Camera className="size-3.5" aria-hidden /> Capture</TabsTrigger>
          <TabsTrigger value="improve" className="gap-1.5 text-[13px]"><History className="size-3.5" aria-hidden /> Improve</TabsTrigger>
          <TabsTrigger value="compare" className="gap-1.5 text-[13px]"><GitCompareArrows className="size-3.5" aria-hidden /> Compare</TabsTrigger>
        </TabsList>

        {/* ── Versions ──────────────────────────────────────────────────────── */}
        <TabsContent value="versions" className="mt-4">
          {versions.length === 0 ? (
            <EmptyState
              icon={GitBranch}
              title="No versions yet"
              hint="Versions are immutable HTIR compiles. Upload evidence in a capture session, then run Reconstruct to create v1."
              action={<Button size="sm" variant="outline" className="gap-1.5" onClick={() => onTabChange('capture')}><Camera className="size-3.5" aria-hidden /> Go to Capture</Button>}
            />
          ) : (
            <div className="grid gap-6 lg:grid-cols-[290px,1fr]">
              <nav aria-label="Twin versions" className="space-y-2">
                {versions.map((v) => {
                  const conf = v.confidenceSummary;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => setSelectedVersionId(v.id)}
                      aria-current={selectedVersion?.id === v.id ? 'true' : undefined}
                      className={cn(
                        'you-focus w-full rounded-lg border bg-card p-3.5 text-left transition-all hover:border-foreground/25',
                        selectedVersion?.id === v.id && 'border-emerald-500/50 ring-1 ring-emerald-500/25',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="you-num text-[13px] font-semibold">v{v.version}</span>
                        <StatusBadge status={v.status} />
                      </div>
                      <div className="mt-2"><ConfidenceBar value={conf?.overall} /></div>
                      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                        <span className="you-num" title={v.createdAt}>{timeAgo(v.createdAt)}</span>
                        <span className="you-num">{conf?.deficiencies?.length ?? 0} deficiencies</span>
                      </div>
                    </button>
                  );
                })}
              </nav>

              <div className="min-w-0 space-y-5">
                {selectedVersion ? (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card px-5 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <span className="you-num text-sm font-semibold">v{selectedVersion.version}</span>
                        <StatusBadge status={selectedVersion.status} />
                        <IdChip id={selectedVersion.id} label="" />
                      </div>
                      {artifactId ? (
                        <Button size="sm" className="gap-1.5" onClick={() => navigate('artifact', { artifactId })}>
                          <FileBox className="size-3.5" aria-hidden /> Open Solution Artifact
                        </Button>
                      ) : null}
                    </div>
                    <HtirInspector version={selectedVersion} onViewRequests={() => onTabChange('improve')} />
                    <section className="rounded-xl border bg-card p-5">
                      <h3 className="text-sm font-semibold">Provenance</h3>
                      <div className="mt-3"><ProvenancePanel version={selectedVersion} /></div>
                    </section>
                  </>
                ) : null}
              </div>
            </div>
          )}
        </TabsContent>

        {/* ── Capture ───────────────────────────────────────────────────────── */}
        <TabsContent value="capture" className="mt-4 space-y-4">
          {consentQ.isPending ? null : consentQ.isError ? (
            <p className="text-xs text-muted-foreground">Consent state unavailable — capture may be blocked.</p>
          ) : !hasCaptureConsent ? (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3.5">
              <ShieldCheck className="size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
              <span className="min-w-0 flex-1 text-[13px]">
                <span className="font-medium">Capture is consent-gated.</span>{' '}
                An active grant with the capture scope is required before evidence can be uploaded for this subject.
              </span>
              <Button size="sm" className="gap-1.5" onClick={() => { setConsentHint(undefined); setConsentOpen(true); }}>
                Grant consent
              </Button>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] text-muted-foreground">
              <span className="you-num font-medium text-foreground">{sessions.length}</span> sessions ·{' '}
              <span className="you-num font-medium text-foreground">{evidenceCount}</span> evidence assets
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {/* P6.B3 — the guided F1 flow (docs/F1_OPERATOR_CAPTURE.md): the
                  consent gate with the six statements opens on refusal */}
              <Button
                size="sm"
                variant="outline"
                onClick={() => startF1.mutate()}
                disabled={startF1.isPending || startSession.isPending}
                className="gap-1.5"
                title="Guided 8-step F1 capture — consent-gated with the six required statements"
              >
                {startF1.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Camera className="size-3.5" aria-hidden />}
                Guided F1 capture
              </Button>
              <Button
                size="sm"
                onClick={() => startSession.mutate()}
                disabled={startSession.isPending || startF1.isPending || (consentQ.isSuccess && !hasCaptureConsent)}
                className="gap-1.5"
                title={consentQ.isSuccess && !hasCaptureConsent ? 'Grant consent first' : undefined}
              >
                {startSession.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Plus className="size-3.5" aria-hidden />}
                Start capture session
              </Button>
            </div>
          </div>

          {orderedActive.length === 0 && doneSessions.length === 0 ? (
            <EmptyState
              icon={Camera}
              title="No capture sessions yet"
              hint="Start a session and work through the region checklist. Uploaded evidence is immutable."
            />
          ) : null}

          {orderedActive.map((session) => (
            <div key={session.id} className={cn(focusSessionId === session.id && 'rounded-xl ring-2 ring-emerald-500/35 ring-offset-2 ring-offset-background')}>
              {session.protocol ? (
                <F1CaptureFlow
                  twinId={twinId}
                  twinName={twin.displayName}
                  subjectId={twin.subjectId}
                  session={session}
                />
              ) : (
                <CaptureSessionPanel
                  twinId={twinId}
                  session={session}
                  onConsentRequired={(hint) => { setConsentHint(hint); setConsentOpen(true); }}
                />
              )}
            </div>
          ))}

          {doneSessions.length > 0 ? (
            <section className="rounded-xl border bg-card">
              <header className="border-b px-5 py-3">
                <h3 className="text-sm font-semibold">Completed sessions</h3>
              </header>
              <ul className="divide-y">
                {doneSessions.map((session) => (
                  <DoneSessionRow key={session.id} session={session} twinId={twinId} />
                ))}
              </ul>
            </section>
          ) : null}
        </TabsContent>

        {/* ── Improve ───────────────────────────────────────────────────────── */}
        <TabsContent value="improve" className="mt-4">
          <ImproveTab twinId={twinId} versions={versions} onFulfilled={(session) => { onFocusSession(session.id); onTabChange('capture'); }} />
        </TabsContent>

        {/* ── Compare ───────────────────────────────────────────────────────── */}
        <TabsContent value="compare" className="mt-4">
          <VersionCompare versions={versions} />
        </TabsContent>
      </Tabs>

      {/* Consent gate dialog (capture scope) */}
      <ConsentGrantDialog
        open={consentOpen}
        onOpenChange={setConsentOpen}
        subjectId={twin.subjectId}
        purpose={`Create and reconstruct digital twin “${twin.displayName}”`}
        missingScopeHint={consentHint}
      />

      {/* P6.B3 — F1 consent gate (the six operator-capture statements) */}
      <F1ConsentGateDialog
        open={f1ConsentOpen}
        onOpenChange={(o) => !o && setF1ConsentOpen(false)}
        subjectId={twin.subjectId}
        twinName={twin.displayName}
        missingHint={f1ConsentHint}
        missingStatements={f1MissingStatements}
        onGranted={() => {
          setF1ConsentOpen(false);
          setF1ConsentHint(undefined);
          setF1MissingStatements(undefined);
          void qc.invalidateQueries({ queryKey: ['consent'] });
          // retry the guided flow with the statement-covered grant
          startF1.mutate();
        }}
      />

      {/* Compile job dialog */}
      <Dialog open={compileOpen} onOpenChange={setCompileOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reconstruction</DialogTitle>
            <DialogDescription>
              Evidence compiles into a new immutable TwinVersion. Steps below are exactly what the backend reports.
            </DialogDescription>
          </DialogHeader>
          <JobStepsPanel job={compileJob} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DoneSessionRow({ session, twinId }: { session: CaptureSessionView; twinId: string }) {
  const [open, setOpen] = useState(false);
  const provided = session.checklist?.filter((i) => i.status === 'provided').length ?? 0;
  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-3 text-[13px]">
      <StatusBadge status={session.status} />
      <IdChip id={session.id} label="" />
      <span className="you-num text-xs text-muted-foreground">
        {session.assets?.length ?? 0} assets · checklist {provided}/{session.checklist?.length ?? 0}
      </span>
      <span className="you-num ml-auto text-xs text-muted-foreground" title={session.completedAt ?? session.createdAt}>
        {timeAgo(session.completedAt ?? session.createdAt)}
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <Button variant="outline" size="sm" className="h-7 text-[11.5px]" onClick={() => setOpen(true)}>View</Button>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              Completed capture session <IdChip id={session.id} label="" />
            </DialogTitle>
            <DialogDescription>
              {session.assets?.length ?? 0} immutable evidence assets · checklist {provided}/{session.checklist?.length ?? 0}
            </DialogDescription>
          </DialogHeader>
          <CaptureSessionPanel twinId={twinId} session={session} onConsentRequired={() => undefined} />
        </DialogContent>
      </Dialog>
    </li>
  );
}

function ImproveTab({ twinId, versions, onFulfilled }: {
  twinId: string;
  versions: TwinVersionView[];
  onFulfilled: (session: CaptureSessionView) => void;
}) {
  const requestsQ = useQuery({ queryKey: ['evidence-requests'], queryFn: api.artifacts.evidenceRequests });
  const versionIds = useMemo(() => new Set(versions.map((v) => v.id)), [versions]);

  if (requestsQ.isPending) return <RowSkeletons rows={3} />;
  if (requestsQ.isError) {
    return <QueryError error={requestsQ.error} title="Could not load evidence requests" onRetry={() => void requestsQ.refetch()} />;
  }

  const requests = requestsQ.data.filter((r) => r.twinVersionId && versionIds.has(r.twinVersionId));
  const open = requests.filter((r) => r.status === 'open');
  const closed = requests.filter((r) => r.status !== 'open');

  if (versions.length === 0) {
    return (
      <EmptyState
        icon={History}
        title="Nothing to improve yet"
        hint="Reconstruct the twin first — deficiencies surfaced by the compiler map to targeted evidence requests."
      />
    );
  }

  return (
    <div className="space-y-5">
      {requests.length === 0 ? (
        <EmptyState
          icon={History}
          title="No evidence requests for this twin"
          hint="Requests are created from HTIR deficiencies — open a version in the Versions tab and use “Request evidence”."
        />
      ) : (
        <>
          <p className="text-[13px] text-muted-foreground">
            <span className="you-num font-medium text-foreground">{open.length}</span> open ·{' '}
            <span className="you-num font-medium text-foreground">{closed.length}</span> fulfilled/expired
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            {requests.map((r) => (
              <EvidenceRequestCard key={r.id} request={r} twinId={twinId} onFulfilled={onFulfilled} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
