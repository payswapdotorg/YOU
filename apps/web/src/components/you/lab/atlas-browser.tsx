'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Failure Atlas browser (P6.C11 — Labs view addition): the aggregate table
// (by taxonomy code: counts, confidence rollups, top suspected causes, the
// recorded policy decisions — enforced vs proposed), drill-down to the real
// recorded cases, and the remediation lifecycle actions (open → mitigated →
// verified, evidence required on every action, full audit trail). Honest
// empty states everywhere: no cases → no counts.
// ═══════════════════════════════════════════════════════════════════════════
import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import {
  AlertTriangle, BadgeCheck, ChevronDown, ClipboardCheck, Loader2, RefreshCcw, ShieldQuestion, Wrench,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, uid, YouApiError } from '@/lib/you/client/api';
import { describeApiError } from '@/lib/you/client/error-taxonomy';
import type { FailureAtlasView, FailureCaseView } from '@/lib/you/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState, IdChip } from '@/components/you/shared/primitives';
import { QueryError, RowSkeletons } from '@/components/you/build/confidence';
import { cn } from '@/lib/utils';

const CLASS_BADGES: Record<string, string> = {
  region: 'border-sky-500/30 bg-sky-500/12 text-sky-700 dark:text-sky-400',
  stage: 'border-violet-500/30 bg-violet-500/12 text-violet-700 dark:text-violet-400',
  provider: 'border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-400',
  policy: 'border-rose-500/30 bg-rose-500/12 text-rose-700 dark:text-rose-400',
};

