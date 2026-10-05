'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Lab productionization components (P6.C10, Worker C lane):
//  - PromotionActions: the evidence-gated promotion lifecycle UI (promote
//    with the machine-checked gate verdicts + evidence refs, reject, revert,
//    retire) — every action server-enforced, the UI only shows the truth;
//  - GenomeLineage: parent → children lineage from the real parentId chain;
//  - MutateAction: the Pipeline Genome loop trigger (durable lab.mutate job
//    with honest progress + errors, never synchronous pretending);
//  - ScientistTab: the Capture Scientist queue (the Lab's evidence requests
//    and their real status).
// Honest states everywhere: loading skeletons, typed errors, empty states —
// no fabricated gate verdicts, no fake lineage, no fake queue rows.
// ═══════════════════════════════════════════════════════════════════════════
import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import {
  ArrowRight, Ban, ChevronRight, Dna, FlaskConical, Loader2, Microscope, RotateCcw,
  Trophy, Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, uid, YouApiError } from '@/lib/you/client/api';
import { describeApiError } from '@/lib/you/client/error-taxonomy';
import type {
  EvidenceRequestView, LabGateVerdictView, LabPipelineGatesView, PipelineCandidateView,
} from '@/lib/you/contracts';
import { useJob } from '@/hooks/you/use-job';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState, IdChip, SectionCard, StatusBadge } from '@/components/you/shared/primitives';
import { JobSteps } from '@/components/you/lab/job-steps';
import { QueryError, RowSkeletons } from '@/components/you/build/confidence';
import { cn } from '@/lib/utils';

function rel(iso?: string | null): string {
  if (!iso) return '—';
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }); } catch { return iso; }
}

function apiErr(err: unknown): string {
  return err instanceof YouApiError ? describeApiError(err) : 'request failed';
}

const VERDICT_STYLES: Record<LabGateVerdictView['verdict'], string> = {
  pass: 'border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400',
  fail: 'border-red-500/30 bg-red-500/12 text-red-700 dark:text-red-400',
  manual: 'border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-400',
};

// ─── Gates preview (shared by the promote dialog) ────────────────────────────

