'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Live — honest roadmap surface.
// Realtime WebRTC avatar sessions unlock in Stage 6 (ecosystem).
// No fake sessions or local-only pseudo-persistence here.
// ═══════════════════════════════════════════════════════════════════════════
import { Radio, Map, ShieldCheck } from 'lucide-react';
import { EmptyState, PageHeader, SectionCard } from '@/components/you/shared/primitives';
import { Badge } from '@/components/ui/badge';

export function LiveView() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Build"
        title="Live"
        description="Realtime, interactive avatar sessions over WebRTC — a twin driven by live performance state."
        actions={<Badge variant="outline" className="gap-1.5 text-muted-foreground"><Map className="size-3" aria-hidden /> Stage 6</Badge>}
      />

      <EmptyState
        icon={Radio}
        title="Live sessions arrive in Stage 6"
        hint="Live WebRTC sessions will stream performance state — gaze, expression, speech — to a realtime-rendered twin, with consent scopes enforced per session."
      />

      <div className="grid gap-4 md:grid-cols-2">
        <SectionCard title="What this surface will do" icon={Radio}>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex gap-2"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary/70" aria-hidden />Open live sessions where an agent or human drives a twin in realtime (WebRTC media + performance events).</li>
            <li className="flex gap-2"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary/70" aria-hidden />Show live session state — the same listening / thinking / speaking states the Agent Avatar Studio visualizes today.</li>
            <li className="flex gap-2"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary/70" aria-hidden />Enforce scoped consent per session; every recorded frame references its grant.</li>
          </ul>
        </SectionCard>
        <SectionCard title="Why it’s gated" icon={ShieldCheck}>
          <p className="text-sm text-muted-foreground">
            Realtime transport is an ecosystem capability (Stage 6 — try-on, game exports, realtime WebRTC, AR). The
            offline loop — capture → twin → performance → render → artifact — lands first, and live sessions reuse the
            same performance-state contracts.
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            Roadmap reference:{' '}
            <span className="rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-xs text-foreground/80">docs/IMPLEMENTATION_PLAN.md</span>{' '}
            — Stage 6 · ecosystem.
          </p>
        </SectionCard>
      </div>
    </div>
  );
}
export default LiveView;
