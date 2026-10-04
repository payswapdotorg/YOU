'use client';
// Deficiency map (P6.B4) — the honest quality visualization for a twin: one
// row per capability (face | hair | hands | silhouette | motion | speech)
// with an honest state badge (ok / deficient / unknown — reason on hover),
// severity, a source drill-down (every citable persisted signal), and a
// one-click "Request targeted evidence" action that opens a prefilled
// creation form hitting the existing evidence-requests POST route.
//
// HONESTY LAWS: unknown renders as unknown (never fake green); the empty
// state (no captures yet) is an explicit callout, not a wall of ok rows;
// loading/error surfaces never substitute placeholder data.
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState, IdChip } from '@/components/you/shared/primitives';
import { QueryError, RowSkeletons, SeverityBadge } from './confidence';
import { api, uid } from '@/lib/you/client/api';
import type { DeficiencyRemedy, DeficiencyRow, DeficiencySource } from '@/lib/you/core/deficiency';
import type { TwinVersionView } from '@/lib/you/contracts';
import {
  Activity, Camera, CheckCircle2, ChevronDown, CircleHelp, Gauge, ListChecks, TriangleAlert,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

const STATE_STYLES: Record<DeficiencyRow['state'], string> = {
  ok: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 border-emerald-500/25',
  deficient: 'bg-red-500/12 text-red-700 dark:text-red-400 border-red-500/25',
  unknown: 'bg-zinc-500/12 text-zinc-600 dark:text-zinc-400 border-zinc-500/25',
};

function StateBadge({ state, reason, className }: { state: DeficiencyRow['state']; reason: string; className?: string }) {
  const Icon = state === 'ok' ? CheckCircle2 : state === 'deficient' ? TriangleAlert : CircleHelp;
  return (
    <Badge
      variant="outline"
      className={cn('gap-1', STATE_STYLES[state], className)}
      title={reason} // honest reason on hover
    >
      <Icon className="size-3" aria-hidden />
      {state}
    </Badge>
  );
}

const SOURCE_KIND_LABEL: Record<DeficiencySource['kind'], string> = {
  'htir-deficiency': 'reconstruction deficiency',
  'htir-coverage': 'reconstruction coverage',
  'capture-step': 'capture step',
  'capture-checkpoint': 'capture checkpoint',
  'asset-quality': 'asset analysis',
  'checklist-item': 'checklist item',
};

function SourceList({ sources }: { sources: DeficiencySource[] }) {
  if (sources.length === 0) return <p className="text-xs text-muted-foreground">No citable source signals for this capability.</p>;
  return (
    <ul className="max-h-64 space-y-1.5 overflow-y-auto you-scroll pr-1" aria-label="Source signals">
      {sources.map((s, i) => (
        <li
          key={i}
          className={cn(
            'rounded-md border px-2.5 py-1.5 text-[11.5px] leading-relaxed',
            s.signal === 'negative' && !s.superseded
              ? 'border-red-500/20 bg-red-500/[0.04]'
              : s.signal === 'negative'
                ? 'border-dashed border-zinc-500/25 bg-muted/30'
                : 'border-emerald-500/20 bg-emerald-500/[0.04]',
          )}
        >
          <span className="font-medium">{SOURCE_KIND_LABEL[s.kind]}</span>
          <span className={cn('ml-1.5 font-mono text-[10px] uppercase', s.signal === 'negative' && !s.superseded ? 'text-red-600 dark:text-red-400' : s.signal === 'negative' ? 'text-zinc-500' : 'text-emerald-600 dark:text-emerald-400')}>
            {s.signal}
          </span>
          {s.superseded ? (
            <span className="ml-1.5 rounded border border-zinc-500/25 bg-muted/50 px-1 py-0.5 font-mono text-[9.5px] uppercase tracking-wide text-muted-foreground" title="a real negative record that newer evidence has since resolved — disclosed, not state-affecting">
              superseded by newer evidence
            </span>
          ) : null}
          <p className="mt-0.5 text-muted-foreground">{s.detail}</p>
        </li>
      ))}
    </ul>
  );
}

function RequestEvidenceDialog({
  remedy, capabilityLabel, open, onOpenChange, onViewRequests,
}: {
  remedy: DeficiencyRemedy | null;
  capabilityLabel: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onViewRequests?: () => void;
}) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [instructions, setInstructions] = useState('');
  const [expectedSignal, setExpectedSignal] = useState('');

  // re-seed the prefills each time the dialog opens for a remedy
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (remedy && seededFor !== `${remedy.capability}:${remedy.reason}`) {
    setSeededFor(`${remedy.capability}:${remedy.reason}`);
    setReason(remedy.reason);
    setInstructions(remedy.instructions);
    setExpectedSignal(remedy.expectedSignal);
  }

  const request = useMutation({
    mutationFn: () => api.artifacts.requestEvidence(
      {
        twinVersionId: remedy?.twinVersionId ?? undefined,
        reason: reason.trim(),
        capability: remedy?.capability ?? 'custom',
        instructions: instructions.trim(),
        expectedSignal: expectedSignal.trim(),
        scope: remedy?.scope,
      },
      uid(),
    ),
    onSuccess: (req) => {
      toast.success('Evidence requested', {
        description: `Request targets "${remedy?.capability}" (${capabilityLabel.toLowerCase()}). It appears in this twin's Improve tab.`,
        action: onViewRequests ? { label: 'View requests', onClick: onViewRequests } : undefined,
      });
      void qc.invalidateQueries({ queryKey: ['evidence-requests'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error('Could not create evidence request', { description: err instanceof Error ? err.message : 'Unexpected error' });
    },
  });

  if (!remedy) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Request targeted evidence</DialogTitle>
          <DialogDescription>
            Prefilled from the deficiency map&apos;s suggested remedy — edit before submitting. One request
            authorizes one capture for one stated deficiency
            {remedy.twinVersionId ? ` on the twin version it was diagnosed against` : ''}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3.5">
          <div className="grid gap-1.5">
            <Label htmlFor="dm-reason">Reason</Label>
            <Input id="dm-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={900} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="dm-capability">Affected capability</Label>
            <Input id="dm-capability" value={remedy.capability} readOnly className="font-mono text-[12px] text-muted-foreground" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="dm-instructions">Capture instructions</Label>
            <Textarea id="dm-instructions" value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} maxLength={2000} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="dm-signal">Expected signal</Label>
            <Textarea id="dm-signal" value={expectedSignal} onChange={(e) => setExpectedSignal(e.target.value)} rows={2} maxLength={500} />
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Scope: {remedy.scope}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={request.isPending}>Cancel</Button>
          <Button onClick={() => request.mutate()} disabled={request.isPending || !reason.trim() || !instructions.trim()} className="gap-1.5">
            {request.isPending ? <Activity className="size-3.5 animate-spin" aria-hidden /> : null}
            Create request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CapabilityRow({ row, onRequest }: {
  row: DeficiencyRow;
  onRequest: (row: DeficiencyRow) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="rounded-xl border bg-card px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="min-w-24 text-[13px] font-semibold">{row.label}</span>
        <StateBadge state={row.state} reason={row.reason} />
        {row.state === 'deficient' && row.severity ? <SeverityBadge severity={row.severity} /> : null}
        {row.state === 'ok' ? (
          <span className="rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground" title="signal tier: machine-observed vs declared-only evidence">
            {row.basis}
          </span>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-7 gap-1 px-2.5 text-[11.5px]"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
        >
          <ChevronDown className={cn('size-3.5 transition-transform', !expanded && '-rotate-90')} aria-hidden />
          {row.sources.length} source{row.sources.length === 1 ? '' : 's'}
        </Button>
        {row.remedy ? (
          <Button size="sm" variant="outline" className="h-7 gap-1 px-2.5 text-[11.5px]" onClick={() => onRequest(row)}>
            <Camera className="size-3.5" aria-hidden />
            Request targeted evidence
          </Button>
        ) : null}
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground" title={row.reason}>{row.reason}</p>
      {expanded ? (
        <div className="mt-3 border-t pt-3">
          <SourceList sources={row.sources} />
        </div>
      ) : null}
    </li>
  );
}

export function DeficiencyMap({
  twinId, versions, selectedVersionId, onSelectVersion, hasCaptures, onCapture, onImprove,
}: {
  twinId: string;
  versions: TwinVersionView[];
  selectedVersionId?: string | null;
  onSelectVersion?: (versionId: string) => void;
  hasCaptures: boolean;
  onCapture: () => void;
  onImprove: () => void;
}) {
  const [requestRow, setRequestRow] = useState<DeficiencyRow | null>(null);

  const effectiveVersionId = selectedVersionId ?? versions[0]?.id ?? null;
  const reportQ = useQuery({
    queryKey: ['twin-deficiencies', twinId, effectiveVersionId],
    queryFn: () => api.twins.deficiencies(twinId, effectiveVersionId ? { versionId: effectiveVersionId } : undefined),
    enabled: hasCaptures, // no captures → honest empty state, no fabricated fetch
  });

  const selectedVersion = useMemo(
    () => versions.find((v) => v.id === effectiveVersionId) ?? null,
    [versions, effectiveVersionId],
  );

  // ── honest empty state: no captures yet → not a wall of green ──────────
  if (!hasCaptures) {
    return (
      <div className="space-y-4">
        <EmptyState
          icon={Gauge}
          title="No capture evidence yet"
          hint="The capability map needs real capture evidence before it can say anything. Until then every capability is unknown — by honesty law, never shown as ok."
          action={(
            <Button size="sm" variant="outline" className="gap-1.5" onClick={onCapture}>
              <Camera className="size-3.5" aria-hidden /> Go to Capture
            </Button>
          )}
        />
      </div>
    );
  }

  if (reportQ.isPending) return <RowSkeletons rows={6} />;
  if (reportQ.isError) {
    return (
      <QueryError
        error={reportQ.error}
        title="Could not load the deficiency report"
        onRetry={() => void reportQ.refetch()}
      />
    );
  }

  const { report } = reportQ.data;
  const rows = report.capabilities;

  return (
    <div className="space-y-4">
      {/* header: version scope + summary */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-2.5">
          {versions.length > 0 && onSelectVersion ? (
            <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              Version
              <Select value={effectiveVersionId ?? ''} onValueChange={onSelectVersion}>
                <SelectTrigger size="sm" className="min-w-28" aria-label="Report version">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {versions.map((v) => (
                    <SelectItem key={v.id} value={v.id}>v{v.version} · {v.status}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          ) : (
            <span className="text-xs text-muted-foreground">no reconstructed versions yet</span>
          )}
          <div className="flex items-center gap-1.5" aria-label="capability summary">
            <Badge variant="outline" className="you-num gap-1 border-emerald-500/25 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="size-3" aria-hidden /> {report.summary.ok} ok
            </Badge>
            <Badge variant="outline" className="you-num gap-1 border-red-500/25 bg-red-500/12 text-red-700 dark:text-red-400">
              <TriangleAlert className="size-3" aria-hidden /> {report.summary.deficient} deficient
            </Badge>
            <Badge variant="outline" className="you-num gap-1 border-zinc-500/25 bg-zinc-500/12 text-zinc-600 dark:text-zinc-400">
              <CircleHelp className="size-3" aria-hidden /> {report.summary.unknown} unknown
            </Badge>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {report.twinVersionId ? (
            <span className="you-num">report for v{report.twinVersionNumber}</span>
          ) : (
            <span>capture-level only (not reconstructed)</span>
          )}
          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[11.5px]" onClick={onImprove}>
            <ListChecks className="size-3.5" aria-hidden /> Improve
          </Button>
        </div>
      </div>

      {/* capability rows */}
      <ul className="space-y-2.5" aria-label="Capability quality map">
        {rows.map((row) => (
          <CapabilityRow key={row.capability} row={row} onRequest={setRequestRow} />
        ))}
      </ul>

      {/* honest report-level disclosures */}
      {report.disclosures.length > 0 ? (
        <section className="rounded-xl border border-dashed bg-card/50 px-4 py-3.5">
          <h3 className="flex items-center gap-1.5 text-[12px] font-semibold text-muted-foreground">
            <CircleHelp className="size-3.5" aria-hidden /> Disclosures
          </h3>
          <ul className="mt-2 space-y-1.5">
            {report.disclosures.map((d, i) => (
              <li key={i} className="text-[11.5px] leading-relaxed text-muted-foreground">— {d}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* honesty footnote + provenance */}
      <p className="text-[10.5px] leading-relaxed text-muted-foreground">
        States come only from persisted signals (capture steps, byte-level checkpoints, asset analyses,
        reconstruction deficiency lists). Unknown means unknown — it is never displayed as ok, and no
        quality number is invented. Generated {new Date(report.generatedAt).toLocaleString()}
        {report.twinVersionId ? <> · version <IdChip id={report.twinVersionId} label="" /></> : null}.
      </p>

      <RequestEvidenceDialog
        remedy={requestRow?.remedy ?? null}
        capabilityLabel={requestRow?.label ?? ''}
        open={!!requestRow}
        onOpenChange={(o) => !o && setRequestRow(null)}
        onViewRequests={onImprove}
      />
    </div>
  );
}
