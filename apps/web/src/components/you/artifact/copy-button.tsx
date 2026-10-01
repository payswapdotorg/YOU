'use client';
// Small copy-to-clipboard button used by docs snippets and artifact API tab.
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

export function CopyButton({
  value,
  label = 'Copy',
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          toast.success('Copied to clipboard');
          setTimeout(() => setCopied(false), 1400);
        }).catch(() => toast.error('Copy failed'));
      }}
      className={cn(
        'inline-flex size-7 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground',
        className,
      )}
    >
      {copied ? <Check className="size-3.5 text-emerald-600" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
    </button>
  );
}

/** Preformatted code block with a copy affordance. */
export function CodeBlock({ code, className }: { code: string; className?: string }) {
  return (
    <div className={cn('group relative rounded-lg border bg-muted/40', className)}>
      <div className="absolute right-1.5 top-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <CopyButton value={code} />
      </div>
      <pre className="you-scroll overflow-x-auto p-3 pr-12 font-mono text-[11px] leading-relaxed text-foreground/90">
        {code}
      </pre>
    </div>
  );
}
