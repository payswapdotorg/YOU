'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Official examples panel (P6.B9) — the canonical platform flows as copyable
// SDK snippet cards. Every snippet is derived from the REAL routes only:
// the flow's `operations` badges are frozen-inventory references, and the
// TS code compiles against @you/sdk-js's real types (the examples-compile.ts
// mirror, enforced by the contract tests — no invented endpoints).
// ═══════════════════════════════════════════════════════════════════════════
import { GraduationCap } from 'lucide-react';
import { EXAMPLE_FLOWS } from '@/lib/you/develop/examples';
import { Badge } from '@/components/ui/badge';
import { SectionCard } from '@/components/you/shared/primitives';
import { CodeBlock } from '@/components/you/artifact/copy-button';

export function ExamplesPanel() {
  return (
    <div className="space-y-4">
      <SectionCard
        title="Official examples"
        description="Canonical flows as typed @you/sdk-js snippets — bootstrap, twin, capture, compile, render, artifact, evidence loop. They compile against the SDK's real types; the routes they hit are the frozen v1 inventory."
        icon={GraduationCap}
      >
        <p className="text-xs text-muted-foreground">
          Install the SDK from the monorepo (<span className="font-mono">packages/sdk-js</span>) and keep the idempotency
          keys flowing — mutating calls accept <span className="font-mono">x-idempotency-key</span> so retries stay safe.
        </p>
      </SectionCard>

      {EXAMPLE_FLOWS.map((flow) => (
        <SectionCard
          key={flow.id}
          title={flow.title}
          description={flow.description}
        >
          <div className="mb-3 flex flex-wrap gap-1.5">
            {flow.operations.map((ref) => {
              const [method, ...rest] = ref.split(' ');
              return (
                <Badge
                  key={ref}
                  variant="outline"
                  className={`font-mono text-[9px] ${method === 'GET' ? 'border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400' : 'border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-400'}`}
                  title={`${method} ${rest.join(' ')} — frozen v1 inventory`}
                >
                  {method} {rest.join(' ')}
                </Badge>
              );
            })}
          </div>
          <CodeBlock code={flow.code} />
        </SectionCard>
      ))}
    </div>
  );
}
