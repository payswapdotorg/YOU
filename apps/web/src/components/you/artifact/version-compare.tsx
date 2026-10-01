'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Twin version compare — this version vs the previous one: confidence bars
// and deficiency diff. Honest notes when only one version exists.
// ═══════════════════════════════════════════════════════════════════════════
import { useQuery } from '@tanstack/react-query';
import { GitCompareArrows, Minus, Plus, RefreshCcw } from 'lucide-react';
import { api, YouApiError } from '@/lib/you/client/api';
import type { HtirConfidenceDeficiency, TwinVersionView } from '@/lib/you/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { IdChip } from '@/components/you/shared/primitives';
import { cn } from '@/lib/utils';

function ConfidenceBar({ label, value, tone }: { label: string; value: number; tone: 'current' | 'previous' }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 truncate font-mono text-[10px] text-muted-foreground" title={label}>{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full', tone === 'current' ? 'bg-primary' : 'bg-zinc-400 dark:bg-zinc-600')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={cn('you-num w-10 shrink-0 text-right font-mono text-[11px]', tone === 'current' ? 'font-semibold' : 'text-muted-foreground')}>
        {pct}%
      </span>
    </div>
  );
}

const SEVERITY_STYLES: Record<string, string> = {
  low: 'border-zinc-500/30 bg-zinc-500/12 text-zinc-600 dark:text-zinc-400',
  medium: 'border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-400',
  high: 'border-red-500/30 bg-red-500/12 text-red-700 dark:text-red-400',
};

function DeficiencyRow({ d, mark }: { d: HtirConfidenceDeficiency; mark: 'added' | 'resolved' | 'kept' }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border bg-card px-2.5 py-2">
      {mark !== 'kept' ? (
        mark === 'added'
          ? <Plus className="size-3 shrink-0 text-amber-600" aria-hidden />
          : <Minus className="size-3 shrink-0 text-emerald-600" aria-hidden />
      ) : null}
      <span className="font-mono text-[11px] font-medium">{d.capability}</span>
      <Badge variant="outline" className={SEVERITY_STYLES[d.severity] ?? ''}>{d.severity}</Badge>
      {mark === 'added' ? <Badge variant="outline" className="text-[9px] text-amber-700 dark:text-amber-400">new in this version</Badge> : null}
      {mark === 'resolved' ? <Badge variant="outline" className="text-[9px] text-emerald-700 dark:text-emerald-400">resolved</Badge> : null}
      <span className="basis-full text-[11px] text-muted-foreground">{d.reason}</span>
    </div>
  );
}

export function VersionCompare({
  twinVersion,
  twinId,
}: {
  twinVersion: { id: string; version: number };
  twinId: string | null;
}) {
  const versions = useQuery({
    queryKey: ['twin-versions', twinId],
    queryFn: () => api.twins.versions(twinId as string),
    enabled: !!twinId,
  });

  if (!twinId) {
    return (
      <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
        Twin versions could not be resolved for comparison — this artifact’s manifest carries no twin reference in its
        inputs. The referenced version is <span className="font-mono">v{twinVersion.version}</span> (<IdChip id={twinVersion.id} label="version" className="mx-1" />).
      </div>
    );
  }

  if (versions.isPending) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (versions.isError) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-xs text-red-700 dark:text-red-400">
        <span>Couldn’t load twin versions — {versions.error instanceof YouApiError ? versions.error.message : 'request failed'}</span>
        <Button size="sm" variant="outline" className="h-7" onClick={() => versions.refetch()}>Retry</Button>
      </div>
    );
  }

  const current: TwinVersionView | undefined =
    versions.data.find((v: TwinVersionView) => v.id === twinVersion.id)
    ?? versions.data.find((v: TwinVersionView) => v.version === twinVersion.version);
  const previous: TwinVersionView | undefined =
    versions.data.find((v: TwinVersionView) => v.version === (current?.version ?? 0) - 1) ?? undefined;

  if (!current) {
    return (
      <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
        The referenced version <span className="font-mono">v{twinVersion.version}</span> was not found among this
        twin’s versions — it may belong to a different twin or predate a deletion.
      </div>
    );
  }

  if (!previous) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="you-num border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400">v{current.version} · this artifact</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Only one version exists — comparison unlocks with the next compile. This version’s confidence:{' '}
          <span className="you-num font-mono font-semibold text-foreground">
            {current.confidenceSummary ? `${Math.round(current.confidenceSummary.overall * 100)}%` : 'not reported'}
          </span>
          {current.confidenceSummary?.deficiencies.length ? (
            <> · {current.confidenceSummary.deficiencies.length} open deficiencies (see Improve)</>
          ) : null}
          .
        </p>
      </div>
    );
  }

  const curConf = current.confidenceSummary;
  const prevConf = previous.confidenceSummary;
  const domains = [...new Set([...Object.keys(curConf?.byDomain ?? {}), ...Object.keys(prevConf?.byDomain ?? {})])].slice(0, 6);
  const curDefs = curConf?.deficiencies ?? [];
  const prevDefs = prevConf?.deficiencies ?? [];
  const added = curDefs.filter((d) => !prevDefs.some((p) => p.capability === d.capability));
  const resolved = prevDefs.filter((d) => !curDefs.some((c) => c.capability === d.capability));
  const kept = curDefs.filter((d) => prevDefs.some((p) => p.capability === d.capability));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <GitCompareArrows className="size-4 text-muted-foreground" aria-hidden />
        <Badge variant="outline" className="you-num border-zinc-500/30 bg-zinc-500/12 text-zinc-600 dark:text-zinc-400">v{previous.version} · previous</Badge>
        <span className="text-muted-foreground" aria-hidden>→</span>
        <Badge variant="outline" className="you-num border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400">v{current.version} · this artifact</Badge>
        <Button size="sm" variant="ghost" className="ml-auto h-6 gap-1 text-[11px] text-muted-foreground" onClick={() => versions.refetch()} disabled={versions.isRefetching}>
          <RefreshCcw className={versions.isRefetching ? 'size-3 animate-spin' : 'size-3'} aria-hidden /> Refresh
        </Button>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        {[{ v: current, conf: curConf, tone: 'current' as const }, { v: previous, conf: prevConf, tone: 'previous' as const }].map(({ v, conf, tone }) => (
          <div key={v.id} className="space-y-2.5 rounded-lg border bg-card p-3.5">
            <div className="flex items-center justify-between">
              <span className="you-num font-mono text-xs font-semibold">v{v.version}</span>
              <IdChip id={v.id} label="version" />
            </div>
            {conf ? (
              <div className="space-y-1.5">
                <ConfidenceBar label="overall" value={conf.overall} tone={tone} />
                {domains.map((d) => (
                  <ConfidenceBar key={d} label={d} value={conf.byDomain[d] ?? 0} tone={tone} />
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No confidence summary reported.</p>
            )}
          </div>
        ))}
      </div>

      <div>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Deficiency diff — {added.length} added · {resolved.length} resolved · {kept.length} kept
        </div>
        {added.length || resolved.length || kept.length ? (
          <div className="space-y-1.5">
            {resolved.map((d) => <DeficiencyRow key={`r-${d.capability}`} d={d} mark="resolved" />)}
            {added.map((d) => <DeficiencyRow key={`a-${d.capability}`} d={d} mark="added" />)}
            {kept.map((d) => <DeficiencyRow key={`k-${d.capability}`} d={d} mark="kept" />)}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No deficiencies reported in either version.</p>
        )}
      </div>
    </div>
  );
}
