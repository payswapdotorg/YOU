'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Labs — the YOU Reality Engineering Lab. Simulated research truth, NEVER
// production truth (AGENTS.md non-negotiable). Objectives, technology
// registry, pipeline genomes, benchmarks, failure atlas, promotions.
// ═══════════════════════════════════════════════════════════════════════════
import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import {
  ArrowRight, ChevronDown, Dna, FlaskConical, AlertTriangle, GitBranch, Loader2, Microscope, Play,
  Plus, RefreshCcw, Repeat, ScrollText, Trophy, Ban, RotateCcw, FilePlus2, ListChecks, FileDown,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, uid, YouApiError } from '@/lib/you/client/api';
import { describeApiError } from '@/lib/you/client/error-taxonomy';
import type {
  BenchmarkRunView, FailureCaseView, LabObjectiveView, PipelineCandidateView,
  PromotionRecordView, TechnologyCandidateView,
} from '@/lib/you/contracts';
import { useJob } from '@/hooks/you/use-job';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { EmptyState, IdChip, PageHeader, SectionCard, StatusBadge } from '@/components/you/shared/primitives';
import { ApiErrorSurface, useApiErrorSurface } from '@/components/you/shared/degraded-state';
import { GenomeViewer } from '@/components/you/lab/genome-viewer';
import { BenchmarkRunResults } from '@/components/you/lab/run-results';
import { JobSteps } from '@/components/you/lab/job-steps';
// P6.C11 — run comparison + atlas browser (Labs view additions)
import { RunComparePanel } from '@/components/you/lab/run-compare';
import { AtlasBrowser } from '@/components/you/lab/atlas-browser';
import { QueryError, RowSkeletons } from '@/components/you/build/confidence';
import {
  GenomeLineage, MutateAction, PromotionActions, ScientistTab,
} from '@/components/you/lab/promotion-panel';
import { cn } from '@/lib/utils';

const TABS = ['objectives', 'technologies', 'pipelines', 'benchmarks', 'failures', 'promotions', 'scientist'] as const;
type LabTab = (typeof TABS)[number];

const ORIGIN_BADGES: Record<string, string> = {
  generalist: 'bg-zinc-500/12 text-zinc-600 dark:text-zinc-400 border-zinc-500/25',
  'hand-designed': 'bg-amber-500/12 text-amber-700 dark:text-amber-400 border-amber-500/25',
  searched: 'bg-violet-500/12 text-violet-700 dark:text-violet-400 border-violet-500/25',
};

const TECH_STATUS: Record<string, string> = {
  research: 'border-violet-500/30 bg-violet-500/12 text-violet-700 dark:text-violet-400',
  candidate: 'border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-400',
  production: 'border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400',
  validated: 'border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400',
  'closed-characterized': 'border-zinc-500/30 bg-zinc-500/12 text-zinc-600 dark:text-zinc-400',
  retired: 'border-zinc-500/30 bg-zinc-500/12 text-zinc-600 dark:text-zinc-400',
};

const SOURCE_BADGES: Record<string, string> = {
  open: 'border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400',
  closed: 'border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-400',
  fixture: 'border-zinc-500/30 bg-zinc-500/12 text-zinc-600 dark:text-zinc-400',
};

const DECISION_ICONS: Record<string, typeof Trophy> = {
  promoted: Trophy, rejected: Ban, reverted: RotateCcw, drafted: FilePlus2, retired: Ban,
};
const DECISION_BADGES: Record<string, string> = {
  promoted: 'border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400',
  rejected: 'border-red-500/30 bg-red-500/12 text-red-700 dark:text-red-400',
  reverted: 'border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-400',
  drafted: 'border-zinc-500/30 bg-zinc-500/12 text-zinc-600 dark:text-zinc-400',
  retired: 'border-zinc-500/30 bg-zinc-500/12 text-zinc-600 dark:text-zinc-400',
};

function rel(iso?: string | null): string {
  if (!iso) return '—';
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }); } catch { return iso; }
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Defensively extract a BenchmarkRun id from job output (shape lands with Worker C). */
function extractRunId(output: Record<string, unknown> | null | undefined): string | null {
  if (!output) return null;
  for (const key of ['runId', 'benchmarkRunId', 'benchmark_run_id', 'id']) {
    const v = output[key];
    if (typeof v === 'string' && v) return v;
  }
  for (const key of ['run', 'benchmarkRun']) {
    const v = output[key];
    if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') {
      return (v as { id: string }).id;
    }
  }
  const entities = output.entities;
  if (Array.isArray(entities)) {
    for (const e of entities) {
      if (e && typeof e === 'object' && /benchmark/i.test(String((e as { type?: unknown }).type ?? ''))) {
        const id = (e as { id?: unknown }).id;
        if (typeof id === 'string' && id) return id;
      }
    }
  }
  return null;
}

