'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Performances — first-class performance streams, independent from identity
// (ARCHITECTURE §6). Create from text (job-polled), visualize tracks.
// ═══════════════════════════════════════════════════════════════════════════
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { Drama, Loader2, Plus, RefreshCcw, ScrollText, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { api, uid, YouApiError } from '@/lib/you/client/api';
import { describeApiError } from '@/lib/you/client/error-taxonomy';
import type { PerformanceView, TwinView } from '@/lib/you/contracts';
import { useJob } from '@/hooks/you/use-job';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { IdChip, PageHeader, SectionCard, StatusBadge, EmptyState } from '@/components/you/shared/primitives';
import { ApiErrorSurface, useApiErrorSurface } from '@/components/you/shared/degraded-state';
import { JobSteps } from '@/components/you/lab/job-steps';
import { TrackTimeline, fmtMs } from '@/components/you/artifact/track-timeline';

const ORIGIN_BADGES: Record<string, string> = {
  text: 'bg-violet-500/12 text-violet-700 dark:text-violet-400 border-violet-500/25',
  audio: 'bg-amber-500/12 text-amber-700 dark:text-amber-400 border-amber-500/25',
  video: 'bg-rose-500/12 text-rose-700 dark:text-rose-400 border-rose-500/25',
  motion: 'bg-orange-500/12 text-orange-700 dark:text-orange-400 border-orange-500/25',
  generated: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 border-emerald-500/25',
  interaction: 'bg-zinc-500/12 text-zinc-600 dark:text-zinc-400 border-zinc-500/25',
};

function rel(iso?: string | null): string {
  if (!iso) return '—';
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }); } catch { return iso; }
}

function ErrorNote({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const msg = error instanceof YouApiError ? error.message : 'Request failed';
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-xs text-red-700 dark:text-red-400">
      <span>Couldn’t load performances — {msg}</span>
      <Button size="sm" variant="outline" onClick={onRetry} className="h-7">Retry</Button>
    </div>
  );
}

