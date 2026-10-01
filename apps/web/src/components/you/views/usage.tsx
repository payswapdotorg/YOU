'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Usage & Billing — real metered usage from the developer platform.
// Free-tier development environment notice (DEPLOYMENT.md): free tiers are
// development accelerators only, never hard dependencies. No fake pricing.
// ═══════════════════════════════════════════════════════════════════════════
import { CreditCard, Info, Leaf } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { PageHeader, SectionCard } from '@/components/you/shared/primitives';
import { UsagePanel } from '@/components/you/develop/usage-panel';

export function UsageView() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Account"
        title="Usage & Billing"
        description="Metered platform usage for this tenant — evidence storage, jobs, renders and LLM calls."
        actions={<Badge variant="outline" className="gap-1.5 text-muted-foreground"><Leaf className="size-3" aria-hidden /> development environment</Badge>}
      />

      <UsagePanel />

      <SectionCard title="Environment" description="How this deployment is metered" icon={Info}>
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Free-tier development environment.</span> This deployment
            runs on development-tier infrastructure. Free tiers are optional accelerators for development only — they
            are never hard dependencies of YOU (AGENTS.md): every adapter remains swappable and provider-neutral.
          </p>
          <p>
            No billing is enabled in this environment and no pricing is implied by the numbers above — they are raw
            metered quantities, not invoices.
          </p>
        </div>
      </SectionCard>

      <SectionCard
        title="Plans"
        description="Commercial terms — not active"
        icon={CreditCard}
        actions={<Badge variant="outline" className="border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-400">not active</Badge>}
      >
        <div className="rounded-lg border border-dashed px-4 py-6 text-center">
          <p className="mx-auto max-w-xl text-sm text-muted-foreground">
            YOU is infrastructure: plans and commercial terms attach per tenant deployment (compute class, storage
            volume, provider policy). None are active here, and no pricing data is displayed because none exists —
            showing invented tiers would violate the no-fake-data rule.
          </p>
        </div>
      </SectionCard>
    </div>
  );
}
export default UsageView;
