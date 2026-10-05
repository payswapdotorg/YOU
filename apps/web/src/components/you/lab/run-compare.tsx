'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Run comparison panel (P6.C11 — Labs view addition): pick a baseline among
// same-seed runs, see the stage-level metric diff + per-organization
// regression flags + the machine-readable verdict. Honest empty states: no
// baselines → a clear explanation; cross-seed pairs are simply not offered
// (the server would refuse them with a 400 anyway — same world seed is the
// comparison law). Every number is SIMULATED Lab evidence — never production
// truth.
// ═══════════════════════════════════════════════════════════════════════════
import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, GitCompareArrows, Loader2, TrendingDown, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { api, uid, YouApiError } from '@/lib/you/client/api';
import { describeApiError } from '@/lib/you/client/error-taxonomy';
import type { BenchmarkRunView, RunCompareView } from '@/lib/you/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, IdChip } from '@/components/you/shared/primitives';
import { QueryError } from '@/components/you/build/confidence';
import { cn } from '@/lib/utils';

const VERDICT_BADGES: Record<string, string> = {
  regression: 'border-red-500/30 bg-red-500/12 text-red-700 dark:text-red-400',
  improvement: 'border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400',
  no_material_change: 'border-zinc-500/30 bg-zinc-500/12 text-zinc-600 dark:text-zinc-400',
};

function fmtDelta(metric: string, delta: number, deltaKind: string): string {
  if (deltaKind === 'relative-pct') return `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(2)}%`;
  if (/latency|ms/i.test(metric)) return `${delta >= 0 ? '+' : ''}${Math.round(delta)} ms`;
  if (/cost|usd/i.test(metric)) return `${delta >= 0 ? '+' : ''}$${delta.toFixed(4)}`;
  return `${delta >= 0 ? '+' : ''}${delta}`;
}

