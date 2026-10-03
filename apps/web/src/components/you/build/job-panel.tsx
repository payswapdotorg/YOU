'use client';
// Real job step display — renders only what the backend reports (ADR-0005:
// no fabricated progress). Used by compile + capture-complete flows.
// P6.B8: terminal states render honestly — `dead` shows the structured
// dead-letter explanation (retry budget exhausted + maintenance pointer);
// `failed` shows the last error verbatim. No spin-forever, no raw JSON.
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/you/shared/primitives';
import { JobTerminalState } from '@/components/you/shared/degraded-state';
import { Check, Circle, CircleAlert, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { JobStep, JobView } from '@/lib/you/contracts';
import { isTerminalJobStatus } from '@/lib/you/client/degraded';

const KIND_LABELS: Record<string, string> = {
  'capture.quality': 'Evidence quality analysis',
  'twin.compile': 'Twin reconstruction',
  'render.image': 'Image render',
  'render.video': 'Video render',
  'performance.fromText': 'Performance synthesis',
  'lab.benchmark': 'Lab benchmark',
};

function StepIcon({ status }: { status: JobStep['status'] }) {
  switch (status) {
    case 'done':
      return <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />;
    case 'running':
      return <Loader2 className="size-3.5 shrink-0 animate-spin text-amber-600 dark:text-amber-400" aria-hidden />;
    case 'failed':
      return <CircleAlert className="size-3.5 shrink-0 text-red-500" aria-hidden />;
    default:
      return <Circle className="size-3.5 shrink-0 text-muted-foreground/40" aria-hidden />;
  }
}

export function JobStepsPanel({ job, dense = false }: { job: JobView | null; dense?: boolean }) {
  if (!job) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-2 w-full" />
      </div>
    );
  }
  const progress = Math.round(Math.max(0, Math.min(1, job.progress)) * 100);
  const kindLabel = KIND_LABELS[job.kind] ?? job.kind;
  return (
    <div className="space-y-3" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          {kindLabel}
        </div>
        <StatusBadge status={job.status} />
      </div>
      {/* Progress ONLY while the job is live — a terminal job is not progressing */}
      {!isTerminalJobStatus(job.status) ? (
        <Progress value={progress} className="h-1.5" aria-label={`${progress}% complete`} />
      ) : null}
      <ol className={cn('space-y-1.5', dense && 'space-y-1')}>
        {job.steps.map((step) => (
          <li key={step.key} className="flex items-start gap-2 text-[13px]">
            <span className="mt-0.5"><StepIcon status={step.status} /></span>
            <span className={cn(
              'min-w-0',
              step.status === 'pending' && 'text-muted-foreground/80',
              step.status === 'done' && 'text-muted-foreground',
              step.status === 'running' && 'font-medium',
            )}>
              <span className="block">{step.label}</span>
              {step.detail ? <span className="block break-words font-mono text-[11px] text-muted-foreground">{step.detail}</span> : null}
            </span>
          </li>
        ))}
        {job.steps.length === 0 ? <li className="text-xs text-muted-foreground">Waiting for the backend to report steps…</li> : null}
      </ol>
      {isTerminalJobStatus(job.status) ? (
        <JobTerminalState job={job} kindLabel={kindLabel} />
      ) : job.error ? (
        <p role="alert" className="rounded-md border border-red-500/25 bg-red-500/[0.06] px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {job.error}
        </p>
      ) : null}
    </div>
  );
}
