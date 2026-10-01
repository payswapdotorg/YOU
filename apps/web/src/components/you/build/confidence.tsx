'use client';
// Confidence visualization + honest query error/empty states for Worker B1 views.
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { RotateCw, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { pct } from './format';

function confidenceTone(value: number): string {
  if (value >= 0.7) return 'bg-emerald-500';
  if (value >= 0.4) return 'bg-amber-500';
  return 'bg-red-500';
}

/** Horizontal 0..1 confidence bar with tabular percentage label. */
export function ConfidenceBar({ value, className }: { value: number | null | undefined; className?: string }) {
  const v = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Progress value={v === null ? 0 : v * 100} className="h-1.5 w-full" aria-label="confidence" />
      <span className={cn('you-num w-9 shrink-0 text-right text-xs font-medium tabular-nums', v === null && 'text-muted-foreground')}>
        {v === null ? '—' : pct(v)}
      </span>
    </div>
  );
}

/** Confidence bar whose indicator color reflects the level. */
export function TonedConfidenceBar({ value, className }: { value: number | null | undefined; className?: string }) {
  const v = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full transition-all', v === null ? 'bg-muted-foreground/30' : confidenceTone(v))}
          style={{ width: v === null ? '0%' : `${Math.round(v * 100)}%` }}
        />
      </div>
      <span className={cn('you-num w-9 shrink-0 text-right text-xs font-medium', v === null && 'text-muted-foreground')}>
        {v === null ? '—' : pct(v)}
      </span>
    </div>
  );
}

/** Side-by-side comparison bar for version A vs B. */
export function CompareBar({ a, b }: { a: number | null | undefined; b: number | null | undefined }) {
  const row = (v: number | null | undefined, align: 'left' | 'right') => {
    const val = typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null;
    return (
      <div className={cn('flex items-center gap-2', align === 'right' && 'flex-row-reverse')}>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full transition-all', val === null ? 'bg-muted-foreground/30' : confidenceTone(val))}
            style={{ width: val === null ? '0%' : `${Math.round(val * 100)}%` }}
          />
        </div>
        <span className={cn('you-num w-9 shrink-0 text-xs font-medium', align === 'right' && 'text-right', val === null && 'text-muted-foreground')}>
          {val === null ? '—' : pct(val)}
        </span>
      </div>
    );
  };
  return (
    <div className="grid grid-cols-2 gap-4">
      {row(a, 'left')}
      {row(b, 'right')}
    </div>
  );
}

/** List of per-domain confidence bars (morphology, geometry, …). */
export function DomainConfidenceBars({ byDomain }: { byDomain: Record<string, number> | null | undefined }) {
  const entries = Object.entries(byDomain ?? {});
  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground">No per-domain confidence reported for this version.</p>;
  }
  return (
    <ul className="space-y-2.5">
      {entries.map(([domain, value]) => (
        <li key={domain} className="flex items-center gap-3">
          <span className="w-28 shrink-0 truncate text-xs font-medium text-muted-foreground" title={domain}>{domain}</span>
          <TonedConfidenceBar value={value} className="flex-1" />
        </li>
      ))}
    </ul>
  );
}

/** Big overall confidence stat. */
export function OverallConfidence({ value }: { value: number | null | undefined }) {
  const v = typeof value === 'number' && Number.isFinite(value) ? value : null;
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={cn('you-num text-3xl font-semibold tracking-tight', v === null && 'text-muted-foreground/50')}>
        {v === null ? '—' : pct(v)}
      </span>
      {v !== null ? <span className="text-xs font-medium text-muted-foreground">overall confidence</span> : null}
    </div>
  );
}

const SEVERITY_STYLES: Record<string, string> = {
  high: 'bg-red-500/12 text-red-700 dark:text-red-400 border-red-500/25',
  medium: 'bg-amber-500/12 text-amber-700 dark:text-amber-400 border-amber-500/25',
  low: 'bg-zinc-500/12 text-zinc-600 dark:text-zinc-400 border-zinc-500/25',
};

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <Badge variant="outline" className={cn('you-num shrink-0', SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.low)}>
      {severity}
    </Badge>
  );
}

/** Honest error surface with retry — never substitutes placeholder data. */
export function QueryError({
  error, onRetry, title = 'Could not load data', compact = false,
}: {
  error: unknown; onRetry?: () => void; title?: string; compact?: boolean;
}) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-xl border border-red-500/25 bg-red-500/[0.04] text-center',
        compact ? 'px-4 py-6' : 'px-6 py-12',
      )}
    >
      <TriangleAlert className="size-5 text-red-500" aria-hidden />
      <div className="space-y-1">
        <div className="text-sm font-medium">{title}</div>
        <p className="mx-auto max-w-md break-words text-xs text-muted-foreground">{message}</p>
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5">
          <RotateCw className="size-3.5" aria-hidden /> Retry
        </Button>
      ) : null}
    </div>
  );
}

/** Stat-tile skeletons while the first load is in flight. */
export function StatTileSkeletons({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-xl border bg-card p-5">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="mt-3 h-7 w-14" />
          <Skeleton className="mt-2 h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

/** Row skeletons for tables/lists. */
export function RowSkeletons({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded-lg" />
      ))}
    </div>
  );
}
