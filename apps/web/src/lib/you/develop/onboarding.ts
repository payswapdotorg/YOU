// ═══════════════════════════════════════════════════════════════════════════
// YOU Studio — onboarding tour state (P6.B9, Worker B lane).
//
// A first-run guided walkthrough of the primary flow:
//   Build → capture → review → compile → render → artifact → Develop.
// Every stop links to a REAL Studio view (the shell's ViewId set) — no fake
// steps, no invented surfaces. Dismissible; persisted PER USER.
//
// Persistence semantics (honest, disclosed): state lives in the browser's
// localStorage under a per-user key (`you.onboarding.v1:<userId>`). Frozen
// API v1 has no server-side UI-state surface, so this is per-browser
// per-user persistence — a fresh browser shows the tour again. The state
// machine, key derivation and (in)validation are PURE and tested; the
// storage adapter is injectable so node:test exercises the same code the
// browser runs (localStorage is just one adapter).
//
// Type-only import (erased at runtime — the node:test law): the ViewId
// union keeps stop definitions honest against the shell without pulling the
// store into this module at runtime.
// ═══════════════════════════════════════════════════════════════════════════
import type { ViewId } from '@/hooks/you/use-you-store';

/** The tour's storage adapter (localStorage in the browser, a fake in tests). */
export interface TourStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type TourState = 'unseen' | 'active' | 'dismissed' | 'completed';

export interface TourStop {
  id: string;
  /** The real Studio view this stop links to (shell ViewId). */
  viewId: ViewId;
  /** Short stop title. */
  title: string;
  /** One honest sentence about what happens at this stage. */
  body: string;
  /** Label for the jump-to-view action. */
  ctaLabel: string;
}

/**
 * The primary flow, as it actually exists in the Studio:
 * - Build:        Twins view — create a Twin (the consent gate chains in).
 * - Capture:      Captures view — capture sessions with immutable, consent-gated evidence.
 * - Review:       Captures view — open a session: checklist, quality, F1 review.
 * - Compile:      Twins view (detail) — compile evidence into an HTIR TwinVersion.
 * - Render:       Renders view — render a TwinVersion (durable job, real progress).
 * - Artifact:     Solution Artifact view — the portable review surface.
 * - Develop:      API & Tools view — keys, events, playground, examples, docs.
 */
export const TOUR_STOPS: readonly TourStop[] = [
  {
    id: 'build',
    viewId: 'twins',
    title: 'Build a Twin',
    body: 'Start in Twins: create the subject everything else builds on. Creating a Twin chains straight into the consent gate.',
    ctaLabel: 'Open Twins',
  },
  {
    id: 'capture',
    viewId: 'captures',
    title: 'Capture evidence',
    body: 'Capture sessions collect immutable, consent-gated evidence against a Twin — uploads are region-tagged and quality-analyzed.',
    ctaLabel: 'Open Captures',
  },
  {
    id: 'review',
    viewId: 'captures',
    title: 'Review the capture',
    body: 'Open a capture session to review its checklist, asset quality and the guided F1 review that promotes a TwinVersion.',
    ctaLabel: 'Open Captures',
  },
  {
    id: 'compile',
    viewId: 'twins',
    title: 'Compile a version',
    body: 'From a Twin’s detail view, compile captured evidence into an immutable HTIR TwinVersion — a durable job with real progress.',
    ctaLabel: 'Open Twins',
  },
  {
    id: 'render',
    viewId: 'renders',
    title: 'Render',
    body: 'Renders turn a TwinVersion into image or video artifacts through the render adapters — each render is a job you can watch.',
    ctaLabel: 'Open Renders',
  },
  {
    id: 'artifact',
    viewId: 'artifact',
    title: 'Share the artifact',
    body: 'The Solution Artifact is the portable review surface over canonical data — provenance, evidence and consent in one manifest.',
    ctaLabel: 'Open Artifact',
  },
  {
    id: 'develop',
    viewId: 'develop',
    title: 'Develop against the API',
    body: 'API keys, the executable v1 playground, official example flows and the full reference — HTTP, SDK and MCP share one authority.',
    ctaLabel: 'Open API & Tools',
  },
];

export const TOUR_VERSION = 1;

/** The per-user storage key. */
export function tourStorageKey(userId: string): string {
  return `you.onboarding.v${TOUR_VERSION}:${userId}`;
}

/**
 * Read a user's tour state. Unknown/corrupt payloads resolve to 'unseen'
 * (an honest fresh start — never a crash, never a silent skip).
 */
export function readTourState(storage: TourStorage, userId: string): TourState {
  let raw: string | null = null;
  try {
    raw = storage.getItem(tourStorageKey(userId));
  } catch {
    return 'unseen'; // storage unavailable (private mode &c.) — treat as first run
  }
  if (!raw) return 'unseen';
  try {
    const parsed = JSON.parse(raw) as { state?: unknown };
    if (parsed && typeof parsed === 'object' && typeof parsed.state === 'string'
      && ['unseen', 'active', 'dismissed', 'completed'].includes(parsed.state)) {
      return parsed.state as TourState;
    }
    return 'unseen';
  } catch {
    return 'unseen'; // corrupt JSON — honest reset
  }
}

/** Persist a user's tour state (write failures are swallowed: the tour is cosmetic). */
export function writeTourState(storage: TourStorage, userId: string, state: TourState): void {
  try {
    storage.setItem(tourStorageKey(userId), JSON.stringify({ state, v: TOUR_VERSION }));
  } catch {
    /* storage unavailable — the tour simply won't persist this session */
  }
}

/** Whether the first-run walkthrough should be shown for this state. */
export function shouldShowTour(state: TourState): boolean {
  return state === 'unseen' || state === 'active';
}

/** Mark the tour dismissed (the X / Skip action). */
export function dismissTour(storage: TourStorage, userId: string): void {
  writeTourState(storage, userId, 'dismissed');
}

/** Mark the tour completed (the Finish action). */
export function completeTour(storage: TourStorage, userId: string): void {
  writeTourState(storage, userId, 'completed');
}

/** Reset the tour to first-run state (the Develop → Docs restart affordance). */
export function resetTour(storage: TourStorage, userId: string): void {
  writeTourState(storage, userId, 'unseen');
}

/**
 * Validate the tour definition itself — the "no fake steps" law as code.
 * Throws on: empty tour, a stop without a known view, duplicate stop ids,
 * or empty title/body/cta. Used by the contract tests; also safe to call at
 * module scope of the UI (it is pure).
 */
export function assertTourDefinitionValid(stops: readonly TourStop[], knownViewIds: readonly string[]): void {
  if (!stops.length) throw new Error('tour definition is empty');
  const ids = new Set<string>();
  for (const stop of stops) {
    if (!stop.id || ids.has(stop.id)) throw new Error(`invalid or duplicate tour stop id: ${stop.id}`);
    ids.add(stop.id);
    if (!knownViewIds.includes(stop.viewId)) {
      throw new Error(`tour stop "${stop.id}" links to unknown view "${stop.viewId}"`);
    }
    if (!stop.title.trim() || !stop.body.trim() || !stop.ctaLabel.trim()) {
      throw new Error(`tour stop "${stop.id}" has empty copy`);
    }
  }
}
