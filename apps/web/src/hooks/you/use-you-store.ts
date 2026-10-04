'use client';
// YOU Studio app store (TL-owned). Navigation + session state for the shell.
import { create } from 'zustand';
import type { SessionInfo } from '@/lib/you/contracts';

export const VIEW_IDS = [
  'overview', 'twins', 'captures', 'evidence-requests', 'performances', 'templates', 'renders',
  'live', 'agent-avatars', 'develop', 'labs', 'trust', 'usage', 'settings',
  'artifact',
] as const;
export type ViewId = (typeof VIEW_IDS)[number];

export interface ViewParams {
  [key: string]: unknown;
}

interface YouAppState {
  session: SessionInfo | null;
  // P6.B2 — honest bootstrap-failure surface: set when BOTH session.get and
  // session.create failed at shell startup; cleared by any successful setSession.
  sessionError: string | null;
  setSession: (s: SessionInfo | null) => void;
  setSessionError: (message: string | null) => void;
  view: ViewId;
  params: ViewParams | null;
  navigate: (view: ViewId, params?: ViewParams) => void;
  commandOpen: boolean;
  setCommandOpen: (open: boolean) => void;
}

export const useYouStore = create<YouAppState>((set) => ({
  session: null,
  sessionError: null,
  setSession: (session) => set({ session, sessionError: null }),
  setSessionError: (sessionError) => set({ sessionError }),
  view: 'overview',
  params: null,
  navigate: (view, params) => set({ view, params: params ?? null }),
  commandOpen: false,
  setCommandOpen: (commandOpen) => set({ commandOpen }),
}));
