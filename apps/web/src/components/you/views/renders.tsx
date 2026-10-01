'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Renders — create image/video render jobs over a TwinVersion (optionally
// driven by a Performance), poll the durable job, preview artifacts and jump
// to the render-review Solution Artifact when the job emits one.
// ═══════════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { ImageIcon, Loader2, Plus, RefreshCcw, Video, Wand2, FileBox } from 'lucide-react';
import { toast } from 'sonner';
import { api, uid, YouApiError } from '@/lib/you/client/api';
import type { RenderJobView, RenderStyle, TwinView, TwinVersionView } from '@/lib/you/contracts';
import { useJob } from '@/hooks/you/use-job';
import { useYouStore } from '@/hooks/you/use-you-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { EmptyState, IdChip, KeyValue, PageHeader, SectionCard, StatusBadge } from '@/components/you/shared/primitives';
import { JobSteps } from '@/components/you/lab/job-steps';

const STYLES: RenderStyle[] = [
  'photorealistic', 'anime', 'cartoon', 'low-poly', 'game', 'illustration', 'stylized-portrait',
];

const ADAPTERS: Record<'image' | 'video', { value: string; label: string }[]> = {
  image: [
    { value: 'svg-portrait-1', label: 'svg-portrait-1 · deterministic' },
    { value: 'ai-image-1', label: 'ai-image-1 · provider' },
  ],
  video: [{ value: 'ai-video-1', label: 'ai-video-1 · provider' }],
};

function rel(iso?: string | null): string {
  if (!iso) return '—';
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }); } catch { return iso; }
}

/** Defensively pull a SolutionArtifact id out of a job output (shape lands with Worker C). */
function artifactIdFromOutput(output: Record<string, unknown> | null | undefined): string | null {
  if (!output) return null;
  const direct = output.solutionArtifactId ?? output.artifactId ?? (output.solutionArtifact as { id?: string } | undefined)?.id;
  if (typeof direct === 'string' && direct) return direct;
  const entities = output.entities;
  if (Array.isArray(entities)) {
    for (const e of entities) {
      if (e && typeof e === 'object' && /solution.?artifact/i.test(String((e as { type?: string }).type ?? ''))) {
        const id = (e as { id?: string }).id;
        if (typeof id === 'string' && id) return id;
      }
    }
  }
  return null;
}

function fmtUsd(v?: number | null) {
  return typeof v === 'number' ? `$${v.toFixed(4)}` : '—';
}