const STATUS_BADGES: Record<string, string> = {
  open: 'border-red-500/30 bg-red-500/12 text-red-700 dark:text-red-400',
  mitigated: 'border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-400',
  verified: 'border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400',
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

export function AtlasBrowser() {
  const queryClient = useQueryClient();
  const atlas = useQuery({ queryKey: ['lab-failure-atlas'], queryFn: () => api.lab.failureAtlas() });
  const failures = useQuery({ queryKey: ['lab-failures'], queryFn: () => api.lab.failures() });
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [remediateTarget, setRemediateTarget] = useState<FailureCaseView | null>(null);
  const [expandedCode, setExpandedCode] = useState<string | null>(null);

  const remediate = useMutation({
    mutationFn: (args: { id: string; action: 'mitigate' | 'verify'; evidence: string; note?: string }) =>
      api.lab.remediate(args.id, { action: args.action, evidence: args.evidence, ...(args.note ? { note: args.note } : {}) }, uid()),
    onSuccess: (updated, vars) => {
      toast.success(`Failure case ${vars.action === 'mitigate' ? 'mitigated' : 'verified'} — status ${updated.status}`);
      setRemediateTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['lab-failures'] });
      void queryClient.invalidateQueries({ queryKey: ['lab-failure-atlas'] });
    },
    onError: (err) => {
      toast.error(`Remediation failed — ${err instanceof YouApiError ? describeApiError(err) : 'request failed'}`);
    },
  });

  const visibleCases = (failures.data ?? []).filter((f) =>
    selectedCode === null || f.code === selectedCode,
  );

  return (
    <div className="space-y-4">
      {/* ── aggregate table (by taxonomy code) ─────────────────────────── */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Aggregation by failure code (taxonomy v{atlas.data?.taxonomyVersion ?? '—'})
          </div>
          <Button
            size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[11px] text-muted-foreground"
            onClick={() => { atlas.refetch(); failures.refetch(); }}
            disabled={atlas.isRefetching || failures.isRefetching}
          >
            <RefreshCcw className={cn('size-3', (atlas.isRefetching || failures.isRefetching) && 'animate-spin')} aria-hidden /> Refresh
          </Button>
        </div>
        {atlas.isPending ? (
          <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : atlas.isError ? (
          <QueryError error={atlas.error} compact onRetry={() => void atlas.refetch()} title="Could not load the atlas aggregation" />
        ) : !atlas.data?.byCode.length ? (
          <EmptyState
            icon={AlertTriangle}
            title="No failure cases recorded yet"
            hint="The atlas counts REAL recorded cases only — run a benchmark and its failure cases land here with taxonomy v1 codes."
          />
        ) : (
          <div className="max-h-80 you-scroll overflow-y-auto rounded-lg border">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead className="w-8" aria-label="expand" />
                  <TableHead>Code</TableHead>
                  <TableHead>Class</TableHead>
                  <TableHead className="text-right">Cases</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                  <TableHead className="text-right">Mitigated</TableHead>
                  <TableHead className="text-right">Verified</TableHead>
                  <TableHead className="w-28">Mean conf.</TableHead>
                  <TableHead>Top suspected cause</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {atlas.data.byCode.map((row) => {
                  const open = expandedCode === row.code || selectedCode === row.code;
                  return (
                    <Fragment key={row.code}>
                      <TableRow
                        className={cn('cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset', selectedCode === row.code && 'bg-muted/50')}
                        role="button"
                        tabIndex={0}
                        aria-label={`Filter cases by code ${row.code}`}
                        aria-expanded={open}
                        onClick={() => setSelectedCode(selectedCode === row.code ? null : row.code)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelectedCode(selectedCode === row.code ? null : row.code);
                          }
                        }}
                      >
                        <TableCell>
                          <ChevronDown
                            className={cn('size-3.5 text-muted-foreground transition-transform', open && 'rotate-180')}
                            aria-hidden
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedCode(expandedCode === row.code ? null : row.code);
                            }}
                          />
                        </TableCell>
                        <TableCell className="font-mono text-xs">{row.code}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={cn('text-[9px]', CLASS_BADGES[row.class] ?? '')}>{row.class}</Badge>
                        </TableCell>
                        <TableCell className="you-num text-right font-mono text-xs">{row.count}</TableCell>
                        <TableCell className="you-num text-right font-mono text-xs text-red-700 dark:text-red-400">{row.open}</TableCell>
                        <TableCell className="you-num text-right font-mono text-xs text-amber-700 dark:text-amber-400">{row.mitigated}</TableCell>
                        <TableCell className="you-num text-right font-mono text-xs text-emerald-700 dark:text-emerald-400">{row.verified}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <div className="h-1.5 w-10 overflow-hidden rounded-full bg-muted">
                              <div className="h-full rounded-full bg-red-500" style={{ width: `${Math.min(100, Math.round(row.meanConfidence * 100))}%` }} />
                            </div>
                            <span className="you-num font-mono text-[11px]">{Math.round(row.meanConfidence * 100)}%</span>
                          </div>
                        </TableCell>
                        <TableCell className="max-w-64 truncate text-xs text-muted-foreground" title={row.topSuspectedCauses[0]?.cause ?? '—'}>
                          {row.topSuspectedCauses[0]?.cause ?? '—'}
                        </TableCell>
                      </TableRow>
                      {open ? (
                        <TableRow className="bg-muted/30 hover:bg-muted/30">
                          <TableCell colSpan={9}>
                            <div className="space-y-1.5 px-1 py-1">
                              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                Recorded policy decisions — what the system decides on this class
                              </div>
                              {row.policy.map((p) => (
                                <div key={`${p.action}-${p.status}`} className="flex items-start gap-2 text-[11px]">
                                  <Badge
                                    variant="outline"
                                    className={cn(
                                      'shrink-0 text-[9px]',
                                      p.status === 'enforced'
                                        ? 'border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400'
                                        : 'border-zinc-500/30 bg-zinc-500/12 text-zinc-600 dark:text-zinc-400',
                                    )}
                                  >
                                    {p.action} · {p.status}
                                  </Badge>
                                  <span className="text-muted-foreground">{p.basis}</span>
                                </div>
                              ))}
                              {row.topSuspectedCauses.length > 1 ? (
                                <div className="text-[10px] text-muted-foreground">
                                  Other causes: {row.topSuspectedCauses.slice(1).map((c) => `${c.cause} (${c.count})`).join(' · ')}
                                </div>
                              ) : null}
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
        {atlas.data && atlas.data.byCode.length ? (
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            {atlas.data.totals.cases} case(s) in window · mean confidence{' '}
            {atlas.data.totals.meanConfidence !== null ? `${Math.round(atlas.data.totals.meanConfidence * 100)}%` : '—'} ·{' '}
            {atlas.data.totals.unclassified} unclassified · proposed policy entries are honestly labeled (not yet implemented).
          </p>
        ) : null}
      </div>

      {/* ── drill-down: real recorded cases ─────────────────────────────── */}
      <div>
        <div className="mb-1.5 flex items-center gap-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Recorded cases{selectedCode ? ` — code ${selectedCode}` : ''}
          </div>
          {selectedCode ? (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] text-muted-foreground" onClick={() => setSelectedCode(null)}>
              clear filter
            </Button>
          ) : null}
        </div>
        {failures.isPending ? (
          <RowSkeletons rows={2} />
        ) : failures.isError ? (
          <QueryError error={failures.error} compact onRetry={() => void failures.refetch()} title="Could not load failure cases" />
        ) : !visibleCases.length ? (
          <EmptyState
            icon={selectedCode ? ShieldQuestion : AlertTriangle}
            title={selectedCode ? `No recorded cases with code ${selectedCode}` : 'No failure cases recorded'}
            hint={
              selectedCode
                ? 'The aggregate counted this code from real cases — adjust the filter or refresh.'
                : 'Failures from benchmark runs are catalogued here with taxonomy v1 codes, structured payloads and the remediation lifecycle.'
            }
          />
        ) : (
          <div className="max-h-[520px] you-scroll overflow-y-auto rounded-lg border">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Conditions</TableHead>
                  <TableHead>Suspected cause</TableHead>
                  <TableHead className="w-24">Confidence</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Remediation</TableHead>
                  <TableHead className="text-right">Recorded</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleCases.map((f) => {
                  const pct = f.confidence <= 1 ? Math.round(f.confidence * 100) : Math.round(f.confidence);
                  const conditions = Object.entries(f.inputConditions ?? {}).filter(([k]) => k !== 'note');
                  return (
                    <TableRow key={f.id}>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <span className="font-mono text-[11px]">{f.code}</span>
                          {f.payload && Object.keys(f.payload).length ? (
                            <details>
                              <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">payload</summary>
                              <pre className="you-scroll mt-1 max-h-24 overflow-auto rounded-md border bg-muted/30 p-1.5 font-mono text-[9px]">
                                {JSON.stringify(f.payload, null, 2)}
                              </pre>
                            </details>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-48">
                        <div className="truncate font-mono text-[11px] text-muted-foreground" title={JSON.stringify(f.inputConditions)}>
                          {conditions.length
                            ? conditions.slice(0, 2).map(([k, v]) => `${k}=${fmtVal(v)}`).join(' · ') + (conditions.length > 2 ? ` +${conditions.length - 2}` : '')
                            : '—'}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-52 text-xs">{f.suspectedCause}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
                            <div
                              className={cn('h-full rounded-full', pct >= 70 ? 'bg-red-500' : pct >= 40 ? 'bg-amber-500' : 'bg-zinc-400')}
                              style={{ width: `${Math.min(100, pct)}%` }}
                            />
                          </div>
                          <span className="you-num font-mono text-[11px]">{pct}%</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <Badge variant="outline" className={cn('text-[9px]', STATUS_BADGES[f.status] ?? '')}>{f.status}</Badge>
                          {f.remediationLog.length ? (
                            <details>
                              <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
                                audit ({f.remediationLog.length})
                              </summary>
                              <div className="mt-1 space-y-1">
                                {f.remediationLog.map((entry, i) => (
                                  <div key={i} className="rounded border bg-muted/30 p-1.5 text-[9px] leading-relaxed">
                                    <span className="font-mono">{entry.action}</span> {entry.from} → {entry.to} · {entry.actorType} {entry.actorId.slice(0, 10)}… · {rel(entry.at)}
                                    <div className="mt-0.5 text-muted-foreground">evidence: {entry.evidence}</div>
                                  </div>
                                ))}
                              </div>
                            </details>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          {f.benchmarkRunId ? <IdChip id={f.benchmarkRunId} label="run" /> : null}
                          {f.status === 'open' ? (
                            <Button
                              size="sm" variant="outline" className="h-6 gap-1 px-2 text-[10px]"
                              disabled={remediate.isPending}
                              onClick={() => setRemediateTarget(f)}
                            >
                              <Wrench className="size-3" aria-hidden /> Mitigate
                            </Button>
                          ) : f.status === 'mitigated' ? (
                            <Button
                              size="sm" variant="outline" className="h-6 gap-1 px-2 text-[10px]"
                              disabled={remediate.isPending}
                              onClick={() => setRemediateTarget(f)}
                            >
                              <BadgeCheck className="size-3" aria-hidden /> Verify
                            </Button>
                          ) : (
                            <span className="text-[10px] text-muted-foreground">terminal</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">{rel(f.createdAt)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <RemediateDialog
        target={remediateTarget}
        pending={remediate.isPending}
        onSubmit={(evidence, note) =>
          remediateTarget && remediate.mutate({
            id: remediateTarget.id,
            action: remediateTarget.status === 'open' ? 'mitigate' : 'verify',
            evidence,
            ...(note ? { note } : {}),
          })
        }
        onClose={() => setRemediateTarget(null)}
      />
    </div>
  );
}

function RemediateDialog({
  target, pending, onSubmit, onClose,
}: {
  target: FailureCaseView | null;
  pending: boolean;
  onSubmit: (evidence: string, note?: string) => void;
  onClose: () => void;
}) {
  const [evidence, setEvidence] = useState('');
  const [note, setNote] = useState('');
  const action = target?.status === 'open' ? 'mitigate' : 'verify';
  const canSubmit = evidence.trim().length > 2 && !pending;

  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open) { setEvidence(''); setNote(''); onClose(); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {action === 'mitigate' ? <Wrench className="size-4" aria-hidden /> : <BadgeCheck className="size-4" aria-hidden />}
            {action === 'mitigate' ? 'Mitigate failure case' : 'Verify mitigated failure case'}
          </DialogTitle>
          <DialogDescription>
            {target ? (
              <>
                Case <span className="font-mono text-[11px]">{target.id.slice(0, 14)}…</span> · code{' '}
                <span className="font-mono text-[11px]">{target.code}</span> · {target.status} →{' '}
                {action === 'mitigate' ? 'mitigated' : 'verified'}. Evidence is required — remediation is
                evidence-driven and every action is audited (who / when / evidence).
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3.5">
          <div className="space-y-1.5">
            <Label htmlFor="remediation-evidence" className="text-xs">Evidence (required)</Label>
            <Textarea
              id="remediation-evidence"
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              placeholder={action === 'mitigate'
                ? 'e.g. re-ran benchmark on seed 42 with hand-specialist stage — region captured at 0.82 confidence (run id …)'
                : 'e.g. three consecutive re-runs on seed 42 show the region captured — mitigation verified'}
              className="min-h-20 text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="remediation-note" className="text-xs">Note (optional)</Label>
            <Input
              id="remediation-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional context recorded with the audit entry"
              className="h-9 text-xs"
            />
          </div>
          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <ClipboardCheck className="mt-0.5 size-3 shrink-0" aria-hidden />
            Invalid transitions are refused (open → verify, re-mitigating a mitigated case); verified is terminal.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setEvidence(''); setNote(''); onClose(); }}>Cancel</Button>
          <Button className="gap-1.5" disabled={!canSubmit} onClick={() => onSubmit(evidence.trim(), note.trim() || undefined)}>
            {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : action === 'mitigate' ? <Wrench className="size-4" aria-hidden /> : <BadgeCheck className="size-4" aria-hidden />}
            {action === 'mitigate' ? 'Mitigate' : 'Verify'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
