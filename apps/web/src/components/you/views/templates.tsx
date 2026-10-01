'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Templates — honest roadmap surface.
// Template ingestion & scene recipes unlock in Stage 3 (docs/IMPLEMENTATION_PLAN.md).
// No pseudo-content is rendered here: no fake templates, no local-only state.
// ═══════════════════════════════════════════════════════════════════════════
import { LayoutTemplate, Map, ShieldCheck } from 'lucide-react';
import { EmptyState, PageHeader, SectionCard } from '@/components/you/shared/primitives';
import { Badge } from '@/components/ui/badge';

export function TemplatesView() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Build"
        title="Templates"
        description="Reusable capture templates and scene recipes — parameterized starting points for performances and renders."
        actions={<Badge variant="outline" className="gap-1.5 text-muted-foreground"><Map className="size-3" aria-hidden /> Stage 3</Badge>}
      />

      <EmptyState
        icon={LayoutTemplate}
        title="Template ingestion arrives in Stage 3"
        hint="Templates will package capture checklists, scene composition and performance recipes so a proven capture-and-render flow can be reused across subjects."
      />

      <div className="grid gap-4 md:grid-cols-2">
        <SectionCard title="What this surface will do" icon={LayoutTemplate}>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex gap-2"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary/70" aria-hidden />Ingest template manifests (capture checklists, scene parameters, style presets) as versioned records.</li>
            <li className="flex gap-2"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary/70" aria-hidden />Instantiate a template against a twin — pre-filling capture sessions and performance scaffolds.</li>
            <li className="flex gap-2"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary/70" aria-hidden />Analyze template coverage: which capabilities a template exercises, and which it leaves to targeted evidence.</li>
          </ul>
        </SectionCard>
        <SectionCard title="Why it’s gated" icon={ShieldCheck}>
          <p className="text-sm text-muted-foreground">
            Templates depend on the Stage 3 exit gate — “Twin + Performance + Template → playable artifact”. The
            performance plane and render adapters land first (<span className="font-mono text-xs">performances</span>,{' '}
            <span className="font-mono text-xs">renders</span>); template ingestion builds on that compiler path.
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            Roadmap reference: <span className="rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-xs text-foreground/80">docs/IMPLEMENTATION_PLAN.md</span>{' '}
            — Stage 3 · Performance and rendering.
          </p>
        </SectionCard>
      </div>
    </div>
  );
}
export default TemplatesView;
