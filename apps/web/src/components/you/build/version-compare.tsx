'use client';
// Version compare — side-by-side confidence and deficiency diff between two
// TwinVersions of the same twin. Honest single-version note: comparing needs
// at least two immutable versions.
import { useMemo, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { IdChip } from '@/components/you/shared/primitives';
import type { TwinVersionView } from '@/lib/you/contracts';
import { ArrowRight, GitCompareArrows, Minus, Plus } from 'lucide-react';
import { CompareBar } from './confidence';
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

export function VersionCompare({ versions }: { versions: TwinVersionView[] }) {
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
