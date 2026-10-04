'use client';
// Version compare — side-by-side confidence and deficiency diff between two
// TwinVersions of the same twin. Honest single-version note: comparing needs
// at least two immutable versions.
// P6.B4: adds the DEFICIENCY DELTA section — per-capability improved /
// regressed / unchanged / unknown between the two versions' deficiency
// reports (GET /twins/:id/deficiencies?versionId=&baselineVersionId=).
// Deltas involving `unknown` on either side are shown as unknown — never
// guessed as improvements or regressions.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { IdChip } from '@/components/you/shared/primitives';
import { api } from '@/lib/you/client/api';
import type { DeficiencyDelta, DeficiencyDeltaKind } from '@/lib/you/core/deficiency';
import type { TwinVersionView } from '@/lib/you/contracts';
import {
  ArrowRight, GitCompareArrows, Minus, Plus, TrendingUp, TrendingDown, CircleHelp, Equal,
} from 'lucide-react';
import { CompareBar } from './confidence';
import { QueryError, RowSkeletons } from './confidence';
import { timeAbs } from './format';
import { cn } from '@/lib/utils';

function VersionPicker({
  label, versions, value, onChange, disabledId,
}: {
  label: string; versions: TwinVersionView[]; value: string; onChange: (id: string) => void; disabledId?: string;
}) {
  return (
    <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
      {label}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger size="sm" className="min-w-28" aria-label={`Version ${label}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {versions.map((v) => (
            <SelectItem key={v.id} value={v.id} disabled={v.id === disabledId}>
              v{v.version} · {v.status}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

const DELTA_STYLES: Record<DeficiencyDeltaKind, string> = {
  improved: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 border-emerald-500/25',
  regressed: 'bg-red-500/12 text-red-700 dark:text-red-400 border-red-500/25',
  unchanged: 'bg-zinc-500/12 text-zinc-600 dark:text-zinc-400 border-zinc-500/25',
  unknown: 'bg-amber-500/12 text-amber-700 dark:text-amber-400 border-amber-500/25',
};

function DeltaBadge({ delta }: { delta: DeficiencyDeltaKind }) {
  const Icon = delta === 'improved' ? TrendingUp : delta === 'regressed' ? TrendingDown : delta === 'unchanged' ? Equal : CircleHelp;
  return (
    <Badge variant="outline" className={cn('you-num gap-1', DELTA_STYLES[delta])}>
      <Icon className="size-3" aria-hidden />
      {delta}
    </Badge>
  );
}

function stateLabel(state: string, severity: string | null): string {
  if (state === 'deficient') return `deficient (${severity ?? 'low'})`;
  return state;
}

/** P6.B4 — the honest per-capability deficiency delta between two versions. */
function DeficiencyDeltaSection({ twinId, a, b }: { twinId: string; a: TwinVersionView; b: TwinVersionView }) {
  const deltaQ = useQuery({
    queryKey: ['twin-deficiency-delta', twinId, a.id, b.id],
    queryFn: () => api.twins.deficiencies(twinId, { versionId: b.id, baselineVersionId: a.id }),
    enabled: a.id !== b.id,
  });

  if (a.id === b.id) return null;

  let body: React.ReactNode;
  if (deltaQ.isPending) {
    body = <RowSkeletons rows={4} />;
  } else if (deltaQ.isError || !deltaQ.data?.delta) {
    body = (
      <QueryError
        error={deltaQ.error ?? new Error('the deficiency delta was not returned for these versions')}
        title="Could not load the deficiency delta"
        onRetry={() => void deltaQ.refetch()}
        compact
      />
    );
  } else {
    const delta: DeficiencyDelta = deltaQ.data.delta;
    body = (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-1.5" aria-label="delta summary">
          <Badge variant="outline" className="you-num gap-1 border-emerald-500/25 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400"><TrendingUp className="size-3" aria-hidden /> {delta.summary.improved} improved</Badge>
          <Badge variant="outline" className="you-num gap-1 border-red-500/25 bg-red-500/12 text-red-700 dark:text-red-400"><TrendingDown className="size-3" aria-hidden /> {delta.summary.regressed} regressed</Badge>
          <Badge variant="outline" className="you-num gap-1 border-zinc-500/25 bg-zinc-500/12 text-zinc-600 dark:text-zinc-400"><Equal className="size-3" aria-hidden /> {delta.summary.unchanged} unchanged</Badge>
          <Badge variant="outline" className="you-num gap-1 border-amber-500/25 bg-amber-500/12 text-amber-700 dark:text-amber-400"><CircleHelp className="size-3" aria-hidden /> {delta.summary.unknown} unknown</Badge>
        </div>
        <ul className="max-h-96 space-y-1.5 overflow-y-auto you-scroll pr-1" aria-label="capability delta rows">
          {delta.rows.map((r) => (
            <li key={r.capability} className="rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{r.label}</span>
                <DeltaBadge delta={r.delta} />
                <span className="you-num ml-auto text-[10.5px] text-muted-foreground">
                  {stateLabel(r.from.state, r.from.severity)} → {stateLabel(r.to.state, r.to.severity)}
                </span>
              </div>
              <p className="mt-0.5 leading-snug text-muted-foreground">{r.reason}</p>
            </li>
          ))}
        </ul>
        <p className="text-[10.5px] text-muted-foreground">
          Baseline v{delta.baseline.twinVersionNumber} → comparison v{delta.comparison.twinVersionNumber}.
          Deltas are computed only from the two versions&apos; persisted deficiency reports; transitions involving
          an unknown state stay unknown — never guessed.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-5">
      <h4 className="flex items-center gap-1.5 text-[13px] font-semibold">
        <GitCompareArrows className="size-3.5 text-muted-foreground" aria-hidden /> Deficiency delta
        <span className="you-num ml-auto text-xs font-normal text-muted-foreground">P6.B4 capability map</span>
      </h4>
      <div className="mt-3">{body}</div>
    </div>
  );
}

export function VersionCompare({ twinId, versions }: { twinId: string; versions: TwinVersionView[] }) {
  const sorted = useMemo(() => [...versions].sort((a, b) => b.version - a.version), [versions]);
  const [aId, setAId] = useState<string>('');
  const [bId, setBId] = useState<string>('');

  const a = sorted.find((v) => v.id === aId) ?? sorted[sorted.length - 2];
  const b = sorted.find((v) => v.id === bId) ?? sorted[0];
  // ^ defaults: newest vs the version before it; explicit picks override.

  if (sorted.length < 2) {
    return (
      <div className="rounded-xl border border-dashed bg-card/50 px-6 py-12 text-center">
        <GitCompareArrows className="mx-auto size-5 text-muted-foreground" aria-hidden />
        <div className="mt-2 text-sm font-medium">Comparison needs two versions</div>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          {sorted.length === 1
            ? `Only v${sorted[0].version} exists. Reconstruct again after new evidence to create the next immutable version.`
            : 'No versions yet — reconstruct this twin from captured evidence first.'}
        </p>
      </div>
    );
  }

  const aConf = a?.htir?.confidence;
  const bConf = b?.htir?.confidence;
  const domains = Array.from(new Set([
    ...Object.keys(aConf?.byDomain ?? {}),
    ...Object.keys(bConf?.byDomain ?? {}),
  ]));
  const aCaps = new Set((aConf?.deficiencies ?? []).map((d) => d.capability));
  const bCaps = new Set((bConf?.deficiencies ?? []).map((d) => d.capability));
  const added = (bConf?.deficiencies ?? []).filter((d) => !aCaps.has(d.capability));
  const fixed = (aConf?.deficiencies ?? []).filter((d) => !bCaps.has(d.capability));
  const remaining = (bConf?.deficiencies ?? []).filter((d) => aCaps.has(d.capability));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-4 rounded-xl border bg-card p-4">
        <VersionPicker label="Baseline" versions={sorted} value={a?.id ?? ''} onChange={setAId} disabledId={b?.id} />
        <ArrowRight className="size-4 text-muted-foreground/50" aria-hidden />
        <VersionPicker label="Compare" versions={sorted} value={b?.id ?? ''} onChange={setBId} disabledId={a?.id} />
        {a && b && a.version === b.version ? (
          <span className="text-[11px] text-muted-foreground">Pick two different versions.</span>
        ) : null}
      </div>

      {a && b ? (
        <>
          <div className="rounded-xl border bg-card p-5">
            <div className="mb-4 grid gap-3 text-xs text-muted-foreground sm:grid-cols-2">
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-foreground">v{a.version}</span>
                  <span className="you-num">{a.status}</span>
                  <IdChip id={a.id} label="" />
                </div>
                <p className="you-num">{timeAbs(a.createdAt)} · {a.evidenceAssetIds.length} evidence assets</p>
              </div>
              <div className="space-y-1.5 sm:text-right">
                <div className="flex items-center gap-2 sm:justify-end">
                  <span className="font-semibold text-foreground">v{b.version}</span>
                  <span className="you-num">{b.status}</span>
                  <IdChip id={b.id} label="" />
                </div>
                <p className="you-num">{timeAbs(b.createdAt)} · {b.evidenceAssetIds.length} evidence assets</p>
              </div>
            </div>
            <div className="space-y-4">
              <div>
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Overall confidence</div>
                <CompareBar a={aConf?.overall} b={bConf?.overall} />
              </div>
              {domains.map((domain) => (
                <div key={domain}>
                  <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">{domain}</div>
                  <CompareBar a={aConf?.byDomain?.[domain]} b={bConf?.byDomain?.[domain]} />
                </div>
              ))}
              {domains.length === 0 ? (
                <p className="text-xs text-muted-foreground">No per-domain confidence reported by either version.</p>
              ) : null}
            </div>
            <p className="mt-4 text-[10.5px] text-muted-foreground">
              Left bar = baseline, right bar = comparison. Bars only show backend-reported confidence — never estimated.
            </p>
          </div>

          {/* P6.B4 — per-capability deficiency delta between the two versions */}
          <DeficiencyDeltaSection twinId={twinId} a={a} b={b} />

          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-xl border bg-card p-4">
              <h4 className="flex items-center gap-1.5 text-[13px] font-semibold">
                <Plus className="size-3.5 text-red-500" aria-hidden /> Added deficiencies
                <span className="you-num ml-auto text-xs font-normal text-muted-foreground">{added.length}</span>
              </h4>
              {added.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">No new deficiencies in v{b.version}.</p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {added.map((d, i) => (
                    <li key={`${d.capability}-${i}`} className="rounded-md border border-red-500/20 bg-red-500/[0.04] px-2.5 py-1.5 text-xs">
                      <span className="font-mono text-[11px] font-medium">{d.capability}</span>
                      <span className="you-num ml-1.5 text-[10px] text-muted-foreground">{d.severity}</span>
                      <p className="mt-0.5 leading-snug text-muted-foreground">{d.reason}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded-xl border bg-card p-4">
              <h4 className="flex items-center gap-1.5 text-[13px] font-semibold">
                <Minus className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden /> Fixed / not present
                <span className="you-num ml-auto text-xs font-normal text-muted-foreground">{fixed.length}</span>
              </h4>
              {fixed.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">Nothing from v{a.version} was resolved in v{b.version}.</p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {fixed.map((d, i) => (
                    <li key={`${d.capability}-${i}`} className="rounded-md border border-emerald-500/20 bg-emerald-500/[0.04] px-2.5 py-1.5 text-xs">
                      <span className="font-mono text-[11px] font-medium">{d.capability}</span>
                      <p className="mt-0.5 leading-snug text-muted-foreground">{d.reason}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded-xl border bg-card p-4">
              <h4 className="flex items-center gap-1.5 text-[13px] font-semibold">
                <GitCompareArrows className="size-3.5 text-muted-foreground" aria-hidden /> Still open
                <span className="you-num ml-auto text-xs font-normal text-muted-foreground">{remaining.length}</span>
              </h4>
              {remaining.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">No carried-over deficiencies.</p>
              ) : (
                <ul className="mt-2 max-h-64 space-y-1.5 overflow-y-auto you-scroll pr-1">
                  {remaining.map((d, i) => (
                    <li key={`${d.capability}-${i}`} className={cn('rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs')}>
                      <span className="font-mono text-[11px] font-medium">{d.capability}</span>
                      <span className="you-num ml-1.5 text-[10px] text-muted-foreground">{d.severity}</span>
                      <p className="mt-0.5 leading-snug text-muted-foreground">{d.reason}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
