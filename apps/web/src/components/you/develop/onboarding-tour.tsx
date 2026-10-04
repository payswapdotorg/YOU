'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Onboarding tour (P6.B9) — a first-run guided walkthrough of the primary
// flow: Build → capture → review → compile → render → artifact → Develop.
//
// Honesty laws:
// - every stop links to a REAL Studio view (assertTourDefinitionValid is
//   exercised by the contract tests against the shell's ViewId set);
// - dismissible (X, Skip, Escape) and persisted PER USER (localStorage,
//   keyed by the session user id — frozen v1 has no server-side UI-state
//   surface; per-browser persistence, disclosed);
// - no fake steps, no progress theater — the tour is just navigation help.
//
// Structure (lint-law: no setState inside effect bodies):
// - OnboardingTour gates on the session (null during SSR and hydration — the
//   shell's bootstrap is an effect, so the card is never server-rendered and
//   cannot hydration-mismatch);
// - TourCard is KEYED by user id: a fresh user remounts it, and its lazy
//   state initializer reads the per-user persisted tour state exactly once,
//   on the client only. All later setState happens in event callbacks.
//
// Restart affordance: the Develop → Docs panel dispatches the
// 'you:tour-restart' window event; this component owns all tour state.
// ═══════════════════════════════════════════════════════════════════════════
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Compass, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useYouStore } from '@/hooks/you/use-you-store';
import {
  TOUR_STOPS, completeTour, dismissTour, readTourState, resetTour, shouldShowTour, writeTourState,
} from '@/lib/you/develop/onboarding';

export const TOUR_RESTART_EVENT = 'you:tour-restart';

export function OnboardingTour() {
  const session = useYouStore((s) => s.session);
  const userId = session?.user?.id;
  if (!userId) return null;
  return <TourCard key={userId} userId={userId} />;
}

function TourCard({ userId }: { userId: string }) {
  const navigate = useYouStore((s) => s.navigate);

  // Read the persisted per-user state exactly once, at first client render
  // (the parent guarantees this component never renders on the server).
  const [visible, setVisible] = useState(() => {
    const state = readTourState(window.localStorage, userId);
    if (state === 'unseen') writeTourState(window.localStorage, userId, 'active');
    return shouldShowTour(state);
  });
  const [stepIndex, setStepIndex] = useState(0);
  const ctaRef = useRef<HTMLButtonElement>(null);

  const close = useCallback((final: 'dismissed' | 'completed') => {
    setVisible(false);
    if (final === 'dismissed') dismissTour(window.localStorage, userId);
    else completeTour(window.localStorage, userId);
  }, [userId]);

  // Restart affordance (Develop → Docs) — setState lives in the event
  // callback, never in the effect body.
  useEffect(() => {
    const onRestart = () => {
      resetTour(window.localStorage, userId);
      setStepIndex(0);
      setVisible(true);
    };
    window.addEventListener(TOUR_RESTART_EVENT, onRestart);
    return () => window.removeEventListener(TOUR_RESTART_EVENT, onRestart);
  }, [userId]);

  // Escape dismisses; the CTA takes focus when a stop opens (keyboard path).
  // No state is set synchronously in the body — only subscriptions + DOM.
  useEffect(() => {
    if (!visible) return;
    ctaRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close('dismissed');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, stepIndex, close]);

  if (!visible) return null;

  const stop = TOUR_STOPS[stepIndex];
  const isLast = stepIndex === TOUR_STOPS.length - 1;

  return (
    <aside
      aria-label={`Getting started — step ${stepIndex + 1} of ${TOUR_STOPS.length}: ${stop.title}`}
      className="fixed bottom-4 right-4 z-50 w-[calc(100vw-2rem)] max-w-sm rounded-xl border bg-card p-4 shadow-lg sm:bottom-6 sm:right-6"
    >
      <div className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/30">
          <Compass className="size-4 text-primary" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Getting started</span>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              {stepIndex + 1} / {TOUR_STOPS.length}
            </span>
          </div>
          <h2 className="mt-1 text-sm font-semibold">{stop.title}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{stop.body}</p>
        </div>
        <Button
          variant="ghost" size="icon" className="you-focus -mr-1 -mt-1 size-7 shrink-0 text-muted-foreground"
          onClick={() => close('dismissed')}
          aria-label="Dismiss the guided tour"
        >
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      <div className="mt-3.5 flex flex-wrap items-center gap-2" aria-hidden>
        {TOUR_STOPS.map((s, i) => (
          <span
            key={s.id}
            className={cn(
              'h-1.5 rounded-full transition-all',
              i === stepIndex ? 'w-5 bg-primary' : i < stepIndex ? 'w-1.5 bg-primary/50' : 'w-1.5 bg-border',
            )}
          />
        ))}
      </div>

      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <Button
          ref={ctaRef}
          size="sm"
          className="gap-1.5"
          onClick={() => navigate(stop.viewId)}
        >
          {stop.ctaLabel}
          <ArrowRight className="size-3.5" aria-hidden />
        </Button>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => close('dismissed')}>
            Skip
          </Button>
          {stepIndex > 0 ? (
            <Button variant="outline" size="icon" className="you-focus size-8" onClick={() => setStepIndex((i) => Math.max(0, i - 1))} aria-label="Previous stop">
              <ArrowLeft className="size-3.5" aria-hidden />
            </Button>
          ) : null}
          {isLast ? (
            <Button size="sm" className="gap-1.5" onClick={() => close('completed')}>
              <Check className="size-3.5" aria-hidden /> Finish
            </Button>
          ) : (
            <Button variant="outline" size="sm" className="you-focus gap-1.5" onClick={() => setStepIndex((i) => Math.min(TOUR_STOPS.length - 1, i + 1))}>
              Next <ArrowRight className="size-3.5" aria-hidden />
            </Button>
          )}
        </div>
      </div>
    </aside>
  );
}
