'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Usage metrics panel — real numbers from api.develop.usage(). Zeros are
// honest zeros. Shared by the Develop → Usage tab and the Usage & Billing view.
// ═══════════════════════════════════════════════════════════════════════════
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Activity, Camera, ImageIcon, Loader2, MessageSquare, RefreshCcw } from 'lucide-react';
import { api, YouApiError } from '@/lib/you/client/api';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { EmptyState, SectionCard } from '@/components/you/shared/primitives';

export function UsagePanel({ showTable = true }: { showTable?: boolean }) {
  const usage = useQuery({ queryKey: ['develop-usage'], queryFn: () => api.develop.usage() });

  if (usage.isPending) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }
  if (usage.isError) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-xs text-red-700 dark:text-red-400">
        <span>Couldn’t load usage — {usage.error instanceof YouApiError ? usage.error.message : 'request failed'}</span>
        <Button size="sm" variant="outline" className="h-7" onClick={() => usage.refetch()}>Retry</Button>
      </div>
    );
  }

  const { metrics, totals } = usage.data;
  const tiles = [
    { label: 'Evidence storage', value: totals.evidenceMb, unit: 'MB', icon: Camera },
    { label: 'Jobs run', value: totals.jobs, unit: 'jobs', icon: Activity },
    { label: 'Renders', value: totals.renders, unit: 'renders', icon: ImageIcon },
    { label: 'LLM calls', value: totals.llmCalls, unit: 'calls', icon: MessageSquare },
  ];
  const chartData = metrics.map((m) => ({ name: m.metric, quantity: m.quantity }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-xl border bg-card p-4">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{tile.label}</span>
              <tile.icon className="size-3.5 text-muted-foreground" aria-hidden />
            </div>
            <div className="you-num mt-2 font-mono text-2xl font-semibold tabular-nums">
              {typeof tile.value === 'number' ? tile.value.toLocaleString() : tile.value}
            </div>
            <div className="text-[11px] text-muted-foreground">{tile.unit}</div>
          </div>
        ))}
      </div>

      {metrics.length ? (
        <div className="h-52 rounded-xl border bg-card p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Metrics by quantity</span>
            <Button size="sm" variant="ghost" className="h-6 gap-1 text-[11px] text-muted-foreground" onClick={() => usage.refetch()} disabled={usage.isRefetching}>
              {usage.isRefetching ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <RefreshCcw className="size-3" aria-hidden />} Refresh
            </Button>
          </div>
          <ResponsiveContainer width="100%" height="85%">
            <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 4, left: -18 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} interval={0} angle={-18} height={38} textAnchor="end" />
              <YAxis tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip
                cursor={{ fill: 'var(--muted)' }}
                contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
              />
              <Bar dataKey="quantity" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={40} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : null}

      {showTable ? (
        <SectionCard title="Metrics" description="Metered quantities with units — honest zeros included">
          {metrics.length ? (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Metric</TableHead>
                    <TableHead className="text-right">Quantity</TableHead>
                    <TableHead className="text-right">Unit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {metrics.map((m) => (
                    <TableRow key={m.metric}>
                      <TableCell className="font-mono text-xs">{m.metric}</TableCell>
                      <TableCell className="you-num text-right font-mono text-xs">{m.quantity.toLocaleString()}</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">{m.unit}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState
              icon={Activity}
              title="No metered usage yet"
              hint="Usage accrues as you capture evidence, compile twins, render artifacts and run agent sessions."
            />
          )}
        </SectionCard>
      ) : null}
    </div>
  );
}
