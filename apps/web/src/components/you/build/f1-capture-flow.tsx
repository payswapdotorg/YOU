'use client';
// F1 guided capture flow panel (P6.B3) — the operator-facing surface for
// docs/F1_OPERATOR_CAPTURE.md: walks the operator through the 8-step protocol
// with REAL per-step state (pending / current / done / skipped-with-reason),
// the PERSISTED instruction text (rendered verbatim from the protocol the
// server stores on the capture), per-step submit + skip-with-reason, the
// honest checkpoint report for every submitted step, manifest completion,
// review → TwinVersion linkage, deletion (retention-honoring) and export.
//
// Honesty laws (B8 pattern): loading states exist ONLY while a mutation is
// actually in flight (no fake spinners); consent_required errors surface the
// F1 consent gate with the machine-readable missingStatements list; failed
// checkpoints render the server's report verbatim; degraded/rate-limited
// errors render the shared ApiErrorSurface; the deletion refusal (409
// policy_blocked) shows the retention window + withdrawal guidance.
import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { IdChip, StatusBadge } from '@/components/you/shared/primitives';
import { ApiErrorSurface, useApiErrorSurface } from '@/components/you/shared/degraded-state';
import { api, uid, YouApiError } from '@/lib/you/client/api';
import type { CaptureSessionView, F1GuidedStep } from '@/lib/you/contracts';
import {
  Camera, Check, Circle, CircleCheck, Download, FileUp, Loader2, Minus,
  ScanSearch, ShieldCheck, Trash2, TriangleAlert,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { F1ConsentGateDialog } from './f1-consent-dialog';
import { EvidenceGrid } from './evidence-grid';
import { timeAgo } from './format';

const TERMINAL: CaptureSessionView['status'][] = ['complete', 'failed'];

/** Client-side accept hint per step (the SERVER validates the exact mimes). */
const STEP_ACCEPT: Record<string, string> = {
  'face-front': 'image/png,image/jpeg,image/webp',
  'face-turn': 'image/png,image/jpeg,image/webp',
  'upper-body': 'image/png,image/jpeg,image/webp',
  'full-body': 'image/png,image/jpeg,image/webp',
  hands: 'image/png,image/jpeg,image/webp',
  'turn-around': 'image/png,image/jpeg,image/webp',
  walking: 'video/mp4,video/webm',
  speech: 'audio/wav,audio/mpeg,audio/ogg,video/mp4,video/webm',
};

export function F1CaptureFlow({
  twinId, twinName, subjectId, session: initial,
}: {
  twinId: string;
  twinName?: string | null;
  subjectId?: string | null;
  session: CaptureSessionView;
}) {
  const qc = useQueryClient();
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentHint, setConsentHint] = useState<string | undefined>();
  const [missingStatements, setMissingStatements] = useState<string[] | undefined>();
  const [skipReason, setSkipReason] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteRefusal, setDeleteRefusal] = useState<string | null>(null);
  const flowErrors = useApiErrorSurface('F1 capture flow');
  const reviewErrors = useApiErrorSurface('F1 capture review');

  const sessionQ = useQuery({
    queryKey: ['capture', initial.id],
    queryFn: () => api.captures.get(initial.id),
    initialData: initial,
    refetchInterval: (q) => {
      const data = q.state.data as CaptureSessionView | undefined;
      return data && TERMINAL.includes(data.status) ? false : 2_500;
    },
  });
  const session = sessionQ.data ?? initial;
  const protocol = session.protocol ?? null;
  const terminal = TERMINAL.includes(session.status);
  const review = session.review ?? { status: 'none' as const };

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['capture', session.id] });
    void qc.invalidateQueries({ queryKey: ['twin', twinId] });
    void qc.invalidateQueries({ queryKey: ['captures'] });
    void qc.invalidateQueries({ queryKey: ['overview'] });
  };

  // consent_required → the F1 consent gate (machine-readable missing list)
  const onConsentError = (err: unknown) => {
    if (err instanceof YouApiError && err.code === 'consent_required') {
      const rec = err.details && typeof err.details === 'object' ? (err.details as Record<string, unknown>) : null;
      const missing = Array.isArray(rec?.missingStatements)
        ? (rec?.missingStatements as string[])
        : Array.isArray(rec?.invalidStatements) ? (rec?.invalidStatements as string[]) : [];
      setConsentHint(err.message);
      setMissingStatements(missing.length > 0 ? missing : undefined);
      setConsentOpen(true);
      return true;
    }
    return false;
  };

  const submitStep = useMutation({
    mutationFn: ({ stepId, file }: { stepId: string; file: File }) =>
      api.captures.f1.submitStep(session.id, stepId, file),
    onSuccess: (res) => {
      flowErrors.clear();
      const cp = res.submitted?.checkpoint;
      toast.success(`Step “${res.submitted?.stepId}” captured`, {
        description: cp
          ? `checkpoint ${cp.passed ? 'passed' : 'FAILED'} · score ${(cp.score * 100).toFixed(0)}% · ${cp.sniffed?.container ?? 'container n/a'}`
          : undefined,
      });
      invalidate();
    },
    onError: (err) => {
      if (onConsentError(err)) return;
      if (flowErrors.capture(err)) return;
      toast.error('Step submit failed', { description: err instanceof Error ? err.message : 'Unexpected error' });
    },
  });

  const skipStep = useMutation({
    mutationFn: ({ stepId, reason }: { stepId: string; reason: string }) =>
      api.captures.f1.skipStep(session.id, stepId, reason),
    onSuccess: () => {
      flowErrors.clear();
      setSkipReason('');
      toast.success('Step skipped — reason recorded');
      invalidate();
    },
    onError: (err) => {
      if (onConsentError(err)) return;
      toast.error('Could not skip step', { description: err instanceof Error ? err.message : 'Unexpected error' });
    },
  });

  const complete = useMutation({
    mutationFn: () => api.captures.f1.complete(session.id, uid()),
    onSuccess: (res) => {
      flowErrors.clear();
      const m = res.manifest;
      toast.success('Capture complete — manifest built', {
        description: m ? `${m.totals.verified}/${m.totals.assets} assets hash-verified · ${(m.totals.bytes / 1024).toFixed(0)} KB` : undefined,
      });
      invalidate();
    },
    onError: (err) => {
      if (onConsentError(err)) return;
      if (flowErrors.capture(err)) return;
      toast.error('Could not complete capture', { description: err instanceof Error ? err.message : 'Unexpected error' });
    },
  });

  const reviewMut = useMutation({
    mutationFn: (verdict: 'approve' | 'reject') =>
      api.captures.f1.review(session.id, { verdict, ...(reviewNote.trim() ? { note: reviewNote.trim() } : {}) }, uid()),
    onSuccess: (res) => {
      reviewErrors.clear();
      setReviewNote('');
      if (res.review?.status === 'promoted') {
        toast.success('Review approved — capture promoted to TwinVersion linkage', {
          description: `TwinVersion v${res.review.twinVersionNumber} · acceptance chain recorded.`,
        });
      } else {
        toast.success('Review rejected — verdict recorded');
      }
      invalidate();
    },
    onError: (err) => {
      if (onConsentError(err)) return;
      if (reviewErrors.capture(err)) return;
      toast.error('Could not record review', { description: err instanceof Error ? err.message : 'Unexpected error' });
    },
  });

  const remove = useMutation({
    mutationFn: () => api.captures.f1.remove(session.id),
    onSuccess: (res) => {
      toast.success('Capture deleted', {
        description: `${res.assetsDeleted} assets · ${res.objectsDeleted} objects removed${res.objectsRetained > 0 ? ` · ${res.objectsRetained} shared objects retained` : ''}.`,
      });
      invalidate();
    },
    onError: (err) => {
      if (err instanceof YouApiError && err.code === 'conflict') {
        const rec = err.details && typeof err.details === 'object' ? (err.details as Record<string, unknown>) : null;
        setDeleteRefusal(
          `${err.message}${rec?.withdrawal ? ` — ${String(rec.withdrawal)}` : ''}`,
        );
        return;
      }
      toast.error('Could not delete capture', { description: err instanceof Error ? err.message : 'Unexpected error' });
    },
  });

  const steps = protocol?.steps ?? [];
  const done = steps.filter((s) => s.state === 'done').length;
  const skipped = steps.filter((s) => s.state === 'skipped');
  const skippedRequired = skipped.filter((s) => s.required);
  const current = steps.find((s) => s.id === protocol?.currentStepId) ?? null;
  const canComplete = !terminal
    && steps.length > 0
    && steps.filter((s) => s.required && s.state === 'pending').length === 0
    && (session.assets?.length ?? 0) > 0;

  const manifest = session.manifest ?? null;
  const checkpoints = (session.checkpoints ?? null) as Record<string, unknown> | null;

  const submitFailure = useMemo(() => {
    // the honest checkpoint report rides the 400 envelope's details
    const err = submitStep.error;
    if (err instanceof YouApiError) {
      const rec = err.details && typeof err.details === 'object' ? (err.details as Record<string, unknown>) : null;
      if (rec && rec.checkpoint && typeof rec.checkpoint === 'object') {
        return { message: err.message, checkpoint: rec.checkpoint as { issues?: string[]; refusal?: { code: string; message: string } } };
      }
      return { message: err.message, checkpoint: null };
    }
    return null;
  }, [submitStep.error]);

  if (!protocol) {
    return (
      <p className="rounded-lg border bg-card px-4 py-3 text-xs text-muted-foreground">
        This session carries no guided F1 protocol.
      </p>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border bg-card shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3.5">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">Guided F1 capture</h3>
            <StatusBadge status={session.status} />
            <IdChip id={session.id} label="" />
            {review.status !== 'none' ? (
              <Badge variant="outline" className="font-mono text-[10px]">
                review: {review.status}
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            <span className="you-num">{timeAgo(session.createdAt)}</span>
            {session.consentGrantId ? <span> · consent grant {session.consentGrantId.slice(0, 12)}…</span> : null}
            {session.retention ? <span> · retention: {session.retention.policy}</span> : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="you-num text-xs text-muted-foreground">
            {done}/{steps.length} steps done{skipped.length > 0 ? ` · ${skipped.length} skipped` : ''}
          </span>
          {!terminal ? (
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => complete.mutate()}
              disabled={complete.isPending || !canComplete}
              title={!canComplete ? 'Finish every required step (done or skipped-with-reason) and upload at least one asset first' : 'Build the content-addressed evidence manifest and complete the session'}
            >
              {complete.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ScanSearch className="size-3.5" aria-hidden />}
              Complete &amp; build manifest
            </Button>
          ) : null}
        </div>
      </header>

      <div className="space-y-5 p-5">
        {session.error ? (
          <p role="alert" className="flex items-start gap-2 rounded-md border border-red-500/25 bg-red-500/[0.05] px-3 py-2 text-xs text-red-600 dark:text-red-400">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {session.error}
          </p>
        ) : null}

        <ApiErrorSurface surface={flowErrors} onRetry={() => complete.mutate()} retrying={complete.isPending} />

        {/* progress: real step states, nothing fabricated */}
        <section aria-label="F1 capture protocol progress">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Protocol — {protocol.source}
            </h4>
            <span className="you-num text-[11px] text-muted-foreground">{protocol.version}</span>
          </div>
          <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-emerald-500/70 transition-all"
              style={{ width: `${steps.length > 0 ? (done / steps.length) * 100 : 0}%` }}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={steps.length}
              aria-valuenow={done}
              aria-label="Completed protocol steps"
            />
          </div>
          <ul className="space-y-2">
            {steps.map((step) => (
              <F1StepRow
                key={step.id}
                step={step}
                isCurrent={step.id === protocol.currentStepId && !terminal}
                disabled={terminal || submitStep.isPending || skipStep.isPending}
                accept={STEP_ACCEPT[step.id] ?? 'image/*'}
                onPick={(file) => submitStep.mutate({ stepId: step.id, file })}
                pending={submitStep.isPending && submitStep.variables?.stepId === step.id}
                skipPending={skipStep.isPending && skipStep.variables?.stepId === step.id}
                skipReason={skipReason}
                onSkipReason={setSkipReason}
                onSkip={() => skipStep.mutate({ stepId: step.id, reason: skipReason })}
              />
            ))}
          </ul>
        </section>

        {submitFailure ? (
          <div role="alert" className="space-y-1.5 rounded-lg border border-red-500/25 bg-red-500/[0.06] px-4 py-3">
            <p className="text-xs font-medium text-red-700 dark:text-red-400">Checkpoint refused the last submission</p>
            <p className="text-xs text-muted-foreground">{submitFailure.message}</p>
            {submitFailure.checkpoint?.refusal ? (
              <p className="font-mono text-[11px] text-muted-foreground">
                {submitFailure.checkpoint.refusal.code}: {submitFailure.checkpoint.refusal.message}
              </p>
            ) : null}
            {submitFailure.checkpoint?.issues?.length ? (
              <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
                {submitFailure.checkpoint.issues.map((i, idx) => <li key={idx}>{i}</li>)}
              </ul>
            ) : null}
            <p className="text-[11px] text-muted-foreground">The failed asset stays recorded and is disclosed in the manifest — retry with corrected evidence.</p>
          </div>
        ) : null}

        {/* completion: the manifest + checkpoint summary the server built */}
        {terminal && session.status === 'complete' && manifest ? (
          <section aria-label="Evidence manifest" className="space-y-2 rounded-lg border bg-muted/25 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <CircleCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
                Content-addressed manifest
              </span>
              <span className="you-num text-[11px] text-muted-foreground">
                sha256 · {manifest.totals.verified}/{manifest.totals.assets} verified · {(manifest.totals.bytes / 1024).toFixed(0)} KB
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              provenance: grant {manifest.provenance.consentGrantId.slice(0, 12)}… · deletion policy: {manifest.deletionPolicy.policy}
              {manifest.deletionPolicy.retainUntil ? ` (until ${manifest.deletionPolicy.retainUntil.slice(0, 10)})` : ''}
            </p>
            {skippedRequired.length > 0 ? (
              <p role="alert" className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
                Skipped REQUIRED steps (disclosed at review): {skippedRequired.map((s) => s.id).join(', ')}
              </p>
            ) : null}
            {checkpoints && typeof checkpoints.checkpointsFailed === 'number' && (checkpoints.checkpointsFailed as { stepId: string }[] | number) !== 0 ? (
              <p className="text-[11px] text-muted-foreground">
                {(checkpoints.checkpointsFailed as number)} step submission(s) failed a checkpoint — recorded verbatim, never dropped.
              </p>
            ) : null}
          </section>
        ) : null}

        {/* review: the acceptance-chain promotion */}
        {terminal && session.status === 'complete' ? (
          <section aria-label="Review and TwinVersion linkage" className="space-y-3 rounded-lg border p-4">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Review → TwinVersion linkage
            </h4>
            {review.status === 'none' ? (
              <>
                <p className="text-[12px] text-muted-foreground">
                  Approving promotes this capture to its reconstructed TwinVersion and records the full acceptance chain
                  (capture → consent → liveness → quality → reconstruction → TwinVersion → review). Rejection records the verdict without linkage.
                </p>
                <ApiErrorSurface surface={reviewErrors} onRetry={() => reviewMut.mutate('approve')} retrying={reviewMut.isPending} />
                <Input
                  value={reviewNote}
                  onChange={(e) => setReviewNote(e.target.value)}
                  placeholder="Review note (optional — travels with the verdict and the chain)"
                  aria-label="Review note"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" className="gap-1.5" onClick={() => reviewMut.mutate('approve')} disabled={reviewMut.isPending}>
                    {reviewMut.isPending && reviewMut.variables === 'approve'
                      ? <Loader2 className="size-3.5 animate-spin" aria-hidden />
                      : <Check className="size-3.5" aria-hidden />}
                    Approve &amp; promote
                  </Button>
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={() => reviewMut.mutate('reject')} disabled={reviewMut.isPending}>
                    {reviewMut.isPending && reviewMut.variables === 'reject'
                      ? <Loader2 className="size-3.5 animate-spin" aria-hidden />
                      : <Minus className="size-3.5" aria-hidden />}
                    Reject
                  </Button>
                </div>
              </>
            ) : (
              <div className="space-y-1.5 text-[12px]">
                <p className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="font-mono text-[10px]">review: {review.status}</Badge>
                  {review.twinVersionId ? (
                    <span className="you-num text-muted-foreground">TwinVersion v{review.twinVersionNumber} · {review.twinVersionId.slice(0, 14)}…</span>
                  ) : null}
                  <span className="you-num text-muted-foreground">{review.decidedAt ? timeAgo(review.decidedAt) : ''}</span>
                </p>
                {review.note ? <p className="text-muted-foreground">note: {review.note}</p> : null}
                {review.chain ? (
                  <p className="text-[11px] text-muted-foreground">
                    chain: capture ✓ · consent ✓ · liveness {review.chain.liveness.stepsChecked}/{steps.length} checked ({review.chain.liveness.refusals} refusals)
                    · quality {review.chain.quality.stepsDone} done / {review.chain.quality.stepsSkipped} skipped
                    {review.chain.quality.skippedRequired.length > 0 ? ` (required skipped: ${review.chain.quality.skippedRequired.join(', ')})` : ''}
                    · reconstruction v{review.chain.reconstruction.version} · review ✓
                  </p>
                ) : null}
              </div>
            )}
          </section>
        ) : null}

        {/* deletion + export */}
        {terminal && session.status === 'complete' ? (
          <section aria-label="Deletion and export" className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/25 p-4">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => window.open(api.captures.f1.exportUrl(session.id), '_blank', 'noopener')}
            >
              <Download className="size-3.5" aria-hidden /> Export bundle
            </Button>
            {deleteConfirm ? (
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-muted-foreground">Delete the evidence now?</span>
                <Button size="sm" variant="destructive" className="gap-1.5" onClick={() => remove.mutate()} disabled={remove.isPending}>
                  {remove.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Trash2 className="size-3.5" aria-hidden />}
                  Confirm deletion
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setDeleteConfirm(false); setDeleteRefusal(null); }} disabled={remove.isPending}>Cancel</Button>
              </span>
            ) : (
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setDeleteConfirm(true)}>
                <Trash2 className="size-3.5" aria-hidden /> Delete (honors retention)
              </Button>
            )}
            {deleteRefusal ? (
              <p role="alert" className="flex w-full items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
                <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden /> {deleteRefusal}
              </p>
            ) : null}
          </section>
        ) : null}

        <section aria-label="Uploaded evidence">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Evidence assets ({session.assets?.length ?? 0})
          </h4>
          <EvidenceGrid
            assets={session.assets ?? []}
            emptyHint={terminal
              ? 'No evidence assets were uploaded to this session.'
              : 'No evidence yet — submit each step above; failed submissions stay recorded too.'}
          />
        </section>
      </div>

      <F1ConsentGateDialog
        open={consentOpen}
        onOpenChange={(o) => !o && setConsentOpen(false)}
        subjectId={subjectId ?? ''}
        twinName={twinName ?? ''}
        missingHint={consentHint}
        missingStatements={missingStatements}
        onGranted={() => {
          setConsentOpen(false);
          setConsentHint(undefined);
          setMissingStatements(undefined);
          invalidate();
        }}
      />
    </div>
  );
}

