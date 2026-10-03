'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Live — honest roadmap surface.
// Re-verified W3.B against the codebase: realtime WebRTC avatar sessions are
// still NOT implemented (no /api/v1/live-sessions route exists; Stage 6).
// What IS real today: the offline loop (twins, captures, performances,
// renders, artifacts), agent avatar sessions with live listening/thinking/
// speaking state visualization, and template persistence + deterministic
// coverage analysis (POST/GET /api/v1/templates, POST /templates/:id/analyze).
// No fake sessions or local-only pseudo-persistence here.
// ═══════════════════════════════════════════════════════════════════════════
import { Radio, Map, ShieldCheck, BadgeCheck } from 'lucide-react';
import { EmptyState, PageHeader, SectionCard } from '@/components/you/shared/primitives';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useYouStore } from '@/hooks/you/use-you-store';

export function LiveView() {
  const navigate = useYouStore((s) => s.navigate);
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
        action={(
          <Button variant="outline" size="sm" onClick={() => navigate('agent-avatars')}>
            See live states in Agent Avatars
          </Button>
        )}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <SectionCard title="What this surface will do" icon={Radio}>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex gap-2"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary/70" aria-hidden />Open live sessions where an agent or human drives a twin in realtime (WebRTC media + performance events).</li>
            <li className="flex gap-2"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary/70" aria-hidden />Show live session state — the same listening / thinking / speaking states the Agent Avatar Studio visualizes today.</li>
            <li className="flex gap-2"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary/70" aria-hidden />Enforce scoped consent per session; every recorded frame references its grant.</li>
          </ul>
        </SectionCard>
        <SectionCard title="What’s real today vs. what’s gated" icon={ShieldCheck}>
          <div className="space-y-3 text-sm text-muted-foreground">
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                <BadgeCheck className="size-3.5" aria-hidden /> Real now
              </div>
              <ul className="space-y-1.5">
                <li>The offline loop — capture → twin → performance → render → artifact — is implemented and inspectable across the Build views.</li>
                <li>Templates persist as versioned manifests (capture checklist, scene recipes, style presets) with deterministic coverage analysis.</li>
                <li>Agent avatar sessions already visualize live listening / thinking / speaking state per turn (Embodiment view).</li>
              </ul>
            </div>
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Map className="size-3.5" aria-hidden /> Still gated (Stage 6)
              </div>
              <ul className="space-y-1.5">
                <li>The realtime transport itself: WebRTC media streams and live performance-event channels do not exist yet — there is no <span className="font-mono text-xs">/api/v1/live-sessions</span> route in this build.</li>
                <li>Live session lifecycle (open / drive / close) and per-session consent enforcement land with that transport.</li>
              </ul>
            </div>
            <p>
              Realtime is an ecosystem capability (Stage 6 — try-on, game exports, realtime WebRTC, AR). Live sessions will reuse the same performance-state contracts the offline loop already exercises.
            </p>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
export default LiveView;
