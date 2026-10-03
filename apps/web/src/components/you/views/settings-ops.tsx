'use client';
// ═══════════════════════════════════════════════════════════════════════════
// YOU Studio — operator maintenance surface (Worker B lane, P6.B8).
//
// The UX layer over the P6.A6-FULL resilience backend, wired to the EXISTING
// routes (no new API surface):
//   GET/POST /api/v1/maintenance/dead-jobs  — dead-letter list + replay/purge
//   GET      /api/v1/metrics               — breaker states + dead-job summary
//
// OPERATOR-GATED per backend behavior: both routes refuse API keys and require
// an operator session (actorType 'user'). This surface never retries a 403 —
// it renders the honest "operator session required" notice instead.
//
// Honesty laws (same as every P6.B8 surface):
//  - dead jobs render the STRUCTURED dead-letter payload (attempts / stoppedBy
//    / last error verbatim) — never a raw JSON dump, never a generic failure;
//  - purge is explicit (AlertDialog), states exactly what it deletes (dead
//    jobs past the retention cutoff) and what it cannot touch;
//  - breaker cards show state + remaining cooldown as an ETA, labeled as the
//    backend's estimate — and the process-local scope is stated, not hidden;
//  - empty states say what empty MEANS ("nothing exhausted its retry budget").
// ═══════════════════════════════════════════════════════════════════════════
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  Activity, Ban, CircleCheck, Gauge, Inbox, Loader2, RefreshCcw, RotateCcw, RotateCw, Skull, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, uid, type BreakerStatusView, type DeadJobsView } from '@/lib/you/client/api';
import { formatRetrySeconds } from '@/lib/you/client/degraded';
import { classifyApiError } from '@/lib/you/client/error-taxonomy';
import { EmptyState, IdChip, KeyValue, SectionCard, StatusBadge } from '@/components/you/shared/primitives';
import { timeAgo } from '@/components/you/build/format';

/** Honest notice when the operator-gated routes refuse this session (403). */
function OperatorGateNotice({ detail }: { detail: string }) {
  return (
    <div role="alert" className="space-y-1.5 rounded-lg border border-amber-500/25 bg-amber-500/[0.05] px-4 py-3.5">
      <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
        <Ban className="size-4 shrink-0" aria-hidden />
        Operator session required
      </div>
      <p className="text-xs text-muted-foreground">
        {detail} These maintenance surfaces are restricted to operator sessions — API keys are refused by the backend.
        Nothing was retried.
      </p>
    </div>
  );
}

/** Shared error render for the two operator queries (403 → gate; else taxonomy). */
function OpsQueryError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const c = classifyApiError(error);
  if (c.kind === 'auth') return <OperatorGateNotice detail={c.detail} />;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-500/25 bg-red-500/[0.06] px-4 py-3.5 text-xs text-red-700 dark:text-red-400"
    >
      <span className="min-w-0">{c.title} — {c.detail}</span>
      {onRetry ? (
        <Button size="sm" variant="outline" className="gap-1.5" onClick={onRetry}>
          <RotateCw className="size-3.5" aria-hidden /> Retry
        </Button>
      ) : null}
    </div>
  );
}

// ─── dead-letter queue ───────────────────────────────────────────────────────

function DeadJobRow({
  job, onReplay, replaying,
}: {
  job: DeadJobsView['jobs'][number];
  onReplay: () => void;
  replaying: boolean;
}) {
  const dl = job.deadLetter;
  return (
    <li className="space-y-2.5 rounded-lg border border-red-500/25 bg-red-500/[0.04] px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <Skull className="size-4 shrink-0 text-red-600 dark:text-red-400" aria-hidden />
        <span className="text-sm font-medium">{job.kind}</span>
        <StatusBadge status={job.status} />
        <IdChip id={job.id} label="job" />
        <span className="ml-auto text-[11px] text-muted-foreground">
          died <span className="you-num">{timeAgo(job.finishedAt)}</span>
        </span>
      </div>
      {dl ? (
        <KeyValue
          items={[
            { label: 'Attempts', value: <span className="you-num font-mono text-xs">{dl.attempts}</span> },
            { label: 'Stopped by', value: <span className="font-mono text-xs">{dl.stoppedBy}</span> },
            { label: 'First attempt', value: <span className="you-num text-xs">{timeAgo(dl.firstAttemptAt)}</span> },
            { label: 'Last failure', value: <span className="you-num text-xs">{timeAgo(dl.lastErrorAt)}</span> },
          ]}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          No structured dead-letter payload was recorded for this job (its error text was not a dead-letter record).
        </p>
      )}
      <p className="break-words rounded-md bg-muted/50 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        {dl?.lastError ?? 'no last error recorded'}
      </p>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          Replaying re-queues the same job (dead → queued) and preserves the dead-letter record in the audit trail.
        </p>
        <Button
          size="sm" variant="outline" className="h-7 shrink-0 gap-1.5"
          onClick={onReplay}
          disabled={replaying}
          aria-label={`Replay dead job ${job.id}`}
        >
          <RotateCcw className={cn('size-3.5', replaying && 'animate-spin')} aria-hidden />
          {replaying ? 'Replaying…' : 'Replay'}
        </Button>
      </div>
    </li>
  );
}

