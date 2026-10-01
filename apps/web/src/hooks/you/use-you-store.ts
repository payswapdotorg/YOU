'use client';
// YOU Studio app store (TL-owned). Navigation + session state for the shell.
import { create } from 'zustand';
import type { SessionInfo } from '@/lib/you/contracts';

export const VIEW_IDS = [
  'overview', 'twins', 'captures', 'performances', 'templates', 'renders',
  'live', 'agent-avatars', 'develop', 'labs', 'trust', 'usage', 'settings',
  'artifact',
] as const;
export type ViewId = (typeof VIEW_IDS)[number];

export interface ViewParams {
  [key: string]: unknown;
}

interface YouAppState {
  session: SessionInfo | null;
  setSession: (s: SessionInfo | null) => void;
  view: ViewId;
  params: ViewParams | null;
  navigate: (view: ViewId, params?: ViewParams) => void;
  commandOpen: boolean;
  setCommandOpen: (open: boolean) => void;
}

export const useYouStore = create<YouAppState>((set) => ({
  session: null,
  setSession: (session) => set({ session }),
  view: 'overview',
  params: null,
  navigate: (view, params) => set({ view, params: params ?? null }),
  commandOpen: false,
  setCommandOpen: (commandOpen) => set({ commandOpen }),
}));
