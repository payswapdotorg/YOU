'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Pipeline genome viewer — renders a PipelineGenome as a horizontal stage
// graph plus skills / soul / compute / evaluation summary (LAB_DESIGN.md).
// ═══════════════════════════════════════════════════════════════════════════
import { Dna, MoveRight } from 'lucide-react';
import type { PipelineGenome, PipelineGenomeStage } from '@/lib/you/contracts';
import { Badge } from '@/components/ui/badge';
import { IdChip } from '@/components/you/shared/primitives';
import { cn } from '@/lib/utils';

function paramsSummary(params: Record<string, unknown>): string {
  const entries = Object.entries(params);
  if (!entries.length) return 'no params';
  return entries
    .slice(0, 3)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' ')
    + (entries.length > 3 ? ` +${entries.length - 3}` : '');
}

function StageChip({ stage }: { stage: PipelineGenomeStage }) {
  return (
    <div
      className="flex min-w-0 flex-col gap-1 rounded-lg border bg-card px-2.5 py-2"
      title={`${stage.adapterId}@${stage.version} — ${paramsSummary(stage.params)}`}
    >
      <div className="flex items-center gap-1.5">
        <span className="truncate font-mono text-[11px] font-medium">{stage.adapterId}</span>
        <span className="you-num shrink-0 rounded bg-muted px-1 font-mono text-[9px] text-muted-foreground">
          v{stage.version}
        </span>
      </div>
      <span className="truncate font-mono text-[9px] text-muted-foreground">{paramsSummary(stage.params)}</span>
    </div>
  );
}

export function GenomeViewer({ genome, className }: { genome: PipelineGenome; className?: string }) {
  return (
    <div className={cn('space-y-3.5', className)}>
      <div>
        <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          <Dna className="size-3" aria-hidden /> Genome — {genome.stages.length} stages
        </div>
        <div className="you-scroll flex items-stretch gap-1.5 overflow-x-auto pb-1">
          {genome.stages.map((stage, i) => (
            <div key={`${stage.adapterId}-${i}`} className="flex items-center gap-1.5">
              <StageChip stage={stage} />
              {i < genome.stages.length - 1 ? (
                <MoveRight className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-x-6 gap-y-2.5 text-xs sm:grid-cols-2">
        {genome.skills.length ? (
          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Skills</div>
            <div className="flex flex-wrap gap-1">
              {genome.skills.map((s) => (
                <Badge key={s} variant="outline" className="font-mono text-[9px]">{s}</Badge>
              ))}
            </div>
          </div>
        ) : null}
        {genome.soulKey ? (
          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Soul</div>
            <Badge variant="outline" className="font-mono text-[9px]">{genome.soulKey}</Badge>
          </div>
        ) : null}
        <div>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Compute</div>
          <span className="font-mono text-[11px]">
            {genome.compute.class}
            {genome.compute.maxCostUsd != null ? (
              <span className="you-num ml-1.5 text-muted-foreground">≤ ${genome.compute.maxCostUsd}</span>
            ) : null}
          </span>
        </div>
        <div>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Evaluation</div>
          <div className="flex flex-wrap items-center gap-1.5">
            {genome.evaluation.rubric.slice(0, 4).map((r) => (
              <Badge key={r} variant="outline" className="max-w-40 truncate font-mono text-[9px] text-muted-foreground">{r}</Badge>
            ))}
            <span className="you-num font-mono text-[10px] text-muted-foreground">seed {genome.evaluation.seed}</span>
          </div>
        </div>
        {genome.organizationId ? (
          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Organization</div>
            <IdChip id={genome.organizationId} label="org" />
          </div>
        ) : null}
        {Object.keys(genome.parameters).length ? (
          <div className="sm:col-span-2">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Parameters</div>
            <pre className="you-scroll overflow-x-auto rounded-md border bg-muted/30 px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground">
              {JSON.stringify(genome.parameters, null, 0)}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  );
}