function PerformanceDetailDialog({
  performanceId,
  onClose,
}: {
  performanceId: string | null;
  onClose: () => void;
}) {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['performance', performanceId],
    queryFn: () => api.performances.get(performanceId as string),
    enabled: !!performanceId,
  });

  return (
    <Dialog open={!!performanceId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] you-scroll overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-6">
            <Drama className="size-4 text-muted-foreground" aria-hidden />
            {data?.name ?? 'Performance'}
          </DialogTitle>
          <DialogDescription>
            Track visualizer — frames colored by performance state.
          </DialogDescription>
        </DialogHeader>
        {isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-5/6" />
          </div>
        ) : isError ? (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-xs text-red-700 dark:text-red-400">
            <span>Couldn’t load performance — {error instanceof YouApiError ? error.message : 'request failed'}</span>
            <Button size="sm" variant="outline" className="h-7" onClick={() => refetch()}>Retry</Button>
          </div>
        ) : data ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={ORIGIN_BADGES[data.origin] ?? ''}>{data.origin}</Badge>
              <span className="you-num font-mono text-[11px] text-muted-foreground">
                {fmtMs(data.durationMs)} · {data.tracks.length} tracks
              </span>
              <IdChip id={data.id} label="perf" />
            </div>
            <TrackTimeline tracks={data.tracks} durationMs={data.durationMs} />
            {data.script ? (
              <div>
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <ScrollText className="size-3.5" aria-hidden /> Script
                </div>
                <pre className="you-scroll max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
                  {data.script}
                </pre>
              </div>
            ) : null}
            <p className="text-[11px] text-muted-foreground">Created {rel(data.createdAt)}</p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function PerformancesView() {
  const [name, setName] = useState('');
  const [script, setScript] = useState('');
  const [twinId, setTwinId] = useState<string>('none');
  const [jobId, setJobId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // P6.B8: typed error surface for honest refusals (503 provider/service
  // unavailable, 429 rate-limited) — inline retry guidance, not a bare toast
  const createErrors = useApiErrorSurface('Performance creation');

  const performances = useQuery({ queryKey: ['performances'], queryFn: () => api.performances.list() });
  const twins = useQuery({ queryKey: ['twins'], queryFn: () => api.twins.list() });
  const { job, done, succeeded } = useJob(jobId);

  const twinName = (id?: string | null) =>
    id ? (twins.data?.find((t: TwinView) => t.id === id)?.displayName ?? null) : null;

  const createFromText = useMutation({
    mutationFn: () =>
      api.performances.fromText(
        { name: name.trim(), script, ...(twinId !== 'none' ? { twinId } : {}) },
        uid(),
      ),
    onSuccess: (res) => {
      createErrors.clear();
      setJobId(res.jobId);
      toast.success('Performance job started — compiling tracks from script');
    },
    onError: (err) => {
      // P6.B8: typed provider/service-unavailable or rate-limited refusals
      // render the honest inline surface instead of a bare toast
      if (createErrors.capture(err)) return;
      const msg = err instanceof YouApiError ? describeApiError(err) : 'request failed';
      toast.error(`Create failed — ${msg}`);
    },
  });

  const canSubmit = name.trim().length > 0 && script.trim().length > 0 && !createFromText.isPending;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Build"
        title="Performances"
        description="Performance streams are first-class and identity-independent — a performance can originate from text, audio, video, motion or live interaction, then drive any twin (ARCHITECTURE §6)."
        actions={
          <Button
            variant="outline" size="sm" className="gap-1.5"
            onClick={() => performances.refetch()}
            disabled={performances.isRefetching}
          >
            <RefreshCcw className={performances.isRefetching ? 'size-3.5 animate-spin' : 'size-3.5'} aria-hidden />
            Refresh
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
        {/* Create from text */}
        <div className="space-y-4">
          <SectionCard title="Create from text" description="Dialog text → performance state tracks" icon={Sparkles}>
            <div className="space-y-3.5">
              <div className="space-y-1.5">
                <Label htmlFor="perf-name" className="text-xs">Name</Label>
                <Input
                  id="perf-name" value={name} onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Greeting monologue" className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Attach twin (optional)</Label>
                <Select value={twinId} onValueChange={setTwinId}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No twin — identity-independent</SelectItem>
                    {twins.data?.map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.displayName}</SelectItem>
                    )) ?? null}
                  </SelectContent>
                </Select>
                {twins.isError ? (
                  <p className="text-[11px] text-muted-foreground">Twin list unavailable — performance can still be created without one.</p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="perf-script" className="text-xs">Script</Label>
                <Textarea
                  id="perf-script" value={script} onChange={(e) => setScript(e.target.value)}
                  placeholder={'Line by line — the compiler derives listening / thinking / speaking states…'}
                  className="min-h-28 font-mono text-xs"
                />
              </div>
              <Button
                className="w-full gap-1.5" disabled={!canSubmit}
                onClick={() => createFromText.mutate()}
              >
                {createFromText.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
                Create performance
              </Button>
            </div>
          </SectionCard>

          <ApiErrorSurface
            surface={createErrors}
            onRetry={() => createFromText.mutate()}
            retrying={createFromText.isPending}
          />

          {jobId ? (
            <SectionCard
              title="Compilation job"
              description={done ? undefined : 'Polling the durable job — steps shown are real backend signals only.'}
            >
              <JobSteps job={job} compact />
              {done && succeeded ? (
                <p className="mt-3 text-xs text-emerald-700 dark:text-emerald-400">
                  Performance created — it appears in the list.
                </p>
              ) : null}
              {done && !succeeded ? (
                <p className="mt-3 text-xs text-red-700 dark:text-red-400">Job finished unsuccessfully — see the error above.</p>
              ) : null}
            </SectionCard>
          ) : null}
        </div>

        {/* List */}
        <SectionCard
          title="Performances"
          description={`${performances.data?.length ?? 0} recorded`}
          icon={Drama}
        >
          {performances.isPending ? (
            <div className="space-y-2.5">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : performances.isError ? (
            <ErrorNote error={performances.error} onRetry={() => performances.refetch()} />
          ) : !performances.data?.length ? (
            <EmptyState
              icon={Drama}
              title="No performances yet"
              hint="A Performance is a control stream — pose, expression, gaze, speech, timing — independent of any identity. Create one from text on the left; no twin is required."
            />
          ) : (
            <div className="max-h-[560px] you-scroll overflow-y-auto rounded-lg border">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Origin</TableHead>
                    <TableHead>Twin</TableHead>
                    <TableHead className="text-right">Duration</TableHead>
                    <TableHead className="text-right">Tracks</TableHead>
                    <TableHead className="text-right">Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {performances.data.map((p: PerformanceView) => (
                    <TableRow
                      key={p.id}
                      className="cursor-pointer"
                      onClick={() => setSelected(p.id)}
                    >
                      <TableCell className="max-w-44 truncate font-medium">{p.name}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={ORIGIN_BADGES[p.origin] ?? ''}>{p.origin}</Badge>
                      </TableCell>
                      <TableCell className="max-w-32 truncate text-xs text-muted-foreground">
                        {twinName(p.twinId) ?? (p.twinId ? <IdChip id={p.twinId} label="twin" /> : '—')}
                      </TableCell>
                      <TableCell className="you-num text-right font-mono text-xs">{fmtMs(p.durationMs)}</TableCell>
                      <TableCell className="you-num text-right font-mono text-xs">{p.tracks.length}</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">{rel(p.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </SectionCard>
      </div>

      <PerformanceDetailDialog performanceId={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
export default PerformancesView;
