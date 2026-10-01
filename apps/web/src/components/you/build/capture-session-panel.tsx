'use client';
// Capture session panel — the full working surface for one capture session:
// checklist, uploads, immutable evidence grid, and the "Analyze & complete"
// quality job (steps are exactly what the backend reports).
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { IdChip, StatusBadge } from '@/components/you/shared/primitives';
import { useJob } from '@/hooks/you/use-job';
import { api, uid } from '@/lib/you/client/api';
import type { CaptureSessionView } from '@/lib/you/contracts';
import { CircleCheck, Loader2, ScanSearch, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { EvidenceGrid } from './evidence-grid';
import { ChecklistItemRow, UploadControl } from './capture-uploader';
import { JobStepsPanel } from './job-panel';
import { timeAgo } from './format';

const TERMINAL: CaptureSessionView['status'][] = ['complete', 'failed'];

export function CaptureSessionPanel({
  twinId, session: initial, onConsentRequired,
}: {
  twinId: string;
  session: CaptureSessionView;
  onConsentRequired: (hint: string) => void;
}) {
  const [jobId, setJobId] = useState<string | null>(null);

  // Poll the session while it is in a non-terminal state.
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
  const terminal = TERMINAL.includes(session.status);

  const complete = useMutation({
    mutationFn: () => api.captures.complete(session.id, uid()),
    onSuccess: ({ jobId: jid }) => setJobId(jid),
    onError: (err) => {
      toast.error('Could not start analysis', { description: err instanceof Error ? err.message : 'Unexpected error' });
    },
  });

  const { job } = useJob(jobId);

  const assets = session.assets ?? [];
  const provided = session.checklist?.filter((i) => i.status === 'provided').length ?? 0;
  const pendingItems = session.checklist?.filter((i) => i.status === 'pending') ?? [];

  return (
    <div className="space-y-4 rounded-xl border bg-card shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3.5">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">Capture session</h3>
            <StatusBadge status={session.status} />
            <IdChip id={session.id} label="" />
          </div>
          <p className="text-xs text-muted-foreground">
            <span className="you-num">{timeAgo(session.createdAt)}</span>
            {session.instructions ? <span> · {session.instructions}</span> : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="you-num text-xs text-muted-foreground">
            checklist {provided}/{session.checklist?.length ?? 0} · {assets.length} assets
          </span>
          {!terminal ? (
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => complete.mutate()}
              disabled={complete.isPending || assets.length === 0 || session.status === 'analyzing'}
              title={assets.length === 0 ? 'Upload at least one evidence asset first' : 'Run quality analysis and complete the session'}
            >
              {complete.isPending || session.status === 'analyzing'
                ? <Loader2 className="size-3.5 animate-spin" aria-hidden />
                : <ScanSearch className="size-3.5" aria-hidden />}
              Analyze &amp; complete
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

        {jobId ? (
          <div className="rounded-lg border bg-muted/25 p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <ScanSearch className="size-3.5" aria-hidden /> Quality analysis
              </span>
              {job?.status === 'succeeded' ? (
                <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setJobId(null)}>Dismiss</Button>
              ) : null}
            </div>
            <JobStepsPanel job={job} dense />
            {job?.status === 'succeeded' ? (
              <p className="mt-3 flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
                <CircleCheck className="size-3.5" aria-hidden /> Analysis complete — per-asset quality and surfaced deficiencies are now visible.
              </p>
            ) : null}
          </div>
        ) : null}

        <section aria-label="Capture checklist">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Checklist {session.checklist?.length ? `(${session.checklist.length} items)` : ''}
          </h4>
          {session.checklist?.length ? (
            <ul className="space-y-2">
              {session.checklist.map((item, i) => (
                <ChecklistItemRow
                  key={`${item.item}-${i}`}
                  item={item}
                  sessionId={session.id}
                  twinId={twinId}
                  onConsentRequired={onConsentRequired}
                  disabled={terminal}
                />
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No checklist items were generated for this session.</p>
          )}
        </section>

        {!terminal && (pendingItems.length > 0 || assets.length > 0) ? (
          <section aria-label="Additional upload">
            <UploadControl sessionId={session.id} twinId={twinId} free onConsentRequired={onConsentRequired} />
          </section>
        ) : null}

        <section aria-label="Uploaded evidence">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Evidence assets ({assets.length})
          </h4>
          <EvidenceGrid
            assets={assets}
            emptyHint={terminal
              ? 'No evidence assets were uploaded to this session.'
              : 'No evidence yet — attach files to the checklist items above (or use a free upload).'}
          />
        </section>

        {terminal && session.status === 'complete' ? (
          <p className="text-[11px] text-muted-foreground">
            Completed <span className="you-num">{timeAgo(session.completedAt)}</span>. Evidence is immutable —
            further improvement flows through a new session or a targeted evidence request.
          </p>
        ) : null}
      </div>
    </div>
  );
}