function targetChips(record: Record<string, unknown> | undefined, max = 6) {
  if (!record) return [];
  return Object.entries(record).slice(0, max).map(([k, v]) => `${k}: ${fmtVal(v)}`);
}

// ─── Create objective dialog ─────────────────────────────────────────────────
function CreateObjectiveDialog() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  const create = useMutation({
    mutationFn: () => api.lab.createObjective({ code: code.trim(), title: title.trim(), description }, uid()),
    onSuccess: () => {
      toast.success(`Objective ${code.trim()} created`);
      setOpen(false); setCode(''); setTitle(''); setDescription('');
    },
    onError: (err) => toast.error(`Create failed — ${err instanceof YouApiError ? describeApiError(err) : 'request failed'}`),
  });
  const canSubmit = code.trim().length > 1 && title.trim().length > 0 && !create.isPending;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" aria-hidden /> New objective
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Lab objective</DialogTitle>
          <DialogDescription>
            Objectives state what the Lab is trying to discover — constraints, not implementations.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3.5">
          <div className="grid gap-3 sm:grid-cols-[1fr_1.6fr]">
            <div className="space-y-1.5">
              <Label className="text-xs">Code</Label>
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="RECON-002" className="h-9 font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Title</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Objective title" className="h-9" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Description</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is being discovered or improved" className="h-9" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button className="gap-1.5" disabled={!canSubmit} onClick={() => create.mutate()}>
            {create.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Objectives tab ──────────────────────────────────────────────────────────
function ObjectivesTab({ onRunStarted }: { onRunStarted: (runId: string) => void }) {
  const objectives = useQuery({ queryKey: ['lab-objectives'], queryFn: () => api.lab.objectives() });
  const [objectiveCode, setObjectiveCode] = useState('');
  const [worldSeed, setWorldSeed] = useState('42');
  const [jobId, setJobId] = useState<string | null>(null);
  // P6.B8: typed error surface for honest refusals (503 provider/service
  // unavailable, 429 rate-limited) — inline retry guidance, not a bare toast
  const runErrors = useApiErrorSurface('Lab benchmark run');
  const { job, done, succeeded } = useJob(jobId);

  const runIdFromJob = succeeded ? extractRunId(job?.output) : null;

  const hero =
    objectives.data?.find((o: LabObjectiveView) => o.code === 'HUMAN-RECON-001')
    ?? objectives.data?.[0]
    ?? null;
  const others = objectives.data?.filter((o: LabObjectiveView) => o.id !== hero?.id) ?? [];

  // default the run form to the hero objective
  const effectiveCode = objectiveCode || hero?.code || '';

  const run = useMutation({
    mutationFn: () => {
      const seed = Number.parseInt(worldSeed, 10);
      return api.lab.run(
        { objectiveCode: effectiveCode, ...(Number.isFinite(seed) ? { worldSeed: seed } : {}) },
        uid(),
      );
    },
    onSuccess: (res) => {
      runErrors.clear();
      setJobId(res.jobId);
      toast.success('Benchmark run queued — polling the durable job');
    },
    onError: (err) => {
      // P6.B8: typed provider/service-unavailable or rate-limited refusals
      // render the honest inline surface instead of a bare toast
      if (runErrors.capture(err)) return;
      toast.error(`Run failed — ${err instanceof YouApiError ? describeApiError(err) : 'request failed'}`);
    },
  });

  const runQuery = useQuery({
    queryKey: ['lab-run', runIdFromJob],
    queryFn: () => api.lab.getRun(runIdFromJob as string),
    enabled: !!runIdFromJob,
  });

  return (
    <div className="space-y-4">
      {objectives.isPending ? (
        <Skeleton className="h-44 w-full rounded-xl" />
      ) : objectives.isError ? (
        <QueryError
          error={objectives.error}
          compact
          onRetry={() => void objectives.refetch()}
          title="Could not load objectives"
        />
      ) : !objectives.data?.length ? (
        <EmptyState
          icon={FlaskConical}
          title="No Lab objectives yet"
          hint="Objectives state what the Lab discovers — the reference objective HUMAN-RECON-001 seeds the human-reconstruction benchmark."
          action={<CreateObjectiveDialog />}
        />
      ) : hero ? (
        <>
          <SectionCard
            title={hero.code}
            description={hero.title}
            icon={Trophy}
            actions={<CreateObjectiveDialog />}
          >
            <p className="max-w-3xl text-sm text-muted-foreground">{hero.description}</p>
            <div className="mt-4 space-y-3">
              <div>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Target</div>
                <div className="flex flex-wrap gap-1.5">
                  {targetChips(hero.target).map((chip) => (
                    <Badge key={chip} variant="outline" className="you-num font-mono text-[10px]">{chip}</Badge>
                  ))}
                  {!Object.keys(hero.target ?? {}).length ? (
                    <span className="text-xs text-muted-foreground">No target summary recorded.</span>
                  ) : null}
                </div>
              </div>
              <div>
                <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  <ListChecks className="size-3" aria-hidden /> Gates
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {targetChips(hero.gates).map((chip) => (
                    <Badge key={chip} variant="outline" className="you-num font-mono text-[10px]">{chip}</Badge>
                  ))}
                  {!Object.keys(hero.gates ?? {}).length ? (
                    <span className="text-xs text-muted-foreground">No gates recorded — deterministic benchmark gates remain authoritative.</span>
                  ) : null}
                </div>
              </div>
            </div>
          </SectionCard>

          {others.length ? (
            <div className="flex flex-wrap gap-1.5">
              {others.map((o: LabObjectiveView) => (
                <Badge key={o.id} variant="outline" className="gap-1.5 font-mono text-[10px]">
                  {o.code} <span className="font-sans font-normal text-muted-foreground">{o.title}</span>
                </Badge>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <SectionCard title="Run benchmark" description="Seeded world → three organizations compared" icon={Play}>
          <div className="space-y-3.5">
            <div className="space-y-1.5">
              <Label className="text-xs">Objective</Label>
              <Select value={effectiveCode || undefined} onValueChange={setObjectiveCode}>
                <SelectTrigger className="h-9" aria-label="Objective">
                  <SelectValue placeholder={objectives.data?.length ? 'Select objective' : 'No objectives'} />
                </SelectTrigger>
                <SelectContent>
                  {objectives.data?.map((o: LabObjectiveView) => (
                    <SelectItem key={o.id} value={o.code}>{o.code} — {o.title}</SelectItem>
                  )) ?? null}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="world-seed" className="text-xs">World seed</Label>
              <Input
                id="world-seed" inputMode="numeric" value={worldSeed}
                onChange={(e) => setWorldSeed(e.target.value.replace(/[^0-9-]/g, ''))}
                className="h-9 font-mono you-num"
              />
              <p className="text-[11px] text-muted-foreground">
                Synthetic worlds are deterministic by seed — the same seed reproduces the same metrics.
              </p>
            </div>
            <Button
              className="w-full gap-1.5" disabled={!effectiveCode || run.isPending}
              onClick={() => run.mutate()}
            >
              {run.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Play className="size-4" aria-hidden />}
              Run benchmark
            </Button>
            <ApiErrorSurface
              surface={runErrors}
              onRetry={() => run.mutate()}
              retrying={run.isPending}
            />
          </div>
        </SectionCard>

        <div className="space-y-4">
          {jobId ? (
            <SectionCard title="Benchmark job" description={done ? undefined : 'Real backend steps only — no fabricated progress.'}>
              <JobSteps job={job} compact />
              {done && succeeded && !runIdFromJob ? (
                <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
                  Job succeeded but no BenchmarkRun id was found in its output — check the job payload shape.
                </p>
              ) : null}
              {done && !succeeded ? (
                <p className="mt-3 text-xs text-red-700 dark:text-red-400">Job finished unsuccessfully — see the error above.</p>
              ) : null}
            </SectionCard>
          ) : null}

          {runIdFromJob ? (
            <SectionCard title="Run results" description="Organization comparison on the seeded world" icon={FlaskConical}>
              {runQuery.isPending ? (
                <div className="space-y-3">
                  <Skeleton className="h-8 w-2/3" />
                  <Skeleton className="h-32 w-full" />
                  <Skeleton className="h-40 w-full" />
                </div>
              ) : runQuery.isError ? (
                <QueryError
                  error={runQuery.error}
                  compact
                  onRetry={() => void runQuery.refetch()}
                  title="Could not load run"
                />
              ) : runQuery.data ? (
                <>
                  <BenchmarkRunResults run={runQuery.data} />
                  <Button
                    size="sm" variant="ghost" className="mt-3 gap-1.5 text-muted-foreground"
                    onClick={() => onRunStarted(runIdFromJob)}
                  >
                    Keep this run in Benchmarks history <ArrowRight className="size-3.5" aria-hidden />
                  </Button>
                </>
              ) : null}
            </SectionCard>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ─── Technologies tab ────────────────────────────────────────────────────────
function TechnologiesTab() {
  const technologies = useQuery({ queryKey: ['lab-technologies'], queryFn: () => api.lab.technologies() });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  return (
    <SectionCard
      title="Technology registry"
      description="Every replaceable technology — versioned adapters with capability, license and provenance records (ADR-0003)"
      icon={Dna}
      actions={
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => technologies.refetch()} disabled={technologies.isRefetching}>
          <RefreshCcw className={technologies.isRefetching ? 'size-3.5 animate-spin' : 'size-3.5'} aria-hidden /> Refresh
        </Button>
      }
    >
      {technologies.isPending ? (
        <div className="space-y-2.5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : technologies.isError ? (
        <QueryError
          error={technologies.error}
          compact
          onRetry={() => void technologies.refetch()}
          title="Could not load the registry"
        />
      ) : !technologies.data?.length ? (
        <EmptyState
          icon={Dna}
          title="Registry is empty"
          hint="Adapter candidates register here with capability profiles, four-column licensing, runtime, provenance and failure classes."
        />
      ) : (
        <div className="max-h-[560px] you-scroll overflow-y-auto rounded-lg border">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead className="w-8" aria-label="expand" />
                <TableHead>Technology</TableHead>
                <TableHead>Family</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Runtime</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Versions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {technologies.data.map((t: TechnologyCandidateView) => {
                const open = expanded.has(t.id);
                return (
                  <Fragment key={t.id}>
                    <TableRow
                      className="cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                      role="button"
                      tabIndex={0}
                      aria-expanded={open}
                      onClick={() => toggle(t.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggle(t.id);
                        }
                      }}
                    >
                      <TableCell className="w-8">
                        <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden />
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{t.name}</div>
                        {t.vendor ? <div className="text-[11px] text-muted-foreground">{t.vendor}</div> : null}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{t.family}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={SOURCE_BADGES[t.source] ?? ''}>{t.source}</Badge>
                      </TableCell>
                      <TableCell className="max-w-36 truncate font-mono text-[11px] text-muted-foreground" title={t.runtime}>{t.runtime}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={TECH_STATUS[t.status] ?? ''}>{t.status}</Badge>
                      </TableCell>
                      <TableCell className="you-num text-right font-mono text-xs">{t.versions.length}</TableCell>
                    </TableRow>
                    {open ? (
                      <TableRow className="bg-muted/20 hover:bg-muted/20">
                        <TableCell colSpan={7} className="p-0">
                          <div className="space-y-4 p-4">
                            <div>
                              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                                Licensing — four separate records
                              </div>
                              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                                {([['code', t.license.code], ['weights', t.license.weights], ['data', t.license.data], ['provider terms', t.license.providerTerms]] as const).map(([label, value]) => (
                                  <div key={label} className="rounded-md border bg-card px-2.5 py-2">
                                    <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
                                    <div className="mt-0.5 truncate font-mono text-[11px]" title={value}>{value || '—'}</div>
                                  </div>
                                ))}
                              </div>
                              {t.patentNotes ? (
                                <p className="mt-2 text-[11px] text-muted-foreground">
                                  <span className="font-medium">Patent notes:</span> {t.patentNotes}
                                </p>
                              ) : null}
                              <p className="mt-1.5 text-[11px] text-muted-foreground">
                                A permissive code license does not automatically permit commercial model-weight usage — research-only candidates stay in Lab and cannot pass production gates.
                              </p>
                            </div>
                            <div>
                              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Versions</div>
                              {t.versions.length ? (
                                <div className="space-y-2">
                                  {t.versions.map((v) => (
                                    <div key={v.id} className="rounded-lg border bg-card p-3">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <Badge variant="outline" className="you-num font-mono text-[10px]">v{v.version}</Badge>
                                        <span className="font-mono text-[11px] text-muted-foreground">adapter {v.adapterVersion}</span>
                                        {v.latencyP50Ms != null ? (
                                          <span className="you-num font-mono text-[10px] text-muted-foreground">p50 {Math.round(v.latencyP50Ms)} ms</span>
                                        ) : null}
                                        {v.costUsdPerUnit != null ? (
                                          <span className="you-num font-mono text-[10px] text-muted-foreground">${v.costUsdPerUnit}/unit</span>
                                        ) : null}
                                      </div>
                                      <div className="mt-2 flex flex-wrap gap-1">
                                        {v.capabilities.map((c) => (
                                          <Badge key={c} variant="outline" className="font-mono text-[9px] text-muted-foreground">{c}</Badge>
                                        ))}
                                      </div>
                                      {v.failureClasses.length ? (
                                        <div className="mt-1.5 flex flex-wrap items-center gap-1">
                                          <span className="text-[10px] text-muted-foreground">failure classes:</span>
                                          {v.failureClasses.map((f) => (
                                            <span key={f} className="rounded border border-red-500/25 bg-red-500/10 px-1.5 font-mono text-[9px] text-red-700 dark:text-red-400">{f}</span>
                                          ))}
                                        </div>
                                      ) : null}
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <p className="text-xs text-muted-foreground">No versioned adapters registered yet.</p>
                              )}
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </SectionCard>
  );
}

// ─── Pipelines tab ──────────────────────────────────────────────────────────
function PipelinesTab() {
  const pipelines = useQuery({ queryKey: ['lab-pipelines'], queryFn: () => api.lab.pipelines() });
  const [open, setOpen] = useState<string | null>(null);

  return (
    <SectionCard
      title="Pipeline candidates"
      description="Genomes of adapter versions, parameters, skills, souls and compute — the Lab mutates and benchmarks offspring"
      icon={GitBranch}
      actions={
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => pipelines.refetch()} disabled={pipelines.isRefetching}>
          <RefreshCcw className={pipelines.isRefetching ? 'size-3.5 animate-spin' : 'size-3.5'} aria-hidden /> Refresh
        </Button>
      }
    >
      {pipelines.isPending ? (
        <div className="space-y-2.5">{[0, 1].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
      ) : pipelines.isError ? (
        <QueryError
          error={pipelines.error}
          compact
          onRetry={() => void pipelines.refetch()}
          title="Could not load pipelines"
        />
      ) : !pipelines.data?.length ? (
        <EmptyState
          icon={GitBranch}
          title="No pipeline candidates yet"
          hint="The organization compiler records every evaluated pipeline as a reproducible PipelineCandidate genome."
        />
      ) : (
        <div className="you-scroll max-h-[560px] space-y-2.5 overflow-y-auto">
          {pipelines.data.map((p: PipelineCandidateView) => {
            const expanded = open === p.id;
            return (
              <div key={p.id} className="rounded-lg border bg-card">
                <button
                  type="button"
                  className="you-focus flex w-full flex-wrap items-center gap-2 px-3.5 py-3 text-left"
                  onClick={() => setOpen(expanded ? null : p.id)}
                  aria-expanded={expanded}
                >
                  <ChevronDown className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')} aria-hidden />
                  <span className="font-medium">{p.name}</span>
                  <Badge variant="outline" className={ORIGIN_BADGES[p.origin] ?? ''}>{p.origin}</Badge>
                  <span className="you-num font-mono text-[10px] text-muted-foreground">gen {p.generation}</span>
                  <StatusBadge status={p.status} className="ml-auto" />
                  {p.parentId ? <IdChip id={p.parentId} label="parent" /> : null}
                </button>
                {expanded ? (
                  <div className="border-t px-3.5 py-3.5">
                    <GenomeViewer genome={p.genome} />
                    <p className="mt-3 text-[11px] text-muted-foreground">Created {rel(p.createdAt)}</p>
                    <PromotionActions pipeline={p} onChanged={() => void pipelines.refetch()} />
                    <GenomeLineage pipeline={p} pipelines={pipelines.data ?? []} />
                    <MutateAction pipeline={p} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

// ─── Benchmarks tab ──────────────────────────────────────────────────────────
function BenchmarksTab({ knownRunIds }: { knownRunIds: string[] }) {
  const events = useQuery({
    queryKey: ['develop-events', 'lab-history'],
    queryFn: () => api.develop.events({ limit: 100 }),
    staleTime: 15_000,
  });

  const candidateIds = useMemo(() => {
    const ids: string[] = [];
    for (const e of events.data ?? []) {
      if (e.entityId && (/benchmark/i.test(e.entityType ?? '') || /lab\.run/i.test(e.type))) ids.push(e.entityId);
    }
    return [...new Set([...knownRunIds, ...ids])].slice(0, 6);
  }, [events.data, knownRunIds]);

  const runs = useQuery({
    queryKey: ['lab-run-history', candidateIds],
    queryFn: async () => {
      const results = await Promise.allSettled(candidateIds.map((id) => api.lab.getRun(id)));
      return results
        .filter((r): r is PromiseFulfilledResult<BenchmarkRunView> => r.status === 'fulfilled')
        .map((r) => r.value)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    },
    enabled: candidateIds.length > 0,
  });

  const [selected, setSelected] = useState<string | null>(null);
  const selectedRun = useQuery({
    queryKey: ['lab-run', selected],
    queryFn: () => api.lab.getRun(selected as string),
    enabled: !!selected,
  });

  return (
    <div className="space-y-4">
      <SectionCard
        title="Benchmark runs"
        description="Runs started in this window, plus runs discovered from the tenant event log (API v1 has no list-runs endpoint)."
        icon={FlaskConical}
      >
        {events.isPending || (runs.isPending && candidateIds.length > 0) ? (
          <RowSkeletons rows={2} />
        ) : !runs.data?.length ? (
          events.isError ? (
            <QueryError
              error={events.error}
              compact
              onRetry={() => void events.refetch()}
              title="Could not load benchmark runs"
            />
          ) : (
            <EmptyState
              icon={FlaskConical}
              title="No benchmark runs discovered"
              hint="Run a benchmark from the Objectives tab — it compares a generalist baseline, a hand-designed organization and the searched candidate on a seeded world."
            />
          )
        ) : (
          <div className="max-h-72 you-scroll overflow-y-auto rounded-lg border">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead>Objective</TableHead>
                  <TableHead>World seed</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Orgs</TableHead>
                  <TableHead className="text-right">Created</TableHead>
                  <TableHead aria-label="actions" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.data.map((r: BenchmarkRunView) => (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelected(r.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelected(r.id);
                      }
                    }}
                  >
                    <TableCell><IdChip id={r.id} label="run" /></TableCell>
                    <TableCell className="font-mono text-xs">{r.objectiveCode}</TableCell>
                    <TableCell className="you-num font-mono text-xs">{r.worldSeed}</TableCell>
                    <TableCell><StatusBadge status={r.status} /></TableCell>
                    <TableCell className="you-num text-right font-mono text-xs">{r.organizations.length}</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">{rel(r.createdAt)}</TableCell>
                    <TableCell>
                      <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform', selected === r.id && 'rotate-180')} aria-hidden />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      {selected ? (
        <SectionCard title="Run detail" description="Selected benchmark run + comparison against a baseline (P6.C11)" icon={Repeat}>
          {selectedRun.isPending ? (
            <div className="space-y-3">
              <Skeleton className="h-8 w-2/3" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : selectedRun.isError ? (
            <QueryError
              error={selectedRun.error}
              compact
              onRetry={() => void selectedRun.refetch()}
              title="Could not load run"
            />
          ) : selectedRun.data ? (
            <div className="space-y-4">
              <BenchmarkRunResults run={selectedRun.data} />
              <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                <a
                  href={`/api/v1/lab/runs/${selectedRun.data.id}/artifact`}
                  download={`you-benchmark-run-${selectedRun.data.id}.json`}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
                >
                  <FileDown className="size-3.5" aria-hidden /> Download artifact (JSON, sha256-addressed)
                </a>
                <RerunButton run={selectedRun.data} />
              </div>
              <RunComparePanel run={selectedRun.data} knownRuns={runs.data ?? []} />
            </div>
          ) : null}
        </SectionCard>
      ) : null}
    </div>
  );
}

// ─── Re-run button (P6.C11: re-runs are NEW runs referencing their parent —
// the write-once law; never a mutation of the completed run) ────────────────
function RerunButton({ run }: { run: BenchmarkRunView }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const rerun = useMutation({
    mutationFn: () => api.lab.run({ objectiveCode: run.objectiveCode, worldSeed: run.worldSeed, rerunOf: run.id }, uid()),
    onSuccess: (res) => {
      setJobId(res.jobId);
      toast.success('Re-run queued — a NEW run referencing its parent (the original stays immutable)');
    },
    onError: (err) => toast.error(`Re-run failed — ${err instanceof YouApiError ? describeApiError(err) : 'request failed'}`),
  });
  const { job, done, succeeded } = useJob(jobId);

  // P6.C10 — the Capture Scientist: derive a targeted EvidenceRequest from a
  // real failure (region → capability mapping, remediation-based capture
  // instructions). Refusals (no region / unmapped region) are honest 400s.
  const requestEvidence = useMutation({
    mutationFn: (failureId: string) => api.lab.requestFailureEvidence(failureId, uid()),
    onSuccess: () => {
      toast.success('The Capture Scientist derived a targeted request — see the Scientist tab');
    },
    onError: (err) => toast.error(`Request refused — ${err instanceof YouApiError ? describeApiError(err) : 'request failed'}`),
  });

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm" variant="outline" className="h-8 gap-1.5 text-xs"
        disabled={rerun.isPending || run.status !== 'succeeded'}
        onClick={() => rerun.mutate()}
        title={run.status !== 'succeeded' ? 'Only completed runs can be re-run' : `Re-run on seed ${run.worldSeed} — new run, parent stays immutable`}
      >
        {rerun.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Repeat className="size-3.5" aria-hidden />}
        Re-run on seed {run.worldSeed}
      </Button>
      {jobId ? (
        <span className={cn('text-[11px]', done ? (succeeded ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400') : 'text-muted-foreground')}>
          {done ? (succeeded ? 're-run complete — refresh the list' : 're-run failed — see job') : 're-run in progress…'}
        </span>
      ) : null}
      {job ? <span className="sr-only">{JSON.stringify(job.output)}</span> : null}
    </div>
  );
}

// ─── Failures tab (P6.C11: the AtlasBrowser — aggregate table + drill-down +
// remediation lifecycle actions) ─────────────────────────────────────────────
function FailuresTab() {
  const failures = useQuery({ queryKey: ['lab-failures'], queryFn: () => api.lab.failures() });

  // P6.C10 — the Capture Scientist: derive a targeted EvidenceRequest from a
  // real failure (region → capability mapping, remediation-based capture
  // instructions). Refusals (no region / unmapped region) are honest 400s.
  const requestEvidence = useMutation({
    mutationFn: (failureId: string) => api.lab.requestFailureEvidence(failureId, uid()),
    onSuccess: () => {
      toast.success('The Capture Scientist derived a targeted request — see the Scientist tab');
    },
    onError: (err) => toast.error(`Request refused — ${err instanceof YouApiError ? describeApiError(err) : 'request failed'}`),
  });

  return (
    <SectionCard
      title="Failure atlas"
      description="Aggregation by taxonomy code, drill-down to the real recorded cases, and the remediation lifecycle open → mitigated → verified (LAB_DESIGN.md)"
      icon={AlertTriangle}
    >
      <AtlasBrowser />
      {/* P6.C10 union: the raw recorded-cases table with the Capture Scientist
          evidence-request actions lives alongside the C11 atlas surface. */}
      <div className="mt-5">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recorded failure cases</h3>
      {failures.isPending ? (
        <div className="space-y-2.5">{[0, 1].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : failures.isError ? (
        <QueryError
          error={failures.error}
          compact
          onRetry={() => void failures.refetch()}
          title="Could not load failure cases"
        />
      ) : !failures.data?.length ? (
        <EmptyState
          icon={AlertTriangle}
          title="No failure cases recorded"
          hint="Failures from benchmark runs are catalogued here with the exact conditions that reproduce them."
        />
      ) : (
        <div className="max-h-[520px] you-scroll overflow-y-auto rounded-lg border">
          <Table>
            <TableHeader className="sticky top-0 bg-card">
              <TableRow>
                <TableHead>Input conditions</TableHead>
                <TableHead>Suspected cause</TableHead>
                <TableHead className="w-28">Confidence</TableHead>
                <TableHead>Remediation</TableHead>
                <TableHead>Run</TableHead>
                <TableHead className="text-right">Recorded</TableHead>
                <TableHead aria-label="actions" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {failures.data.map((f: FailureCaseView) => {
                const pct = f.confidence <= 1 ? Math.round(f.confidence * 100) : Math.round(f.confidence);
                const conditions = Object.entries(f.inputConditions ?? {});
                return (
                  <TableRow key={f.id}>
                    <TableCell className="max-w-52">
                      <div className="truncate font-mono text-[11px] text-muted-foreground" title={JSON.stringify(f.inputConditions)}>
                        {conditions.length
                          ? conditions.slice(0, 2).map(([k, v]) => `${k}=${fmtVal(v)}`).join(' · ') + (conditions.length > 2 ? ` +${conditions.length - 2}` : '')
                          : '—'}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-52 text-xs">{f.suspectedCause}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <div className="h-1.5 w-14 overflow-hidden rounded-full bg-muted">
                          <div
                            className={cn('h-full rounded-full', pct >= 70 ? 'bg-red-500' : pct >= 40 ? 'bg-amber-500' : 'bg-zinc-400')}
                            style={{ width: `${Math.min(100, pct)}%` }}
                          />
                        </div>
                        <span className="you-num font-mono text-[11px]">{pct}%</span>
                      </div>
                    </TableCell>
                    <TableCell className="max-w-52 text-xs text-muted-foreground">{f.remediation ?? '—'}</TableCell>
                    <TableCell>{f.benchmarkRunId ? <IdChip id={f.benchmarkRunId} label="run" /> : <span className="text-xs text-muted-foreground">—</span>}</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">{rel(f.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm" variant="outline" className="h-7 gap-1.5 px-2.5 text-[11px]"
                        disabled={requestEvidence.isPending && requestEvidence.variables === f.id}
                        title={typeof f.inputConditions?.region === 'string' ? `Derive a targeted ${String(f.inputConditions.region)} evidence request` : 'this failure records no region — the Capture Scientist refuses to fabricate guidance'}
                        onClick={() => requestEvidence.mutate(f.id)}
                      >
                        {requestEvidence.isPending && requestEvidence.variables === f.id ? (
                          <Loader2 className="size-3 animate-spin" aria-hidden />
                        ) : (
                          <Microscope className="size-3" aria-hidden />
                        )}
                        Request evidence
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      </div>
    </SectionCard>
  );
}

// ─── Promotions tab ──────────────────────────────────────────────────────────
function PromotionsTab() {
  const promotions = useQuery({ queryKey: ['lab-promotions'], queryFn: () => api.lab.promotions() });

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-300">
        <span className="font-medium">Server-gated ladder.</span> Promotion transitions are machine-checked evidence — draft → benchmarked →
        validated → canary → production (reversible; retiring is terminal) — enforced by the promotions API on real run
        rows, never by this UI. Records below are real records with the server-derived decidedBy; lab evidence stays
        simulated research truth, never production human truth.
      </div>
      <SectionCard title="Promotion records" description="Evidence-driven status transitions" icon={Trophy}>
        {promotions.isPending ? (
          <div className="space-y-2.5">{[0, 1].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
        ) : promotions.isError ? (
          <QueryError
            error={promotions.error}
            compact
            onRetry={() => void promotions.refetch()}
            title="Could not load promotions"
          />
        ) : !promotions.data?.length ? (
          <EmptyState
            icon={Trophy}
            title="No promotion records"
            hint="When a pipeline candidate passes its gates, the promotion decision and its evidence land here."
          />
        ) : (
          <div className="relative space-y-0 pl-6">
            <div className="absolute bottom-2 left-[9px] top-2 w-px bg-border" aria-hidden />
            {promotions.data.map((p: PromotionRecordView) => {
              const Icon = DECISION_ICONS[p.decision] ?? FilePlus2;
              const decidedBy = p.decidedBy;
              return (
                <div key={p.id} className="relative pb-5 last:pb-0">
                  <span className="absolute -left-6 top-0.5 flex size-[18px] items-center justify-center rounded-full border bg-card">
                    <Icon className="size-2.5 text-muted-foreground" aria-hidden />
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={p.fromStatus} />
                    <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />
                    <StatusBadge status={p.toStatus} />
                    <Badge variant="outline" className={DECISION_BADGES[p.decision] ?? ''}>{p.decision}</Badge>
                    <span className="text-[11px] text-muted-foreground">{rel(p.createdAt)}</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <IdChip id={p.pipelineId} label="pipeline" />
                    {typeof decidedBy === 'string' ? <span>decided by {decidedBy}</span> : null}
                  </div>
                  {p.evidence && Object.keys(p.evidence).length ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground hover:text-foreground">
                        <span className="inline-flex items-center gap-1"><ScrollText className="size-3" aria-hidden /> evidence</span>
                      </summary>
                      <pre className="you-scroll mt-1.5 max-h-40 overflow-auto rounded-md border bg-muted/30 p-2.5 font-mono text-[10px]">
                        {JSON.stringify(p.evidence, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// ─── View ────────────────────────────────────────────────────────────────────
export function LabsView() {
  const [tab, setTab] = useState<LabTab>('objectives');
  const [knownRunIds, setKnownRunIds] = useState<string[]>([]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Develop"
        title="Labs"
        description="The Reality Engineering Lab discovers and improves pipelines and agent organizations for human reconstruction — under explicit objectives, on deterministic seeded worlds."
      />

      <div className="flex items-center gap-2.5 rounded-xl border border-violet-500/25 bg-violet-500/10 px-4 py-3">
        <FlaskConical className="size-4 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden />
        <p className="text-xs text-violet-800 dark:text-violet-300">
          <span className="font-semibold">Simulated Lab evidence — never production truth.</span> Lab worlds are
          synthetic, deterministic by seed, and explicitly labeled as simulated. Production promotion requires separate
          reproducibility, rights and cost evidence.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as LabTab)}>
        <TabsList className="you-scroll h-auto w-full max-w-full overflow-x-auto">
          <TabsTrigger value="objectives">Objectives</TabsTrigger>
          <TabsTrigger value="technologies">Technologies</TabsTrigger>
          <TabsTrigger value="pipelines">Pipelines</TabsTrigger>
          <TabsTrigger value="benchmarks">Benchmarks</TabsTrigger>
          <TabsTrigger value="failures">Failure Atlas</TabsTrigger>
          <TabsTrigger value="promotions">Promotions</TabsTrigger>
          <TabsTrigger value="scientist">Scientist</TabsTrigger>
        </TabsList>
        <TabsContent value="objectives" className="mt-4">
          <ObjectivesTab
            onRunStarted={(runId) => {
              setKnownRunIds((prev) => (prev.includes(runId) ? prev : [...prev, runId]));
              toast.success('Run pinned to Benchmarks history');
            }}
          />
        </TabsContent>
        <TabsContent value="technologies" className="mt-4"><TechnologiesTab /></TabsContent>
        <TabsContent value="pipelines" className="mt-4"><PipelinesTab /></TabsContent>
        <TabsContent value="benchmarks" className="mt-4"><BenchmarksTab knownRunIds={knownRunIds} /></TabsContent>
        <TabsContent value="failures" className="mt-4"><FailuresTab /></TabsContent>
        <TabsContent value="promotions" className="mt-4"><PromotionsTab /></TabsContent>
        <TabsContent value="scientist" className="mt-4"><ScientistTab /></TabsContent>
      </Tabs>
    </div>
  );
}
export default LabsView;
