'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Benchmark run results — org comparison table (best-value highlighting),
// primary-metric bar chart, reproducibility banner.
// Every number here is SIMULATED LAB EVIDENCE — never production truth.
// ═══════════════════════════════════════════════════════════════════════════
import { useMemo } from 'react';
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { FlaskConical, Repeat } from 'lucide-react';
import type { BenchmarkRunView, EvaluationReportView } from '@/lib/you/contracts';
import { Badge } from '@/components/ui/badge';
import { IdChip, StatusBadge } from '@/components/you/shared/primitives';
import { cn } from '@/lib/utils';

const KNOWN_METRICS = ['coverage', 'confidence', 'latencyMs', 'costUsd', 'determinism'];
const LOWER_BETTER = (k: string) => /latency|cost|ms|usd/i.test(k);

const ORIGIN_BADGES: Record<string, string> = {
  generalist: 'bg-zinc-500/12 text-zinc-600 dark:text-zinc-400 border-zinc-500/25',
  'hand-designed': 'bg-amber-500/12 text-amber-700 dark:text-amber-400 border-amber-500/25',
  searched: 'bg-violet-500/12 text-violet-700 dark:text-violet-400 border-violet-500/25',
};

function fmtMetric(key: string, value: number): string {
  if (/latency|ms/i.test(key)) return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
  if (/cost|usd/i.test(key)) return `$${value.toFixed(4)}`;
  if (value <= 1) return `${(value * 100).toFixed(1)}%`;
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

export function BenchmarkRunResults({ run }: { run: BenchmarkRunView }) {
  const rows = useMemo(() => {
    return run.organizations.map((org) => ({
      org,
      report: run.reports.find((r: EvaluationReportView) => r.organizationId === org.organizationId) ?? null,
    }));
  }, [run]);

  const metricKeys = useMemo(() => {
    const set = new Set<string>();
    for (const r of run.reports) for (const k of Object.keys(r.scores)) set.add(k);
    const known = KNOWN_METRICS.filter((k) => set.has(k));
    const rest = [...set].filter((k) => !KNOWN_METRICS.includes(k)).sort();
    return [...known, ...rest];
  }, [run.reports]);

  const primary = metricKeys.includes('coverage') ? 'coverage' : metricKeys[0];

  const best = useMemo(() => {
    const map = new Map<string, { value: number; orgId: string }>();
    for (const r of run.reports) {
      for (const [k, v] of Object.entries(r.scores)) {
        if (typeof v !== 'number' || Number.isNaN(v)) continue;
        const cur = map.get(k);
        const better = !cur || (LOWER_BETTER(k) ? v < cur.value : v > cur.value);
        if (better) map.set(k, { value: v, orgId: r.organizationId });
      }
    }
    return map;
  }, [run.reports]);

  const chartData = rows
    .filter((r) => r.report && typeof r.report.scores[primary] === 'number')
    .map((r) => ({
      name: r.org.label.length > 14 ? `${r.org.label.slice(0, 13)}…` : r.org.label,
      [primary]: r.report!.scores[primary],
    }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={run.status} />
        <IdChip id={run.id} label="run" />
        <Badge variant="outline" className="you-num gap-1.5 font-mono text-[10px]">
          <Repeat className="size-3" aria-hidden /> world seed {run.worldSeed}
        </Badge>
        <Badge variant="outline" className="font-mono text-[10px]">{run.objectiveCode}</Badge>
        <span className="text-[11px] text-muted-foreground">
          {run.organizations.length} organizations · {run.reports.length} reports
        </span>
      </div>

      {/* Reproducibility + honesty banner */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-violet-500/25 bg-violet-500/10 px-3 py-2.5">
        <span className="flex items-center gap-2 text-xs text-violet-800 dark:text-violet-300">
          <Repeat className="size-3.5" aria-hidden />
          World seed {run.worldSeed} — deterministic metrics reproducible.
        </span>
        <span className="flex items-center gap-1.5 rounded-md bg-violet-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-violet-800 dark:text-violet-300">
          <FlaskConical className="size-3" aria-hidden /> Simulated Lab evidence — never production truth
        </span>
      </div>

      {/* Org comparison table */}
      {rows.length ? (
        <div className="you-scroll overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs">
                <th className="px-3 py-2 font-medium">Organization</th>
                {metricKeys.map((k) => (
                  <th key={k} className="px-3 py-2 text-right font-mono font-medium">{k}</th>
                ))}
                <th className="px-3 py-2 text-right font-medium">Reproducible</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ org, report }) => (
                <tr key={org.organizationId} className="border-b last:border-0">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="max-w-40 truncate font-medium">{org.label}</span>
                      <Badge variant="outline" className={cn('text-[9px]', ORIGIN_BADGES[org.origin] ?? '')}>{org.origin}</Badge>
                    </div>
                  </td>
                  {metricKeys.map((k) => {
                    const v = report?.scores[k];
                    const isBest = best.get(k)?.orgId === org.organizationId && typeof v === 'number';
                    return (
                      <td key={k} className="px-3 py-2 text-right">
                        {typeof v === 'number' ? (
                          <span
                            className={cn(
                              'you-num rounded px-1.5 py-0.5 font-mono text-xs',
                              isBest && 'bg-emerald-500/12 font-semibold text-emerald-700 dark:text-emerald-400',
                            )}
                          >
                            {fmtMetric(k, v)}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground/60">—</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-right">
                    {report ? (
                      <span className={cn('text-xs font-medium', report.reproducible ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400')}>
                        {report.reproducible ? 'yes' : 'no'}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground/60">no report</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No organizations recorded on this run.
        </p>
      )}

      {/* Primary-metric bar chart */}
      {chartData.length ? (
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">
            Organizations by primary metric — <span className="font-mono">{primary}</span>
          </div>
          <div className="h-56 rounded-lg border p-3">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 4, left: -14 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} />
                <Tooltip
                  cursor={{ fill: 'var(--muted)' }}
                  contentStyle={{
                    background: 'var(--card)', border: '1px solid var(--border)',
                    borderRadius: 8, fontSize: 12, color: 'var(--foreground)',
                  }}
                  formatter={(v: number | string) => [fmtMetric(primary, Number(v)), primary]}
                />
                <Bar dataKey={primary} fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={56} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : primary ? (
        <p className="text-xs text-muted-foreground">No numeric scores for <span className="font-mono">{primary}</span> yet.</p>
      ) : null}

      <p className="text-[11px] text-muted-foreground">
        Baselines are mandatory: a generalist organization, a hand-designed organization and the searched candidate are
        benchmarked on the same seeded world (LAB_DESIGN.md). Scores are simulated-world measurements.
      </p>
    </div>
  );
}
