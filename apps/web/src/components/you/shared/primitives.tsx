'use client';
// TL-owned shared Studio primitives — consistent across Worker B lanes.
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Copy, Check } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';

export function PageHeader({
  title, description, actions, eyebrow,
}: {
  title: string; description?: string; actions?: React.ReactNode; eyebrow?: string;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-1.5">
        {eyebrow ? (
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{eyebrow}</div>
        ) : null}
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({
  icon: Icon, title, hint, action,
}: { icon: LucideIcon; title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-card/50 px-6 py-14 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-muted">
        <Icon className="size-5 text-muted-foreground" aria-hidden />
      </div>
      <div className="space-y-1">
        <div className="font-medium">{title}</div>
        {hint ? <p className="mx-auto max-w-sm text-sm text-muted-foreground">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}

const STATUS_VARIANTS: Record<string, string> = {
  // job / render / capture statuses
  succeeded: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 border-emerald-500/25',
  complete: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 border-emerald-500/25',
  ready: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 border-emerald-500/25',
  published: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 border-emerald-500/25',
  live: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 border-emerald-500/25',
  delivered: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 border-emerald-500/25',
  failed: 'bg-red-500/12 text-red-700 dark:text-red-400 border-red-500/25',
  // P6.B8: circuit-breaker states (metrics surface) — closed is the healthy
  // resting state; open/half-open are the cooling-down states.
  closed: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 border-emerald-500/25',
  'half-open': 'bg-amber-500/12 text-amber-700 dark:text-amber-400 border-amber-500/25',
  // P6.B8: terminal dead-letter state — a dead job exhausted its bounded
  // retry budget (distinct from failed); terminal-red, no pulse.
  dead: 'bg-red-500/12 text-red-700 dark:text-red-400 border-red-500/25',
  cancelled: 'bg-red-500/12 text-red-700 dark:text-red-400 border-red-500/25',
  revoked: 'bg-red-500/12 text-red-700 dark:text-red-400 border-red-500/25',
  error: 'bg-red-500/12 text-red-700 dark:text-red-400 border-red-500/25',
  queued: 'bg-zinc-500/12 text-zinc-600 dark:text-zinc-400 border-zinc-500/25',
  pending: 'bg-zinc-500/12 text-zinc-600 dark:text-zinc-400 border-zinc-500/25',
  draft: 'bg-zinc-500/12 text-zinc-600 dark:text-zinc-400 border-zinc-500/25',
  open: 'bg-amber-500/12 text-amber-700 dark:text-amber-400 border-amber-500/25',
  running: 'bg-amber-500/12 text-amber-700 dark:text-amber-400 border-amber-500/25',
  analyzing: 'bg-amber-500/12 text-amber-700 dark:text-amber-400 border-amber-500/25',
  uploading: 'bg-amber-500/12 text-amber-700 dark:text-amber-400 border-amber-500/25',
  provisioning: 'bg-amber-500/12 text-amber-700 dark:text-amber-400 border-amber-500/25',
  collecting: 'bg-amber-500/12 text-amber-700 dark:text-amber-400 border-amber-500/25',
  research: 'bg-violet-500/12 text-violet-700 dark:text-violet-400 border-violet-500/25',
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const variant = STATUS_VARIANTS[status] ?? 'bg-zinc-500/12 text-zinc-600 dark:text-zinc-400 border-zinc-500/25';
  return (
    <Badge variant="outline" className={cn('you-num', variant, className)}>
      {status === 'running' || status === 'analyzing' || status === 'uploading' || status === 'provisioning' || status === 'collecting' ? (
        <span className="you-pulse mr-1 inline-block size-1.5 rounded-full bg-current" aria-hidden />
      ) : null}
      {status}
    </Badge>
  );
}

export function IdChip({ id, label, className }: { id: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(id).then(() => {
          setCopied(true);
          toast.success(`${label ?? 'ID'} copied`);
          setTimeout(() => setCopied(false), 1400);
        }).catch(() => toast.error('Copy failed'));
      }}
      className={cn(
        'you-focus group inline-flex max-w-full items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground',
        className,
      )}
      title={`Copy ${label ?? 'ID'}`}
    >
      <span className="truncate">{label ? `${label} ` : ''}{id}</span>
      {copied ? <Check className="size-3 shrink-0 text-emerald-600" aria-hidden /> : <Copy className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />}
    </button>
  );
}

export function SectionCard({
  title, description, actions, children, className, icon: Icon,
}: {
  title: string; description?: string; actions?: React.ReactNode;
  children: React.ReactNode; className?: string; icon?: LucideIcon;
}) {
  return (
    <section className={cn('rounded-xl border bg-card text-card-foreground shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            {Icon ? <Icon className="size-4 text-muted-foreground" aria-hidden /> : null}
            <div>
              <h2 className="text-sm font-semibold">{title}</h2>
              {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
            </div>
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function KeyValue({ items }: { items: { label: string; value: React.ReactNode }[] }) {
  return (
    <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
      {items.map((it) => (
        <div key={it.label} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{it.label}</dt>
          <dd className="mt-0.5 truncate text-sm">{it.value ?? <span className="text-muted-foreground">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}