// ─── one guided step row ─────────────────────────────────────────────────────

function F1StepRow({
  step, isCurrent, disabled, accept, onPick, pending, skipPending, skipReason, onSkipReason, onSkip,
}: {
  step: F1GuidedStep;
  isCurrent: boolean;
  disabled: boolean;
  accept: string;
  onPick: (file: File) => void;
  pending: boolean;
  skipPending: boolean;
  skipReason: string;
  onSkipReason: (v: string) => void;
  onSkip: () => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const stateIcon =
    step.state === 'done' ? <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
    : step.state === 'skipped' ? <Minus className="size-4 text-muted-foreground" aria-hidden />
    : isCurrent ? <Camera className="size-4 text-amber-600 dark:text-amber-400" aria-hidden />
    : <Circle className="size-4 text-muted-foreground/50" aria-hidden />;

  return (
    <li className={cn(
      'rounded-lg border px-3.5 py-3 transition-colors',
      isCurrent && 'border-amber-500/35 bg-amber-500/[0.04]',
      step.state === 'done' && 'border-emerald-500/25',
    )}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {stateIcon}
            <span className="text-[13px] font-medium">
              <span className="you-num text-muted-foreground">{step.step}.</span> {step.label}
            </span>
            <span className={cn(
              'rounded-full border px-1.5 py-0.5 text-[10.5px]',
              step.required ? 'bg-muted/50 text-muted-foreground' : 'border-border bg-muted/30 text-muted-foreground/70',
            )}>
              {step.required ? 'required' : 'optional'}
            </span>
            {step.state === 'skipped' ? (
              <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10.5px] text-amber-700 dark:text-amber-400">
                skipped
              </span>
            ) : null}
          </div>
          {/* the PERSISTED instruction text, rendered verbatim */}
          <p className="text-[12px] leading-relaxed text-muted-foreground">{step.instruction}</p>
          <p className="text-[11px] leading-relaxed text-muted-foreground/75">
            <span className="font-medium">Regions:</span> {step.regions.join(', ')}
          </p>
          {step.coarseGrainingNote ? (
            <p className="text-[11px] italic leading-relaxed text-muted-foreground/60">{step.coarseGrainingNote}</p>
          ) : null}
          {step.state === 'skipped' && step.skipReason ? (
            <p className="text-[11px] text-amber-700 dark:text-amber-400">reason: {step.skipReason}</p>
          ) : null}
          {step.state === 'done' && step.checkpoint ? (
            <p className="you-num text-[11px] text-muted-foreground">
              checkpoint {step.checkpoint.passed ? 'passed' : 'FAILED'} · score {(step.checkpoint.score * 100).toFixed(0)}%
              {step.checkpoint.sniffed ? ` · ${step.checkpoint.sniffed.container}${step.checkpoint.sniffed.width ? ` ${step.checkpoint.sniffed.width}×${step.checkpoint.sniffed.height}` : ''}` : ''}
              {step.contentHash ? ` · sha256 ${step.contentHash.slice(0, 12)}…` : ''}
            </p>
          ) : null}
        </div>
        {isCurrent ? (
          <div className="flex shrink-0 flex-col items-end gap-2">
            <input
              ref={fileRef}
              type="file"
              accept={accept}
              className="hidden"
              aria-label={`Upload evidence for step ${step.step}: ${step.label}`}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onPick(f);
                e.target.value = '';
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-2.5 text-[11.5px]"
              onClick={() => fileRef.current?.click()}
              disabled={disabled}
            >
              {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <FileUp className="size-3.5" aria-hidden />}
              {pending ? 'Submitting…' : 'Submit evidence'}
            </Button>
            <div className="flex items-center gap-1.5">
              <Input
                value={skipReason}
                onChange={(e) => onSkipReason(e.target.value)}
                placeholder="skip reason (required)"
                className="h-7 w-44 text-[11.5px]"
                aria-label={`Reason for skipping step ${step.step}: ${step.label}`}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11.5px]"
                onClick={onSkip}
                disabled={disabled || skipPending || !skipReason.trim()}
                title="Skips are recorded with the reason and disclosed at review"
              >
                {skipPending ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <ShieldCheck className="size-3" aria-hidden />}
                Skip
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </li>
  );
}
