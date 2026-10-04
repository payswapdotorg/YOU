'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Cost & Latency dashboard panel (P6.C12) — budget status, usage over time,
// SLO breach list, optimization evidence (before/after diffs).
//
// HONESTY LAWS:
//  - every number comes from the real API surfaces (GET /api/v1/usage cost +
//    optimizations sections, GET /api/v1/metrics latency section);
//  - pre-C12 deployments (or a metrics surface that needs operator auth the
//    caller lacks) render honest unavailable/empty states, never fabricated
//    numbers;
//  - p50/p95 are labeled observed (nearest-rank over real observations);
//    declared SLO targets are labeled declared;
//  - optimization records without paired runs show the empty-state reason.
// ═══════════════════════════════════════════════════════════════════════════
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  Activity, AlertTriangle, CheckCircle2, Gauge, Loader2, RefreshCcw, TrendingDown, Wallet,
} from 'lucide-react';
import { api } from '@/lib/you/client/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { EmptyState, SectionCard } from '@/components/you/shared/primitives';
import { QueryError } from '@/components/you/build/confidence';

function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `$${n.toFixed(2)}`;
}

function ms(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${Math.round(n)} ms`;
}

export function CostLatencyPanel() {
  const usage = useQuery({ queryKey: ['develop-usage'], queryFn: () => api.develop.usage() });
  const metrics = useQuery({ queryKey: ['ops-metrics'], queryFn: () => api.metrics() });

  if (usage.isPending) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
        </div>
        <Skeleton className="h-52 w-full rounded-xl" />
      </div>
    );
  }
  if (usage.isError) {
    return (
      <QueryError
        error={usage.error}
        compact
        onRetry={() => void usage.refetch()}
        title="Couldn't load cost & latency data"
      />
    );
  }

  const cost = usage.data.cost;
  const optimizations = usage.data.optimizations ?? [];
  const slos = metrics.data?.latency?.slos ?? null;

  return (
    <div className="space-y-4">
      {/* ── Budget status ─────────────────────────────────────────────────── */}
      <SectionCard
        title="Cost budget"
        description="Tenant cost budget (PR-13) — enforced before every broker dispatch"
        icon={Wallet}
        actions={
          <Button
            size="sm" variant="ghost" className="h-6 gap-1 text-[11px] text-muted-foreground"
            onClick={() => { void usage.refetch(); void metrics.refetch(); }}
            disabled={usage.isRefetching || metrics.isRefetching}
          >
            {usage.isRefetching || metrics.isRefetching
              ? <Loader2 className="size-3 animate-spin" aria-hidden />
              : <RefreshCcw className="size-3" aria-hidden />} Refresh
          </Button>
        }
      >
        {cost ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-xl border bg-card p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Budget</span>
                  <Badge
                    variant="outline"
                    className={
                      cost.budget.mode === 'unlimited'
                        ? 'border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-400'
                        : 'border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400'
                    }
                  >
                    {cost.budget.mode === 'unlimited' ? 'unlimited (explicit opt-in)' : cost.budget.source}
                  </Badge>
                </div>
                <div className="you-num mt-2 font-mono text-2xl font-semibold tabular-nums">
                  {cost.budget.mode === 'unlimited' ? '∞' : usd(cost.budget.budgetUsd)}
                </div>
                <div className="text-[11px] text-muted-foreground">rolling {cost.budget.periodHours}h window</div>
              </div>
              <div className="rounded-xl border bg-card p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Accrued</span>
                  <Activity className="size-3.5 text-muted-foreground" aria-hidden />
                </div>
                <div className="you-num mt-2 font-mono text-2xl font-semibold tabular-nums">{usd(cost.budget.accruedUsd)}</div>
                <div className="text-[11px] text-muted-foreground">quoted-cost accrual (modeled basis)</div>
              </div>
              <div className="rounded-xl border bg-card p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Remaining</span>
                  {cost.budget.remainingUsd !== null && cost.budget.remainingUsd < 0 ? (
                    <AlertTriangle className="size-3.5 text-amber-600" aria-hidden />
                  ) : (
                    <CheckCircle2 className="size-3.5 text-muted-foreground" aria-hidden />
                  )}
                </div>
                <div className="you-num mt-2 font-mono text-2xl font-semibold tabular-nums">
                  {cost.budget.mode === 'unlimited' ? '∞' : usd(cost.budget.remainingUsd)}
                </div>
                <div className="text-[11px] text-muted-foreground">before the guard refuses submits</div>
              </div>
            </div>

            {cost.budget.mode === 'limited' && cost.budget.budgetUsd !== null && cost.budget.budgetUsd > 0 ? (
              <div className="space-y-1.5">
                <Progress
                  value={Math.min(100, (cost.budget.accruedUsd / cost.budget.budgetUsd) * 100)}
                  className="h-2"
                  aria-label="budget consumed"
                />
                <p className="text-[11px] text-muted-foreground">{cost.budget.note}</p>
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">{cost.budget.note}</p>
            )}

            <p className="text-[11px] text-muted-foreground">
              Basis: {cost.basis}. Accrual metric <code className="font-mono">{cost.accrualMetric}</code> — one row per
              accepted broker submit, counted conservatively (failed/dead/cancelled submits included).
            </p>
          </div>
        ) : (
          <EmptyState
            icon={Wallet}
            title="No cost-budget surface on this deployment"
            hint="The cost section requires the P6.C12 usage surface. Older deployments report legacy usage metrics only."
          />
        )}
      </SectionCard>

      {/* ── Usage over time + per-pipeline breakdown ──────────────────────── */}
      {cost ? (
        <SectionCard
          title="Quoted-cost usage"
          description={`Usage over time (last ${cost.series.length} days) + per-pipeline and per-application accrual`}
          icon={Gauge}
        >
          {cost.series.some((d) => d.quotedUsd > 0 || d.submits > 0) ? (
            <div className="h-44 rounded-xl border bg-card p-4">
              <span className="text-xs font-medium text-muted-foreground">Quoted USD per day</span>
              <ResponsiveContainer width="100%" height="80%">
                <BarChart data={cost.series.map((d) => ({ name: d.day.slice(5), quotedUsd: d.quotedUsd }))} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} />
                  <Tooltip
                    cursor={{ fill: 'var(--muted)' }}
                    contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                  />
                  <Bar dataKey="quotedUsd" fill="var(--chart-2)" radius={[4, 4, 0, 0]} maxBarSize={28} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <EmptyState
              icon={Gauge}
              title="No quoted-cost usage yet"
              hint="Usage accrues as broker-submitted jobs (renders, twin compiles) are accepted — a fresh deployment honestly shows zero."
            />
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Per pipeline (rolling window)</p>
              {cost.byPipeline.length ? (
                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Pipeline</TableHead>
                        <TableHead className="text-right">Quoted USD</TableHead>
                        <TableHead className="text-right">Submits</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {cost.byPipeline.map((p) => (
                        <TableRow key={p.pipeline}>
                          <TableCell className="font-mono text-xs">{p.pipeline}</TableCell>
                          <TableCell className="you-num text-right font-mono text-xs">{usd(p.quotedUsd)}</TableCell>
                          <TableCell className="you-num text-right font-mono text-xs">{p.submits}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                  No broker submits in the current window.
                </p>
              )}
            </div>
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Per application actor (rolling window)</p>
              {cost.byApplication.length ? (
                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Application actor</TableHead>
                        <TableHead className="text-right">Quoted USD</TableHead>
                        <TableHead className="text-right">Submits</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {cost.byApplication.map((a) => (
                        <TableRow key={a.applicationActorId ?? 'interactive'}>
                          <TableCell className="font-mono text-xs">{a.applicationActorId ?? 'interactive sessions'}</TableCell>
                          <TableCell className="you-num text-right font-mono text-xs">{usd(a.quotedUsd)}</TableCell>
                          <TableCell className="you-num text-right font-mono text-xs">{a.submits}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                  No broker submits in the current window.
                </p>
              )}
            </div>
          </div>
        </SectionCard>
      ) : null}

      {/* ── SLO breach list ────────────────────────────────────────────────── */}
      <SectionCard
        title="Latency SLOs"
        description="Declared targets + observed p50/p95 on the hot paths (real measurements only)"
        icon={Activity}
        actions={
          metrics.isError ? (
            <Badge variant="outline" className="border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-400">
              metrics unavailable
            </Badge>
          ) : undefined
        }
      >
        {metrics.isError ? (
          <EmptyState
            icon={AlertTriangle}
            title="Couldn't load the metrics surface"
            hint="GET /api/v1/metrics needs an operator session — the SLO list is hidden rather than guessed."
          />
        ) : slos ? (
          <div className="space-y-3">
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SLO</TableHead>
                    <TableHead className="text-right">Target p95</TableHead>
                    <TableHead className="text-right">Observed p50</TableHead>
                    <TableHead className="text-right">Observed p95</TableHead>
                    <TableHead className="text-right">Obs.</TableHead>
                    <TableHead className="text-right">Breaches</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {slos.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>
                        <div className="font-mono text-xs">{s.id}</div>
                        <div className="text-[11px] text-muted-foreground">{s.covers}</div>
                      </TableCell>
                      <TableCell className="you-num text-right font-mono text-xs">{ms(s.targetP95Ms)}</TableCell>
                      <TableCell className="you-num text-right font-mono text-xs">
                        {s.p50Ms === null ? <span className="text-muted-foreground">—</span> : ms(s.p50Ms)}
                      </TableCell>
                      <TableCell className="you-num text-right font-mono text-xs">
                        {s.p95Ms === null ? (
                          <span className="text-muted-foreground">no observations yet</span>
                        ) : (
                          <span className={s.p95Ms > s.targetP95Ms ? 'font-semibold text-amber-600' : ''}>{ms(s.p95Ms)}</span>
                        )}
                      </TableCell>
                      <TableCell className="you-num text-right font-mono text-xs">{s.observations}</TableCell>
                      <TableCell className="text-right">
                        {s.breaches > 0 ? (
                          <Badge variant="outline" className="border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-400">
                            {s.breaches}
                          </Badge>
                        ) : (
                          <span className="font-mono text-xs text-muted-foreground">0</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Targets are DECLARED SLOs (docs/COST_LATENCY.md), not provider SLAs. {slos.length ? 'p50/p95: nearest-rank over real observed handler wall-clock — no fabricated percentiles; null when no observations exist.' : ''}
            </p>
          </div>
        ) : metrics.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        ) : (
          <EmptyState
            icon={Activity}
            title="No latency surface on this deployment"
            hint="The latency section requires the P6.C12 metrics surface."
          />
        )}
      </SectionCard>

      {/* ── Optimization evidence ──────────────────────────────────────────── */}
      <SectionCard
        title="Optimization evidence"
        description="Evidence-backed optimizations — before/after benchmark pairs with cited run-ids"
        icon={TrendingDown}
      >
        {optimizations.length ? (
          <div className="space-y-4">
            {optimizations.map((o) => (
              <div key={o.id} className="rounded-xl border bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">{o.title}</p>
                    <p className="text-[11px] text-muted-foreground">{o.kind} · {o.changed}</p>
                  </div>
                  {o.evidence ? (
                    <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400">
                      evidence-backed
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">awaiting paired runs</Badge>
                  )}
                </div>
                {o.evidence ? (
                  <div className="mt-3 space-y-2">
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <div className="rounded-lg border p-3">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Before</p>
                        <p className="you-num font-mono text-sm font-semibold tabular-nums">{ms(o.evidence.before.wallClockMs)}</p>
                        <p className="font-mono text-[10px] text-muted-foreground">run {o.evidence.before.runId.slice(0, 10)}… · {o.evidence.before.mode}</p>
                      </div>
                      <div className="rounded-lg border p-3">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">After</p>
                        <p className="you-num font-mono text-sm font-semibold tabular-nums">{ms(o.evidence.after.wallClockMs)}</p>
                        <p className="font-mono text-[10px] text-muted-foreground">run {o.evidence.after.runId.slice(0, 10)}… · {o.evidence.after.mode}</p>
                      </div>
                      <div className="rounded-lg border p-3">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Delta</p>
                        <p className="you-num font-mono text-sm font-semibold tabular-nums text-emerald-600">{o.evidence.deltaMs <= 0 ? '' : '+'}{o.evidence.deltaMs} ms</p>
                        <p className="text-[10px] text-muted-foreground">after − before</p>
                      </div>
                      <div className="rounded-lg border p-3">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Improvement</p>
                        <p className="you-num font-mono text-sm font-semibold tabular-nums">
                          {o.evidence.improvementPct === null ? '—' : `${o.evidence.improvementPct}%`}
                        </p>
                        <p className="text-[10px] text-muted-foreground">wall-clock</p>
                      </div>
                    </div>
                    <p className="text-[11px] text-muted-foreground">{o.evidence.basis}</p>
                  </div>
                ) : (
                  <p className="mt-2 rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">
                    {o.emptyStateReason}
                  </p>
                )}
                <p className="mt-2 text-[11px] text-muted-foreground">{o.note}</p>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={TrendingDown}
            title="No optimization surface on this deployment"
            hint="The optimization evidence records require the P6.C12 usage surface."
          />
        )}
      </SectionCard>
    </div>
  );
}
