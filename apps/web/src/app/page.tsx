'use client';
// ═══════════════════════════════════════════════════════════════════════════
// YOU Studio — application shell (TL-owned).
// Single-route dashboard: the Experience plane over canonical backend state.
// Views are owned by Worker B lanes (docs/WORKER_B.md).
// ═══════════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import {
  LayoutGrid, UserRound, Camera, Drama, LayoutTemplate, ImageIcon, Radio,
  Bot, KeyRound, FlaskConical, ShieldCheck, CreditCard, Settings, Search,
  Menu, Moon, Sun, Plus, ChevronRight, Activity,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import { cn } from '@/lib/utils';
import { useYouStore, type ViewId } from '@/hooks/you/use-you-store';
import { api } from '@/lib/you/client/api';
import { Toaster } from '@/components/ui/sonner';

import { OverviewView } from '@/components/you/views/overview';
import { TwinsView } from '@/components/you/views/twins';
import { CapturesView } from '@/components/you/views/captures';
import { PerformancesView } from '@/components/you/views/performances';
import { TemplatesView } from '@/components/you/views/templates';
import { RendersView } from '@/components/you/views/renders';
import { LiveView } from '@/components/you/views/live';
import { AgentAvatarsView } from '@/components/you/views/agent-avatars';
import { DevelopView } from '@/components/you/views/develop';
import { LabsView } from '@/components/you/views/labs';
import { TrustView } from '@/components/you/views/trust';
import { UsageView } from '@/components/you/views/usage';
import { SettingsView } from '@/components/you/views/settings';
import { ArtifactView } from '@/components/you/views/artifact';

const NAV: { section?: string; items: { id: ViewId; label: string; icon: typeof LayoutGrid }[] }[] = [
  { items: [{ id: 'overview', label: 'Overview', icon: LayoutGrid }] },
  {
    section: 'Build',
    items: [
      { id: 'twins', label: 'Twins', icon: UserRound },
      { id: 'captures', label: 'Captures', icon: Camera },
      { id: 'performances', label: 'Performances', icon: Drama },
      { id: 'templates', label: 'Templates', icon: LayoutTemplate },
      { id: 'renders', label: 'Renders', icon: ImageIcon },
      { id: 'live', label: 'Live', icon: Radio },
    ],
  },
  { section: 'Embodiment', items: [{ id: 'agent-avatars', label: 'Agent Avatars', icon: Bot }] },
  {
    section: 'Develop',
    items: [
      { id: 'develop', label: 'API & Tools', icon: KeyRound },
      { id: 'labs', label: 'Labs', icon: FlaskConical },
    ],
  },
  { section: 'Trust', items: [{ id: 'trust', label: 'Consent & Provenance', icon: ShieldCheck }] },
  {
    section: 'Account',
    items: [
      { id: 'usage', label: 'Usage & Billing', icon: CreditCard },
      { id: 'settings', label: 'Settings', icon: Settings },
    ],
  },
];

const VIEW_TITLES: Record<ViewId, string> = {
  overview: 'Overview', twins: 'Twins', captures: 'Captures', performances: 'Performances',
  templates: 'Templates', renders: 'Renders', live: 'Live', 'agent-avatars': 'Agent Avatars',
  develop: 'API & Tools', labs: 'Labs', trust: 'Consent & Provenance', usage: 'Usage & Billing',
  settings: 'Settings', artifact: 'Solution Artifact',
};

const VIEWS: Record<ViewId, React.ComponentType> = {
  overview: OverviewView, twins: TwinsView, captures: CapturesView,
  performances: PerformancesView, templates: TemplatesView, renders: RendersView,
  live: LiveView, 'agent-avatars': AgentAvatarsView, develop: DevelopView,
  labs: LabsView, trust: TrustView, usage: UsageView, settings: SettingsView,
  artifact: ArtifactView,
};

