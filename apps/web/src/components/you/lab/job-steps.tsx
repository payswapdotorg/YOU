'use client';
// Honest job step renderer — shows ONLY steps the backend reports.
// Progress bar reflects job.progress (real completion signals only).
// P6.B8: terminal states render honestly — `dead` shows the structured
// dead-letter explanation; progress is hidden once terminal (a terminal job
// is not progressing). No spin-forever, no raw JSON dumps.
import type { JobView } from '@/lib/you/contracts';
import { Progress } from '@/components/ui/progress';
import { StatusBadge } from '@/components/you/shared/primitives';
import { JobTerminalState } from '@/components/you/shared/degraded-state';
import { isTerminalJobStatus } from '@/lib/you/client/degraded';
import { Check, CircleDot, Loader2, Circle } from 'lucide-react';
import { cn } from '@/lib/utils';

export function JobSteps({ job, compact = false }: { job: JobView | null; compact?: boolean }) {
  if (!job) {
    return (
      <div className="space-y-2">
        <div className="h-4 w-40 you-shimmer rounded bg-muted" />
        <div className="h-16 w-full you-shimmer rounded bg-muted" />
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-muted-foreground">{job.kind}</span>
          <StatusBadge status={job.status} />
        </div>
        <span className="you-num font-mono text-[11px] text-muted-foreground">
          {Math.round((job.progress ?? 0) * 100)}%
        </span>
      </div>
      {/* Progress ONLY while live — terminal jobs are not progressing */}
      {!isTerminalJobStatus(job.status) ? (
        <Progress value={Math.round((job.progress ?? 0) * 100)} className="h-1.5" />
      ) : null}
      {isTerminalJobStatus(job.status) ? (
        <JobTerminalState job={job} kindLabel={job.kind} />
      ) : job.error ? (
        <p className="rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">
          {job.error}
        </p>
      ) : null}
      {job.steps.length ? (
        <ol className={cn('space-y-1.5', compact && 'space-y-1')}>
          {job.steps.map((step) => (
            <li key={step.key} className="flex items-start gap-2 text-xs">
              <span className="mt-0.5 shrink-0" aria-hidden>
                {step.status === 'done' ? (
                  <Check className="size-3.5 text-emerald-600" />
                ) : step.status === 'running' ? (
                  <Loader2 className="size-3.5 animate-spin text-amber-600" />
                ) : step.status === 'failed' ? (
                  <CircleDot className="size-3.5 text-red-600" />
                ) : (
                  <Circle className="size-3.5 text-muted-foreground/40" />
                )}
              </span>
              <span
                className={cn(
                  'min-w-0',
                  step.status === 'done' ? 'text-foreground' : step.status === 'pending' ? 'text-muted-foreground/60' : 'text-foreground',
                )}
              >
                {step.label}
                {step.detail ? (
                  <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">{step.detail}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-xs text-muted-foreground">
          No step detail reported yet — steps appear as the backend reports real progress.
        </p>
      )}
    </div>
  );
}