function DeadJobsCard() {
  const qc = useQueryClient();
  const deadQ = useQuery({
    queryKey: ['ops', 'dead-jobs'],
    queryFn: () => api.maintenance.deadJobs(),
  });
  const [replayingId, setReplayingId] = useState<string | null>(null);

  const replay = useMutation({
    mutationFn: (jobId: string) => api.maintenance.replayDeadJob(jobId, uid()),
    onMutate: (jobId) => setReplayingId(jobId),
    onSuccess: (res) => {
      toast.success(`Dead job ${res.jobId.slice(0, 8)} re-queued`, {
        description: 'It is running again — watch its steps on the surface that started it.',
      });
      void qc.invalidateQueries({ queryKey: ['ops'] });
    },
    onError: (err) => {
      const c = classifyApiError(err);
      toast.error(c.title, { description: c.detail });
    },
    onSettled: () => setReplayingId(null),
  });

  const purge = useMutation({
    mutationFn: () => api.maintenance.purgeDeadJobs(uid()),
    onSuccess: (res) => {
      toast.success(
        res.purged === 0
          ? 'Nothing to purge — no dead job is past the retention cutoff'
          : `Purged ${res.purged} dead job${res.purged === 1 ? '' : 's'}`,
        { description: `Retention is ${res.retentionDays} days from finishedAt; cutoff ${res.cutoff.slice(0, 10)}.` },
      );
      void qc.invalidateQueries({ queryKey: ['ops'] });
    },
    onError: (err) => {
      const c = classifyApiError(err);
      toast.error(c.title, { description: c.detail });
    },
  });

  return (
    <SectionCard
      title="Dead-letter queue"
      description="Durable jobs whose bounded retry budget was exhausted (terminal `dead`)"
      icon={Skull}
      actions={
        <>
          <Button
            size="sm" variant="ghost" className="h-7 gap-1.5"
            onClick={() => deadQ.refetch()}
            disabled={deadQ.isFetching}
            aria-label="Refresh dead-letter queue"
          >
            <RefreshCcw className={cn('size-3.5', deadQ.isFetching && 'animate-spin')} aria-hidden />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="sm" variant="outline" className="h-7 gap-1.5"
                disabled={purge.isPending || deadQ.isPending}
                aria-label="Purge dead jobs past retention"
              >
                <Trash2 className="size-3.5" aria-hidden />
                <span className="hidden sm:inline">Purge past retention</span>
                <span className="sm:hidden">Purge</span>
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Purge dead jobs past retention?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently deletes dead jobs whose finishedAt is older than the{' '}
                  {deadQ.data?.retentionDays ?? 30}-day retention window. Jobs still inside the window, live jobs, and
                  the audit trail (job.dead events, replay records) are not touched. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => { e.preventDefault(); purge.mutate(); }}
                  className="gap-1.5"
                >
                  {purge.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                  Purge past-retention only
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      }
    >
      {deadQ.isPending ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : deadQ.isError ? (
        <OpsQueryError error={deadQ.error} onRetry={() => void deadQ.refetch()} />
      ) : deadQ.data && deadQ.data.jobs.length > 0 ? (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            <span className="you-num font-medium text-foreground">{deadQ.data.count}</span> dead job
            {deadQ.data.count === 1 ? '' : 's'} · retention {deadQ.data.retentionDays} days · replay re-queues, never deletes
          </p>
          <ul className="space-y-3" aria-label="Dead jobs">
            {deadQ.data.jobs.map((j) => (
              <DeadJobRow
                key={j.id}
                job={j}
                onReplay={() => replay.mutate(j.id)}
                replaying={replayingId === j.id && replay.isPending}
              />
            ))}
          </ul>
        </div>
      ) : (
        <EmptyState
          icon={Inbox}
          title="No dead jobs"
          hint="Nothing has exhausted its bounded retry budget — the dead-letter queue is empty for this tenant."
        />
      )}
    </SectionCard>
  );
}