// ─── New render dialog ───────────────────────────────────────────────────────
function NewRenderDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [twinId, setTwinId] = useState<string>('');
  const [versionId, setVersionId] = useState<string>('');
  const [kind, setKind] = useState<'image' | 'video'>('image');
  const [style, setStyle] = useState<RenderStyle>('photorealistic');
  const [adapter, setAdapter] = useState<string>('auto');
  const [performanceId, setPerformanceId] = useState<string>('none');

  const twins = useQuery({ queryKey: ['twins'], queryFn: () => api.twins.list(), enabled: open });
  const versions = useQuery({
    queryKey: ['twin-versions', twinId],
    queryFn: () => api.twins.versions(twinId),
    enabled: open && !!twinId,
  });
  const performances = useQuery({
    queryKey: ['performances'],
    queryFn: () => api.performances.list(),
    enabled: open && kind === 'video',
  });

  // derive the effective selection from loaded data (no effect needed)
  const sortedVersions = versions.data ? [...versions.data].sort((a, b) => b.version - a.version) : [];
  const effectiveVersionId =
    sortedVersions.some((v) => v.id === versionId) ? versionId : (sortedVersions[0]?.id ?? '');

  const onKindChange = (v: string) => {
    setKind(v as 'image' | 'video');
    setAdapter('auto');
    setPerformanceId('none');
  };

  const create = useMutation({
    mutationFn: () => {
      const version = versions.data?.find((v: TwinVersionView) => v.id === effectiveVersionId);
      if (!version) throw new Error('Select a twin version first');
      return api.renders.create(
        {
          twinId,
          twinVersionId: effectiveVersionId,
          kind,
          style,
          ...(adapter !== 'auto' ? { adapter: adapter as 'svg-portrait-1' | 'ai-image-1' | 'ai-video-1' } : {}),
          ...(kind === 'video' && performanceId !== 'none' ? { performanceId } : {}),
        },
        uid(),
      );
    },
    onSuccess: (res) => {
      onOpenChange(false);
      toast.success(`Render job ${res.jobId.slice(0, 8)} started`);
      window.dispatchEvent(new CustomEvent('you:render-job', { detail: res.jobId }));
    },
    onError: (err) => {
      const msg = err instanceof YouApiError ? err.message : (err instanceof Error ? err.message : 'request failed');
      toast.error(`Render failed — ${msg}`);
    },
  });

  const canSubmit = !!twinId && !!effectiveVersionId && !create.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="you-scroll max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="size-4 text-muted-foreground" aria-hidden /> New render
          </DialogTitle>
          <DialogDescription>
            Compiles the TwinVersion through a render pipeline. Style is a compiler target — identity semantics stay separate (ARCHITECTURE §7).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3.5">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Twin</Label>
              <Select value={twinId || undefined} onValueChange={(v) => { setTwinId(v); setVersionId(''); }}>
                <SelectTrigger className="h-9"><SelectValue placeholder={twins.isPending ? 'Loading…' : 'Select twin'} /></SelectTrigger>
                <SelectContent>
                  {twins.data?.map((t: TwinView) => (
                    <SelectItem key={t.id} value={t.id}>{t.displayName}</SelectItem>
                  )) ?? null}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Twin version</Label>
              <Select value={effectiveVersionId || undefined} onValueChange={setVersionId} disabled={!twinId}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder={!twinId ? 'Pick a twin first' : versions.isPending ? 'Loading…' : 'Select version'} />
                </SelectTrigger>
                <SelectContent>
                  {versions.data?.map((v: TwinVersionView) => (
                    <SelectItem key={v.id} value={v.id}>
                      v{v.version} · {v.status}
                    </SelectItem>
                  )) ?? null}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Kind</Label>
              <Select value={kind} onValueChange={onKindChange}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="image">Image</SelectItem>
                  <SelectItem value="video">Video</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Style</Label>
              <Select value={style} onValueChange={(v) => setStyle(v as RenderStyle)}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STYLES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Adapter (optional)</Label>
            <Select value={adapter} onValueChange={(v) => setAdapter(v)}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">auto — runtime selects by policy</SelectItem>
                {ADAPTERS[kind].map((a) => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {kind === 'image'
                ? 'svg-portrait-1 is deterministic and reproducible; ai-image-1 calls a provider adapter.'
                : 'Video renders use the ai-video-1 provider adapter.'}
            </p>
          </div>
          {kind === 'video' ? (
            <div className="space-y-1.5">
              <Label className="text-xs">Performance (optional)</Label>
              <Select value={performanceId} onValueChange={(v) => setPerformanceId(v)}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None — idle pose</SelectItem>
                  {performances.data?.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  )) ?? null}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="gap-1.5" disabled={!canSubmit} onClick={() => create.mutate()}>
            {create.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
            Start render
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Detail dialog ───────────────────────────────────────────────────────────
function RenderDetailDialog({
  render, onClose, onOpenArtifact,
}: {
  render: RenderJobView | null;
  onClose: () => void;
  onOpenArtifact: (artifactId: string) => void;
}) {
  const navigate = useYouStore((s) => s.navigate);
  const meta = (render?.artifact?.meta ?? {}) as Record<string, unknown>;
  const solutionArtifactId =
    typeof meta.solutionArtifactId === 'string' ? meta.solutionArtifactId : null;
  const pipeline = (meta.pipeline ?? meta.components) as { adapterId?: string; version?: string }[] | undefined;
  const isVideo = render?.kind === 'video';

  return (
    <Dialog open={!!render} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="you-scroll max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-6">
            {isVideo ? <Video className="size-4 text-muted-foreground" aria-hidden /> : <ImageIcon className="size-4 text-muted-foreground" aria-hidden />}
            Render {render ? render.kind : ''}
          </DialogTitle>
          <DialogDescription>Artifact preview and provenance.</DialogDescription>
        </DialogHeader>
        {render ? (
          <div className="space-y-4">
            {render.artifact ? (
              isVideo ? (
                <video
                  controls
                  src={render.artifact.url}
                  className="max-h-80 w-full rounded-lg border bg-black"
                />
              ) : (
                 
                <img
                  src={render.artifact.url}
                  alt={`Rendered artifact ${render.artifact.artifactId}`}
                  className="max-h-80 w-full rounded-lg border object-contain"
                />
              )
            ) : (
              <div className="rounded-lg border border-dashed bg-card/50 px-4 py-10 text-center text-sm text-muted-foreground">
                {render.status === 'succeeded'
                  ? 'No artifact reference on this render.'
                  : 'Artifact appears here once the render succeeds (signed, expiring URL).'}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={render.status} />
              <Badge variant="outline" className="font-mono">{render.style}</Badge>
              {render.adapterId ? <Badge variant="outline" className="font-mono">{render.adapterId}</Badge> : null}
              <IdChip id={render.id} label="render" />
            </div>
            <KeyValue
              items={[
                { label: 'Twin version', value: <IdChip id={render.twinVersionId} label="v" /> },
                { label: 'Performance', value: render.performanceId ? <IdChip id={render.performanceId} label="perf" /> : <span className="text-muted-foreground">none</span> },
                { label: 'Cost', value: <span className="you-num font-mono">{fmtUsd(render.costUsd)}</span> },
                { label: 'Latency', value: <span className="you-num font-mono">{render.latencyMs != null ? `${Math.round(render.latencyMs)} ms` : '—'}</span> },
                { label: 'Mime', value: <span className="font-mono text-xs">{render.artifact?.mime ?? '—'}</span> },
                { label: 'Bytes', value: <span className="you-num font-mono">{render.artifact?.bytes != null ? `${Math.round(render.artifact.bytes / 1024)} KB` : '—'}</span> },
                { label: 'Content hash', value: render.artifact?.contentHash ? <IdChip id={render.artifact.contentHash} label="sha256" /> : <span className="text-muted-foreground">—</span> },
                { label: 'Created', value: <span className="text-xs text-muted-foreground">{rel(render.createdAt)}</span> },
              ]}
            />
            {render.error ? (
              <p className="rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">{render.error}</p>
            ) : null}
            {Array.isArray(pipeline) && pipeline.length ? (
              <div>
                <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Pipeline components</div>
                <div className="flex flex-wrap gap-1.5">
                  {pipeline.map((c, i) => (
                    <Badge key={i} variant="outline" className="font-mono text-[10px]">
                      {c?.adapterId ?? 'adapter'}{c?.version ? `@${c.version}` : ''}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}
            {solutionArtifactId ? (
              <Button
                className="w-full gap-1.5"
                onClick={() => { onClose(); onOpenArtifact(solutionArtifactId); }}
              >
                <FileBox className="size-4" aria-hidden /> Open Solution Artifact
              </Button>
            ) : null}
            <Button
              variant="ghost" size="sm" className="w-full text-muted-foreground"
              onClick={() => { onClose(); navigate('twins'); }}
            >
              View twin versions
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ─── View ────────────────────────────────────────────────────────────────────
export function RendersView() {
  const navigate = useYouStore((s) => s.navigate);
  const [createOpen, setCreateOpen] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [selected, setSelected] = useState<RenderJobView | null>(null);

  const renders = useQuery({ queryKey: ['renders'], queryFn: () => api.renders.list() });
  const twins = useQuery({ queryKey: ['twins'], queryFn: () => api.twins.list() });
  const { job, done, succeeded } = useJob(jobId);

  useEffect(() => {
    const handler = (e: Event) => setJobId((e as CustomEvent<string>).detail);
    window.addEventListener('you:render-job', handler);
    return () => window.removeEventListener('you:render-job', handler);
  }, []);

  const twinName = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of twins.data ?? []) map.set(t.id, t.displayName);
    return map;
  }, [twins.data]);

  const jobArtifactId = artifactIdFromOutput(job?.output);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Build"
        title="Renders"
        description="Offline image and video compilation of TwinVersions — every render records its pipeline, cost and latency, and may emit a reviewable Solution Artifact."
        actions={
          <>
            <Button
              variant="outline" size="sm" className="gap-1.5"
              onClick={() => renders.refetch()} disabled={renders.isRefetching}
            >
              <RefreshCcw className={renders.isRefetching ? 'size-3.5 animate-spin' : 'size-3.5'} aria-hidden /> Refresh
            </Button>
            <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
              <Plus className="size-3.5" aria-hidden /> New render
            </Button>
          </>
        }
      />

      {jobId ? (
        <SectionCard title="Latest render job" description={done ? undefined : 'Polling the durable job — steps are real backend signals only.'}>
          <JobSteps job={job} compact />
          {done && succeeded && jobArtifactId ? (
            <Button size="sm" className="mt-3 gap-1.5" onClick={() => navigate('artifact', { artifactId: jobArtifactId })}>
              <FileBox className="size-3.5" aria-hidden /> Open Solution Artifact
            </Button>
          ) : null}
        </SectionCard>
      ) : null}

      <SectionCard title="Render jobs" description={`${renders.data?.length ?? 0} recorded`} icon={ImageIcon}>
        {renders.isPending ? (
          <div className="space-y-2.5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : renders.isError ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-xs text-red-700 dark:text-red-400">
            <span>Couldn’t load renders — {renders.error instanceof YouApiError ? renders.error.message : 'request failed'}</span>
            <Button size="sm" variant="outline" className="h-7" onClick={() => renders.refetch()}>Retry</Button>
          </div>
        ) : !renders.data?.length ? (
          <EmptyState
            icon={ImageIcon}
            title="No renders yet"
            hint="Renders compile a TwinVersion into an image or video artifact. Compile a twin first, then start a render."
            action={<Button size="sm" variant="outline" className="gap-1.5" onClick={() => setCreateOpen(true)}><Plus className="size-3.5" aria-hidden /> New render</Button>}
          />
        ) : (
          <div className="max-h-[560px] you-scroll overflow-y-auto rounded-lg border">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead>Twin</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Style</TableHead>
                  <TableHead>Adapter</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Latency</TableHead>
                  <TableHead className="text-right">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {renders.data.map((r: RenderJobView) => (
                  <TableRow key={r.id} className="cursor-pointer" onClick={() => setSelected(r)}>
                    <TableCell className="max-w-36 truncate font-medium">
                      {twinName.get(r.twinId) ?? <IdChip id={r.twinId} label="twin" />}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1 text-xs">
                        {r.kind === 'video' ? <Video className="size-3.5 text-muted-foreground" aria-hidden /> : <ImageIcon className="size-3.5 text-muted-foreground" aria-hidden />}
                        {r.kind}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{r.style}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{r.adapterId ?? 'auto'}</TableCell>
                    <TableCell><StatusBadge status={r.status} /></TableCell>
                    <TableCell className="you-num text-right font-mono text-xs">{fmtUsd(r.costUsd)}</TableCell>
                    <TableCell className="you-num text-right font-mono text-xs">{r.latencyMs != null ? `${Math.round(r.latencyMs)} ms` : '—'}</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">{rel(r.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <NewRenderDialog open={createOpen} onOpenChange={setCreateOpen} />
      <RenderDetailDialog
        render={selected}
        onClose={() => setSelected(null)}
        onOpenArtifact={(artifactId) => navigate('artifact', { artifactId })}
      />
    </div>
  );
}
export default RendersView;