function GatesPreview({ gates }: { gates: LabPipelineGatesView }) {
  const evaluation = gates.evaluation;
  return (
    <div className="space-y-3.5">
      <div className="rounded-lg border bg-muted/30 px-3 py-2.5">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Requirement for {gates.target}
        </div>
        <p className="mt-1 text-xs">{gates.requirement?.label ?? '—'}</p>
        {gates.requirement ? (
          <p className="mt-1 text-[11px] text-muted-foreground">{gates.requirement.detail}</p>
        ) : null}
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Evidence verdict
          </span>
          {evaluation ? (
            <Badge variant="outline" className={VERDICT_STYLES[evaluation.pass ? 'pass' : 'fail']}>
              {evaluation.pass ? 'gates pass' : 'gates fail'}
            </Badge>
          ) : null}
        </div>
        {evaluation?.reason ? (
          <p className={cn('text-xs', evaluation.pass ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400')}>
            {evaluation.reason}
          </p>
        ) : null}
      </div>

      {evaluation?.gates ? (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-xs">
            <tbody>
              {evaluation.gates.gates.map((g) => (
                <tr key={g.gate} className="border-b last:border-b-0">
                  <td className="w-36 px-2.5 py-1.5 font-mono text-[11px]">{g.gate}</td>
                  <td className="px-2.5 py-1.5">
                    <Badge variant="outline" className={cn('text-[10px]', VERDICT_STYLES[g.verdict])}>
                      {g.verdict === 'manual' ? 'human review' : g.verdict}
                    </Badge>
                  </td>
                  <td className="px-2.5 py-1.5 text-[11px] text-muted-foreground">
                    {g.note ?? '—'}
                    {g.actual !== undefined && g.actual !== null ? (
                      <span className="you-num ml-1.5 font-mono">(actual: {String(g.actual)})</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {evaluation?.replay ? (
        <div className="rounded-lg border bg-muted/30 px-3 py-2.5 text-[11px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold uppercase tracking-wide text-muted-foreground">Deterministic replay</span>
            <Badge variant="outline" className={evaluation.replay.deterministic ? VERDICT_STYLES.pass : VERDICT_STYLES.fail}>
              {evaluation.replay.deterministic ? 'byte-identical' : 'diverged'}
            </Badge>
            <span className="you-num text-muted-foreground">{evaluation.replay.runsCompared} same-seed runs</span>
          </div>
          <p className="mt-1 text-muted-foreground">{evaluation.replay.reason}</p>
        </div>
      ) : null}

      {evaluation?.canary ? (
        <div className="rounded-lg border bg-muted/30 px-3 py-2.5 text-[11px] space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold uppercase tracking-wide text-muted-foreground">Canary window</span>
            <Badge variant="outline" className={cn('text-[10px]', evaluation.canary.countOk && evaluation.canary.spanOk ? VERDICT_STYLES.pass : VERDICT_STYLES.fail)}>
              {evaluation.canary.runIds.length} runs · {evaluation.canary.spanMs === null ? 'no span' : `${Math.round(evaluation.canary.spanMs / 60000)} min`}
            </Badge>
          </div>
          <p className="text-muted-foreground">
            count {evaluation.canary.countOk ? '✓' : '✗'} · span ≥1h {evaluation.canary.spanOk ? '✓' : '✗'} · reproducible {evaluation.canary.allReproducible ? '✓' : '✗'} · gates {evaluation.canary.gatesOk ? '✓' : '✗'}
          </p>
        </div>
      ) : null}

      {evaluation?.blockingFailures && evaluation.blockingFailures.length > 0 ? (
        <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-[11px] text-red-700 dark:text-red-400">
          <div className="font-semibold">Blocking failures inside the canary window</div>
          <ul className="mt-1 list-disc pl-4">
            {evaluation.blockingFailures.map((f) => (
              <li key={f.id}>
                <span className="font-mono">{f.region ?? 'unscopable region'}</span> — {f.suspectedCause}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Succeeded runs including this pipeline
        </span>
        {gates.succeededRunIds.length ? (
          gates.succeededRunIds.slice(0, 4).map((id) => <IdChip key={id} id={id} label="run" />)
        ) : (
          <span className="text-xs text-muted-foreground">none yet</span>
        )}
        {gates.succeededRunIds.length > 4 ? (
          <span className="you-num text-[11px] text-muted-foreground">+{gates.succeededRunIds.length - 4} more</span>
        ) : null}
      </div>
    </div>
  );
}

// ─── Promotion lifecycle actions ─────────────────────────────────────────────

export function PromotionActions({
  pipeline, onChanged,
}: { pipeline: PipelineCandidateView; onChanged: () => void }) {
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [revertOpen, setRevertOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [retireOpen, setRetireOpen] = useState(false);
  const [reason, setReason] = useState('');

  const gates = useQuery({
    queryKey: ['lab-pipeline-gates', pipeline.id],
    queryFn: () => api.lab.gates(pipeline.id),
    enabled: promoteOpen,
  });

  const act = useMutation({
    mutationFn: (body: Parameters<typeof api.lab.promote>[0]) => api.lab.promote(body),
    onSuccess: (res, vars) => {
      const verb =
        vars.action === 'promote' ? `Promoted to ${res.pipeline.status}` :
        vars.action === 'revert' ? `Reverted to ${res.pipeline.status}` :
        vars.action === 'retire' ? 'Retired' : 'Decision recorded';
      toast.success(`${verb} — promotion record written`);
      setPromoteOpen(false); setRevertOpen(false); setRejectOpen(false); setRetireOpen(false);
      setReason('');
      onChanged();
    },
    onError: (err) => toast.error(`Promotion action refused — ${apiErr(err)}`),
  });

  const retired = pipeline.status === 'retired';
  const production = pipeline.status === 'production';

  return (
    <div className="mt-4 space-y-3 border-t pt-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Promotion lifecycle
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm" className="gap-1.5" disabled={retired || production || act.isPending}
          onClick={() => setPromoteOpen(true)}
        >
          {act.isPending && act.variables?.action === 'promote' ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Trophy className="size-3.5" aria-hidden />
          )}
          Promote to {gates.data?.target ?? '…'}
        </Button>
        <Button
          size="sm" variant="outline" className="gap-1.5" disabled={act.isPending}
          onClick={() => setRevertOpen(true)}
        >
          <RotateCcw className="size-3.5" aria-hidden /> Revert
        </Button>
        <Button
          size="sm" variant="outline" className="gap-1.5" disabled={act.isPending}
          onClick={() => setRejectOpen(true)}
        >
          <Ban className="size-3.5" aria-hidden /> Reject
        </Button>
        <Button
          size="sm" variant="outline" className="gap-1.5 text-red-700 dark:text-red-400" disabled={retired || act.isPending}
          onClick={() => setRetireOpen(true)}
        >
          <Ban className="size-3.5" aria-hidden /> Retire
        </Button>
        <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground">
          every transition is server-gate-checked and recorded with evidence
        </span>
      </div>

      {/* Promote dialog: the gates preview + the evidence-driven confirm */}
      <Dialog open={promoteOpen} onOpenChange={setPromoteOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="gap-2">
              Promote {pipeline.name} <ArrowRight className="inline size-4" aria-hidden />
              {' '}{gates.data?.target ?? '…'}
            </DialogTitle>
            <DialogDescription>
              The server re-checks every gate at submit — this preview is the same evaluation.
            </DialogDescription>
          </DialogHeader>
          {gates.isPending ? (
            <div className="space-y-2.5">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-28 w-full" />
            </div>
          ) : gates.isError ? (
            <QueryError
              error={gates.error} compact title="Could not evaluate the gates"
              onRetry={() => void gates.refetch()}
            />
          ) : gates.data ? (
            <GatesPreview gates={gates.data} />
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPromoteOpen(false)}>Cancel</Button>
            <Button
              className="gap-1.5"
              disabled={!gates.data?.evaluation?.pass || act.isPending}
              onClick={() => act.mutate({ pipelineId: pipeline.id, action: 'promote' })}
            >
              {act.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Trophy className="size-4" aria-hidden />}
              {gates.data?.evaluation?.pass ? 'Promote with this evidence' : 'Gates not met'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revert dialog */}
      <Dialog open={revertOpen} onOpenChange={setRevertOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Revert {pipeline.name}</DialogTitle>
            <DialogDescription>
              The pipeline returns to the status it held before its most recent forward transition — computed from the promotion trail.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={`revert-reason-${pipeline.id}`} className="text-xs">Why is it going back?</Label>
            <Textarea
              id={`revert-reason-${pipeline.id}`} value={reason}
              onChange={(e) => setReason(e.target.value)} rows={3}
              placeholder="What went wrong at this stage (recorded on the promotion record)"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevertOpen(false)}>Cancel</Button>
            <Button
              variant="outline" className="gap-1.5" disabled={!reason.trim() || act.isPending}
              onClick={() => act.mutate({ pipelineId: pipeline.id, action: 'revert', reason: reason.trim() })}
            >
              {act.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RotateCcw className="size-4" aria-hidden />}
              Revert
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject dialog */}
      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reject at {pipeline.status}</DialogTitle>
            <DialogDescription>
              Records a refusal decision without moving the pipeline — the reason is auditable.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={`reject-reason-${pipeline.id}`} className="text-xs">Reason for the refusal</Label>
            <Textarea
              id={`reject-reason-${pipeline.id}`} value={reason}
              onChange={(e) => setReason(e.target.value)} rows={3}
              placeholder="Why this stage's evidence is refused"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)}>Cancel</Button>
            <Button
              variant="outline" className="gap-1.5" disabled={!reason.trim() || act.isPending}
              onClick={() => act.mutate({ pipelineId: pipeline.id, action: 'reject', reason: reason.trim() })}
            >
              {act.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Ban className="size-4" aria-hidden />}
              Record rejection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Retire dialog */}
      <Dialog open={retireOpen} onOpenChange={setRetireOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Retire {pipeline.name}</DialogTitle>
            <DialogDescription>
              Retired is terminal — no promotion, mutation or rejection applies afterwards (a revert can still un-retire).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={`retire-reason-${pipeline.id}`} className="text-xs">Reason (optional)</Label>
            <Textarea
              id={`retire-reason-${pipeline.id}`} value={reason}
              onChange={(e) => setReason(e.target.value)} rows={2}
              placeholder="Why this lineage is being retired"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRetireOpen(false)}>Cancel</Button>
            <Button
              variant="outline" className="gap-1.5 text-red-700 dark:text-red-400" disabled={act.isPending}
              onClick={() => act.mutate({
                pipelineId: pipeline.id, action: 'retire',
                ...(reason.trim() ? { reason: reason.trim() } : {}),
              })}
            >
              {act.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Ban className="size-4" aria-hidden />}
              Retire pipeline
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Genome lineage ──────────────────────────────────────────────────────────

export function GenomeLineage({
  pipeline, pipelines,
}: { pipeline: PipelineCandidateView; pipelines: PipelineCandidateView[] }) {
  const chain = useMemo(() => {
    // walk parents up (guard against cycles defensively)
    const up: PipelineCandidateView[] = [];
    const seen = new Set<string>([pipeline.id]);
    let cursor = pipelines.find((p) => p.id === pipeline.parentId) ?? null;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      up.push(cursor);
      cursor = pipelines.find((p) => p.id === cursor?.parentId) ?? null;
    }
    return up;
  }, [pipeline, pipelines]);

  const children = useMemo(
    () => pipelines.filter((p) => p.parentId === pipeline.id),
    [pipeline, pipelines],
  );

  return (
    <div className="mt-4 space-y-3 border-t pt-3.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Genome lineage</div>
      {chain.length === 0 && children.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          A founding genome — no parent, no offspring yet. Mutate it to start a lineage.
        </p>
      ) : (
        <div className="space-y-2 text-xs">
          {chain.length ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground">ancestors:</span>
              {[...chain].reverse().map((p) => (
                <span key={p.id} className="inline-flex items-center gap-1.5">
                  <Badge variant="outline" className="gap-1 font-mono text-[10px]">
                    {p.name}
                    <span className="you-num text-muted-foreground">g{p.generation}</span>
                  </Badge>
                  <ChevronRight className="size-3 text-muted-foreground" aria-hidden />
                </span>
              ))}
              <Badge variant="outline" className="border-violet-500/30 bg-violet-500/12 font-mono text-[10px] text-violet-700 dark:text-violet-400">
                {pipeline.name}
              </Badge>
            </div>
          ) : null}
          {children.length ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground">offspring:</span>
              {children.map((c) => (
                <span key={c.id} className="inline-flex items-center gap-1.5">
                  <Badge variant="outline" className="gap-1 font-mono text-[10px]">
                    {c.name}
                    <span className="you-num text-muted-foreground">g{c.generation}</span>
                  </Badge>
                  <StatusBadge status={c.status} />
                </span>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground">no offspring recorded yet</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Mutation (the Pipeline Genome loop) ────────────────────────────────────

export function MutateAction({ pipeline }: { pipeline: PipelineCandidateView }) {
  const [open, setOpen] = useState(false);
  const [mutationSeed, setMutationSeed] = useState('');
  const [worldSeed, setWorldSeed] = useState('42');
  const [jobId, setJobId] = useState<string | null>(null);
  const { job, done, succeeded } = useJob(jobId);

  const mutate = useMutation({
    mutationFn: () => {
      const ms = Number.parseInt(mutationSeed, 10);
      const ws = Number.parseInt(worldSeed, 10);
      return api.lab.mutate(
        pipeline.id,
        {
          ...(Number.isFinite(ms) ? { mutationSeed: ms } : {}),
          worldSeed: Number.isFinite(ws) ? ws : 42,
        },
        uid(),
      );
    },
    onSuccess: (res) => {
      toast.success('Mutation job queued — benchmarking the offspring');
      setOpen(false);
      setJobId(res.jobId);
    },
    onError: (err) => toast.error(`Mutation refused — ${apiErr(err)}`),
  });

  const output = (job?.output ?? null) as {
    childName?: string; childPipelineId?: string; childStatus?: string;
    comparison?: { childBetter?: boolean; delta?: number | null };
    lineage?: { mutations?: string[] };
  } | null;

  return (
    <div className="mt-4 space-y-3 border-t pt-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Pipeline genome loop
        </span>
        <Button
          size="sm" variant="outline" className="ml-auto gap-1.5"
          disabled={pipeline.status === 'retired'}
          onClick={() => setOpen(true)}
        >
          <Dna className="size-3.5" aria-hidden /> Mutate + benchmark offspring
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Mutate {pipeline.name}</DialogTitle>
            <DialogDescription>
              A deterministic genome mutation (same seed → the same offspring), then a REAL benchmark of parent vs offspring on the same seeded world — a durable job with honest progress.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`mut-seed-${pipeline.id}`} className="text-xs">Mutation seed (optional)</Label>
              <Input
                id={`mut-seed-${pipeline.id}`} inputMode="numeric" value={mutationSeed}
                onChange={(e) => setMutationSeed(e.target.value.replace(/[^0-9-]/g, ''))}
                placeholder="derived from the lineage"
                className="h-9 font-mono you-num"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`mut-world-${pipeline.id}`} className="text-xs">World seed</Label>
              <Input
                id={`mut-world-${pipeline.id}`} inputMode="numeric" value={worldSeed}
                onChange={(e) => setWorldSeed(e.target.value.replace(/[^0-9-]/g, ''))}
                className="h-9 font-mono you-num"
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Same mutation seed → the same offspring (deterministic); the offspring is benchmarked against the
            parent on the same world.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button className="gap-1.5" disabled={mutate.isPending} onClick={() => mutate.mutate()}>
              {mutate.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Dna className="size-4" aria-hidden />}
              Mutate + benchmark
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {jobId ? (
        <div className="space-y-2.5">
          <JobSteps job={job} compact />
          {done ? (
            succeeded ? (
              <div className="space-y-1.5 rounded-lg border bg-muted/30 px-3 py-2.5 text-[11px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold uppercase tracking-wide text-muted-foreground">Offspring comparison</span>
                  {output?.comparison ? (
                    <Badge
                      variant="outline"
                      className={cn('text-[10px]', output.comparison.childBetter ? VERDICT_STYLES.pass : VERDICT_STYLES.fail)}
                    >
                      {output.comparison.childBetter ? 'offspring wins' : 'offspring does not win'}
                    </Badge>
                  ) : null}
                  {typeof output?.comparison?.delta === 'number' ? (
                    <span className="you-num font-mono text-muted-foreground">
                      Δ {output.comparison.delta >= 0 ? '+' : ''}{output.comparison.delta}
                    </span>
                  ) : null}
                </div>
                {output?.comparison ? (
                  <p className="text-muted-foreground">
                    {output.comparison.childBetter ? 'offspring wins on the documented weighted formula' : 'offspring does not win on the documented weighted formula'}
                    {typeof output.comparison.delta === 'number'
                      ? ` (Δ ${output.comparison.delta >= 0 ? '+' : ''}${output.comparison.delta})`
                      : ''} — {output.comparison.childBetter ? 'auto-drafted to benchmarked' : 'no auto-draft (the parent still wins)'}
                  </p>
                ) : (
                  <p className="text-muted-foreground">Job finished — see the job record for the recorded output.</p>
                )}
                {output?.childName ? (
                  <p className="text-muted-foreground">
                    offspring <span className="font-mono">{output.childName}</span> — status
                    <span className="font-mono"> {String(output.childStatus ?? '—')}</span>
                  </p>
                ) : null}
                {output?.lineage?.mutations?.length ? (
                  <details>
                    <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground hover:text-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Sparkles className="size-3" aria-hidden /> {output.lineage.mutations.length} recorded mutations
                      </span>
                    </summary>
                    <ul className="you-scroll mt-1.5 max-h-28 list-disc overflow-auto pl-4 text-muted-foreground">
                      {output.lineage.mutations.map((m, i) => (
                        <li key={i} className="font-mono text-[10px]">{m}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            ) : (
              <p className="text-xs text-red-700 dark:text-red-400">
                Mutation job finished unsuccessfully — see the honest error on the job record.
              </p>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ─── The Capture Scientist queue ─────────────────────────────────────────────

export function ScientistTab() {
  const requests = useQuery({
    queryKey: ['lab-capture-requests'],
    queryFn: () => api.lab.captureRequests(),
  });

  return (
    <SectionCard
      title="Capture Scientist queue"
      description="Evidence requests the Lab derived from real benchmark failures — targeted capture, never fabricated guidance"
      icon={FlaskConical}
    >
      {requests.isPending ? (
        <RowSkeletons rows={2} />
      ) : requests.isError ? (
        <QueryError
          error={requests.error} compact title="Could not load the scientist queue"
          onRetry={() => void requests.refetch()}
        />
      ) : !requests.data?.length ? (
        <EmptyState
          icon={Microscope}
          title="No scientist requests yet"
          hint="When a benchmark failure has a targeted capture remedy, the Lab derives an evidence request from it (Failures tab → Request evidence) and it lands here."
        />
      ) : (
        <div className="you-scroll max-h-[520px] space-y-2.5 overflow-y-auto">
          {requests.data.map((r: EvidenceRequestView) => (
            <div key={r.id} className="rounded-lg border bg-card px-3.5 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="gap-1 font-mono text-[10px]">
                  <Microscope className="size-3" aria-hidden /> {r.capability}
                </Badge>
                <StatusBadge status={r.status} />
                <span className="ml-auto text-[11px] text-muted-foreground">{rel(r.createdAt)}</span>
              </div>
              <p className="mt-1.5 text-xs">{r.reason}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">{r.instructions}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <Sparkles className="size-3 shrink-0 text-violet-500" aria-hidden />
                <span className="font-semibold uppercase tracking-wide">expected:</span> {r.expectedSignal}
                {r.originFailureId ? <IdChip id={r.originFailureId} label="failure" /> : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