// ─── provider breakers (metrics) ─────────────────────────────────────────────

function BreakerCard({ provider, b }: { provider: string; b: BreakerStatusView }) {
  const open = b.state === 'open';
  return (
    <div className="space-y-2.5 rounded-lg border px-4 py-3.5" data-you-breaker={provider}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-medium">{provider}</span>
        <StatusBadge status={b.state} />
        {open && b.retryAfterMs > 0 ? (
          <Badge variant="outline" className="font-mono text-[10px] text-amber-700 dark:text-amber-400">
            cooldown ~{formatRetrySeconds(Math.ceil(b.retryAfterMs / 1000))}
          </Badge>
        ) : null}
      </div>
      <KeyValue
        items={[
          { label: 'Failures in window', value: <span className="you-num font-mono text-xs">{b.failuresInWindow}/{b.failureThreshold}</span> },
          { label: 'Total', value: <span className="you-num font-mono text-xs">{b.successCount} ok · {b.failureCount} failed</span> },
          { label: 'Opened', value: <span className="you-num text-xs">{timeAgo(b.openedAt)}</span> },
        ]}
      />
      {open ? (
        b.retryAfterMs > 0 ? (
          <p className="text-xs text-muted-foreground" role="status">
            Provider cooling down — new work is refused fast (503) for roughly{' '}
            <span className="you-num font-medium text-foreground">{formatRetrySeconds(Math.ceil(b.retryAfterMs / 1000))}</span>
            {b.openedReason ? <> (opened reason: {b.openedReason})</> : null}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground" role="status">
            Cooldown elapsed — the next request is a half-open probe. One success closes the breaker; one failure re-opens it.
          </p>
        )
      ) : null}
      {b.lastError ? (
        <p className="break-words rounded-md bg-muted/50 px-3 py-2 font-mono text-[11px] text-muted-foreground">
          {b.lastError}
        </p>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CircleCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
          No recorded failure.
        </p>
      )}
    </div>
  );
}

function BreakersCard() {
  const metricsQ = useQuery({
    queryKey: ['ops', 'metrics'],
    queryFn: () => api.metrics(),
  });
  const providers = metricsQ.data ? Object.entries(metricsQ.data.breakers) : [];
  return (
    <SectionCard
      title="Provider circuit breakers"
      description="Per-provider breaker state with cooldown estimates (P6.A6-FULL)"
      icon={Gauge}
      actions={
        <Button
          size="sm" variant="ghost" className="h-7 gap-1.5"
          onClick={() => metricsQ.refetch()}
          disabled={metricsQ.isFetching}
          aria-label="Refresh provider breakers"
        >
          <RefreshCcw className={cn('size-3.5', metricsQ.isFetching && 'animate-spin')} aria-hidden />
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      }
    >
      {metricsQ.isPending ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : metricsQ.isError ? (
        <OpsQueryError error={metricsQ.error} onRetry={() => void metricsQ.refetch()} />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            {providers.length > 0 ? providers.map(([p, b]) => (
              <BreakerCard key={p} provider={p} b={b} />
            )) : (
              <p className="text-xs text-muted-foreground">
                No breaker has been exercised yet — every provider call so far went through the closed breaker.
              </p>
            )}
          </div>
          {metricsQ.data ? (
            <div className="space-y-1.5 border-t pt-3">
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Activity className="size-3.5" aria-hidden />
                Breakers and counters are process-local (single instance): {metricsQ.data.scope.countersAndBreakers}
              </p>
              <p className="text-[11px] text-muted-foreground">
                Dead jobs (database truth): <span className="you-num font-medium text-foreground">{metricsQ.data.deadJobs.count}</span>
                {metricsQ.data.deadJobs.oldest
                  ? <> · oldest <span className="you-num">{timeAgo(metricsQ.data.deadJobs.oldest.finishedAt)}</span> ({metricsQ.data.deadJobs.oldest.kind})</>
                  : null}
                {' '}· retention {metricsQ.data.deadJobs.retentionDays} days
              </p>
            </div>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}

// ─── the section ─────────────────────────────────────────────────────────────

/**
 * Operator maintenance section for the Settings view (P6.B8). Both cards ride
 * the existing operator-gated routes; a non-operator session gets the honest
 * gate notice, never a silent failure.
 */
export function SettingsOps() {
  return (
    <div className="space-y-4" aria-label="Operator maintenance">
      <DeadJobsCard />
      <BreakersCard />
    </div>
  );
}