export function RunComparePanel({ run, knownRuns }: { run: BenchmarkRunView; knownRuns: BenchmarkRunView[] }) {
  // same-seed baselines only — the comparison law (cross-seed is refused
  // server-side with a 400; the UI never offers a pair it would refuse)
  const baselines = useMemo(
    () => knownRuns.filter((r) => r.id !== run.id && r.worldSeed === run.worldSeed),
    [knownRuns, run],
  );
  const [baselineId, setBaselineId] = useState<string>('');

  const effectiveBaseline = baselineId || baselines[0]?.id || '';
  const compare = useQuery({
    queryKey: ['lab-run-compare', run.id, effectiveBaseline],
    queryFn: () => api.lab.compareRun(run.id, effectiveBaseline),
    enabled: !!effectiveBaseline,
  });

  if (!baselines.length) {
    return (
      <EmptyState
        icon={GitCompareArrows}
        title="No comparable baselines yet"
        hint={`Comparison requires another run on the SAME world seed (${run.worldSeed}). Run the benchmark again with this seed — re-runs are new runs referencing their parent, never mutations.`}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label className="text-xs">Baseline (same world seed {run.worldSeed})</Label>
          <Select value={effectiveBaseline || undefined} onValueChange={setBaselineId}>
            <SelectTrigger className="h-9" aria-label="Baseline run">
              <SelectValue placeholder="Pick a baseline run" />
            </SelectTrigger>
            <SelectContent>
              {baselines.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.objectiveCode || 'run'} · seed {b.worldSeed} · {b.status}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          size="sm" variant="outline" className="gap-1.5"
          onClick={() => compare.refetch()}
          disabled={compare.isFetching}
        >
          {compare.isFetching ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <GitCompareArrows className="size-3.5" aria-hidden />}
          Re-diff
        </Button>
      </div>

      {compare.isPending ? (
        <div className="space-y-2"><Skeleton className="h-10 w-full" /><Skeleton className="h-32 w-full" /></div>
      ) : compare.isError ? (
        <QueryError
          error={compare.error}
          compact
          onRetry={() => void compare.refetch()}
          title="Could not compare runs"
        />
      ) : compare.data ? <CompareResult diff={compare.data} /> : null}
    </div>
  );
}

function CompareResult({ diff }: { diff: RunCompareView }) {
  return (
    <div className="space-y-3">
      {/* verdict + machine-readable summary */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2.5">
        <Badge variant="outline" className={cn('text-[10px] font-semibold uppercase tracking-wider', VERDICT_BADGES[diff.verdict] ?? '')}>
          {diff.verdict.replace(/_/g, ' ')}
        </Badge>
        <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <IdChip id={diff.baselineRunId} label="baseline" />
          <ArrowRight className="size-3" aria-hidden />
          <IdChip id={diff.candidateRunId} label="candidate" />
        </span>
        <span className="you-num text-xs text-muted-foreground">
          {diff.regressionFlags.length} regression · {diff.improvementFlags.length} improvement flag(s)
        </span>
        {!diff.objectiveCode.match ? (
          <Badge variant="outline" className="border-amber-500/30 bg-amber-500/12 text-[10px] text-amber-700 dark:text-amber-400">
            cross-objective — shared metrics only
          </Badge>
        ) : null}
      </div>
      <p className="text-[11px] text-muted-foreground">{diff.verdictBasis}</p>

      {/* per-organization metric diff */}
      <div className="you-scroll overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader className="bg-muted/40">
            <TableRow>
              <TableHead>Organization</TableHead>
              <TableHead>Metric</TableHead>
              <TableHead className="text-right">Baseline</TableHead>
              <TableHead className="text-right">Candidate</TableHead>
              <TableHead className="text-right">Δ</TableHead>
              <TableHead>Flags</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {diff.organizations.map((org) =>
              org.metrics.length ? (
                org.metrics.map((m, i) => {
                  const bad = org.regressions.some((r) => r.metric === m.metric);
                  const good = org.improvements.some((r) => r.metric === m.metric);
                  return (
                    <TableRow key={`${org.organizationId}-${m.metric}`}>
                      {i === 0 ? (
                        <TableCell rowSpan={org.metrics.length} className="align-top">
                          <span className="max-w-40 truncate text-xs font-medium">{org.organizationId}</span>
                          {!org.presentIn.baseline || !org.presentIn.candidate ? (
                            <span className="block text-[10px] text-muted-foreground">
                              {org.presentIn.baseline ? 'candidate-only org' : 'baseline-only org'}
                            </span>
                          ) : null}
                        </TableCell>
                      ) : null}
                      <TableCell className="font-mono text-xs">{m.metric}</TableCell>
                      <TableCell className="you-num text-right font-mono text-xs">{m.baselineValue}</TableCell>
                      <TableCell className="you-num text-right font-mono text-xs">{m.candidateValue}</TableCell>
                      <TableCell className={cn(
                        'you-num text-right font-mono text-xs',
                        bad && 'font-semibold text-red-700 dark:text-red-400',
                        good && 'font-semibold text-emerald-700 dark:text-emerald-400',
                      )}>
                        {m.changed ? fmtDelta(m.metric, m.delta, m.deltaKind) : '—'}
                      </TableCell>
                      <TableCell>
                        {bad ? <TrendingDown className="size-3.5 text-red-600 dark:text-red-400" aria-label="regression" /> : null}
                        {good ? <TrendingUp className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-label="improvement" /> : null}
                        {!bad && !good ? <span className="text-xs text-muted-foreground/60">—</span> : null}
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow key={`${org.organizationId}-empty`}>
                  <TableCell className="text-xs font-medium">{org.organizationId}</TableCell>
                  <TableCell colSpan={5} className="text-xs text-muted-foreground">
                    No shared numeric metrics for this organization.
                  </TableCell>
                </TableRow>
              ),
            )}
          </TableBody>
        </Table>
      </div>

      {/* regression / improvement flag details */}
      {diff.regressionFlags.length || diff.improvementFlags.length ? (
        <div className="space-y-1.5">
          {[...diff.regressionFlags.map((f) => ({ ...f, kindDir: 'regression' as const })),
            ...diff.improvementFlags.map((f) => ({ ...f, kindDir: 'improvement' as const }))].map((f, i) => (
            <div
              key={`${f.organizationId}-${f.metric}-${i}`}
              className={cn(
                'flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-[11px]',
                f.kindDir === 'regression'
                  ? 'border-red-500/25 bg-red-500/8 text-red-800 dark:text-red-300'
                  : 'border-emerald-500/25 bg-emerald-500/8 text-emerald-800 dark:text-emerald-300',
              )}
            >
              {f.kindDir === 'regression' ? <TrendingDown className="mt-0.5 size-3 shrink-0" aria-hidden /> : <TrendingUp className="mt-0.5 size-3 shrink-0" aria-hidden />}
              <span>{f.detail}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* stage-level diff + honesty notes */}
      <details className="group">
        <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground hover:text-foreground">
          Stage-level diff (modeled latency/cost) + honesty notes
        </summary>
        <div className="mt-2 space-y-2">
          {diff.organizations.map((org) =>
            org.stages.length ? (
              <div key={`stages-${org.organizationId}`} className="rounded-md border p-2">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{org.organizationId}</div>
                <div className="you-scroll overflow-x-auto">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="pr-3 font-medium">stage</th>
                        <th className="pr-3 text-right font-medium">baseline ms</th>
                        <th className="pr-3 text-right font-medium">candidate ms</th>
                        <th className="pr-3 text-right font-medium">Δ ms</th>
                        <th className="pr-3 text-right font-medium">Δ cost</th>
                        <th className="text-right font-medium">observed (not thresholded)</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {org.stages.map((s) => (
                        <tr key={`${s.adapterId}-${s.role}`}>
                          <td className="pr-3">{s.adapterId} ({s.role})</td>
                          <td className="you-num pr-3 text-right">{s.baselineModeledLatencyMs}</td>
                          <td className="you-num pr-3 text-right">{s.candidateModeledLatencyMs}</td>
                          <td className="you-num pr-3 text-right">{s.deltaModeledLatencyMs}</td>
                          <td className="you-num pr-3 text-right">{s.deltaModeledCostUsd}</td>
                          <td className="you-num text-right text-muted-foreground">
                            {s.observedLatencyMs.baseline ?? '—'} → {s.observedLatencyMs.candidate ?? '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null,
          )}
          <ul className="list-disc space-y-0.5 pl-4 text-[10px] text-muted-foreground">
            {diff.honestyNotes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        </div>
      </details>
    </div>
  );
}