function Logo() {
  return (
    <div className="flex items-center gap-2.5 px-2">
      <div className="flex size-7 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/30">
        <span className="font-mono text-[13px] font-bold text-primary">Y</span>
      </div>
      <div className="leading-none">
        <div className="text-[13px] font-semibold tracking-wide text-sidebar-foreground">YOU</div>
        <div className="mt-0.5 text-[9.5px] uppercase tracking-[0.18em] text-sidebar-foreground/45">Reality Infrastructure</div>
      </div>
    </div>
  );
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const { view, navigate } = useYouStore();
  return (
    <nav aria-label="Primary" className="flex flex-1 flex-col gap-5 overflow-y-auto you-scroll px-2 py-4">
      {NAV.map((group, i) => (
        <div key={group.section ?? 'root'} className="space-y-0.5">
          {group.section ? (
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-sidebar-foreground/35">
              {group.section}
            </div>
          ) : null}
          {group.items.map((item) => {
            const active = view === item.id || (item.id === 'twins' && view === 'artifact');
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => { navigate(item.id); onNavigate?.(); }}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] font-medium transition-colors',
                  active
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground shadow-none'
                    : 'text-sidebar-foreground/65 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                )}
              >
                <item.icon className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{item.label}</span>
                {active ? <ChevronRight className="ml-auto size-3.5 opacity-50" aria-hidden /> : null}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function SidebarFooter() {
  const { session } = useYouStore();
  return (
    <div className="border-t border-sidebar-border px-3 py-3">
      <div className="flex items-center gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-[11px] font-semibold text-sidebar-accent-foreground">
          {(session?.user.name ?? 'YU').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()}
        </div>
        <div className="min-w-0 leading-tight">
          <div className="truncate text-xs font-medium text-sidebar-foreground">{session?.user.name ?? 'Studio'}</div>
          <div className="truncate text-[10px] text-sidebar-foreground/50">{session?.tenant.name ?? 'local environment'}</div>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between rounded-md bg-sidebar-accent/50 px-2 py-1.5">
        <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-sidebar-foreground/55">
          <Activity className="size-3" aria-hidden /> env: local
        </span>
        <span className="font-mono text-[9.5px] text-sidebar-foreground/40">API v1</span>
      </div>
    </div>
  );
}

function ThemeToggle() {
  const { setTheme } = useTheme();
  return (
    <Button
      variant="ghost" size="icon" aria-label="Toggle theme"
      className="text-muted-foreground"
      onClick={() => setTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark')}
    >
      <Sun className="size-4 dark:hidden" aria-hidden />
      <Moon className="hidden size-4 dark:block" aria-hidden />
    </Button>
  );
}

function CommandPalette() {
  const { commandOpen, setCommandOpen, navigate } = useYouStore();
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setCommandOpen(!commandOpen); }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [commandOpen, setCommandOpen]);

  const run = (fn: () => void) => { setCommandOpen(false); fn(); };
  const groups = NAV.filter((g) => g.section).flatMap((g) => g.items.map((it) => ({ ...it, section: g.section! })));

  return (
    <CommandDialog open={commandOpen} onOpenChange={setCommandOpen}>
      <CommandInput placeholder="Search the studio — views, actions, objects…" />
      <CommandList className="you-scroll">
        <CommandEmpty>No matches found.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => run(() => navigate('twins', { action: 'create' }))}>
            <Plus className="size-4" aria-hidden /> Create Twin
          </CommandItem>
          <CommandItem onSelect={() => run(() => navigate('captures'))}>
            <Camera className="size-4" aria-hidden /> Review captures
          </CommandItem>
          <CommandItem onSelect={() => run(() => navigate('agent-avatars'))}>
            <Bot className="size-4" aria-hidden /> Start agent avatar session
          </CommandItem>
          <CommandItem onSelect={() => run(() => navigate('labs'))}>
            <FlaskConical className="size-4" aria-hidden /> Run Lab benchmark
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Go to">
          {groups.map((it) => (
            <CommandItem key={it.id} value={`${it.section} ${it.label}`} onSelect={() => run(() => navigate(it.id))}>
              <it.icon className="size-4" aria-hidden /> {it.label}
              <span className="ml-auto text-[10px] text-muted-foreground">{it.section}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

function Shell() {
  const { view, navigate, setSession, session } = useYouStore();
  const [mobileOpen, setMobileOpen] = useState(false);
  const ActiveView = useMemo(() => VIEWS[view] ?? VIEWS.overview, [view]);

  useEffect(() => {
    let cancelled = false;
    api.session.get().then((s) => { if (!cancelled) setSession(s); }).catch(() => {
      api.session.create().then((s) => { if (!cancelled) setSession(s); }).catch(() => {});
    });
    return () => { cancelled = true; };
  }, [setSession]);

  return (
    <div className="flex min-h-screen w-full">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground lg:flex">
        <div className="flex h-14 items-center border-b border-sidebar-border px-3"><Logo /></div>
        <SidebarNav />
        <SidebarFooter />
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur sm:px-5">
          {/* Mobile nav */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation">
                <Menu className="size-5" aria-hidden />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 bg-sidebar p-0 text-sidebar-foreground [&>button]:text-sidebar-foreground">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <div className="flex h-14 items-center border-b border-sidebar-border px-3"><Logo /></div>
              <SidebarNav onNavigate={() => setMobileOpen(false)} />
              <SidebarFooter />
            </SheetContent>
          </Sheet>

          <div className="min-w-0 flex-1">
            <div className="hidden items-center gap-1.5 text-[11px] text-muted-foreground sm:flex">
              <span className="font-medium text-foreground">{session?.tenant.name ?? 'YOU'}</span>
              <ChevronRight className="size-3" aria-hidden />
              <span>{VIEW_TITLES[view]}</span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => useYouStore.getState().setCommandOpen(true)}
            className="flex h-9 items-center gap-2 rounded-md border bg-card px-3 text-sm text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground"
            aria-label="Open search"
          >
            <Search className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">Search…</span>
            <kbd className="ml-1 hidden rounded border bg-muted px-1.5 font-mono text-[10px] sm:inline">⌘K</kbd>
          </button>

          <ThemeToggle />

          <Button size="sm" className="gap-1.5" onClick={() => navigate('twins', { action: 'create' })}>
            <Plus className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">Create Twin</span>
            <span className="sm:hidden">Twin</span>
          </Button>
        </header>

        <main className="flex-1">
          <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
            <ActiveView />
          </div>
        </main>
      </div>

      <CommandPalette />
    </div>
  );
}

export default function Home() {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: false } },
  }));
  return (
    <QueryClientProvider client={queryClient}>
      <Shell />
      <Toaster position="bottom-right" richColors closeButton />
    </QueryClientProvider>
  );
}
