'use client';
// Overview — the shortest-path landing surface (UX survey: "the product should
// always make the shortest path obvious"). All data from api.overview(); no
// fallbacks, honest loading/error/empty states.
import { useQuery } from '@tanstack/react-query';
import {
  BadgeCheck, Bot, Camera, ClipboardList, FlaskConical, Files, ImageIcon,
  Layers, Plus, RotateCw, ShieldCheck, UserRound, ChevronRight, Activity,
  CircleCheck, Zap, TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, IdChip, PageHeader, SectionCard } from '@/components/you/shared/primitives';
import { useYouStore, type ViewId } from '@/hooks/you/use-you-store';
import { api } from '@/lib/you/client/api';
import type { OverviewStats } from '@/lib/you/contracts';
import { cn } from '@/lib/utils';
import { payloadSummary, timeAgo } from '../build/format';
import { QueryError, RowSkeletons, StatTileSkeletons } from '../build/confidence';

// Pipeline stage → studio view. Stage names come from the backend aggregate;
// matching is by convention because stage labels are backend-owned.
const STAGE_TARGETS: { match: RegExp; view: ViewId }[] = [
  { match: /twin|create/i, view: 'twins' },
  { match: /capture|evidence/i, view: 'captures' },
  { match: /reconstruct|version|compile|htir/i, view: 'twins' },
  { match: /perform/i, view: 'performances' },
  { match: /render/i, view: 'renders' },
  { match: /artifact|export/i, view: 'renders' },
];

function stageTarget(stage: string): ViewId {
  return STAGE_TARGETS.find((t) => t.match.test(stage))?.view ?? 'overview';
}

function eventTarget(entityType: string): ViewId | null {
  const t = entityType.toLowerCase();
  if (t.includes('twin')) return 'twins';
  if (t.includes('capture') || t.includes('evidence')) return 'captures';
  if (t.includes('consent') || t.includes('grant')) return 'trust';
  if (t.includes('render')) return 'renders';
  if (t.includes('performance')) return 'performances';
  if (t.includes('lab') || t.includes('benchmark')) return 'labs';
  if (t.includes('agent') || t.includes('soul') || t.includes('body')) return 'agent-avatars';
  return null;
}

function StatTile({
  icon: Icon, label, value, hint, onClick, loading,
}: {
  icon: typeof UserRound; label: string; value: number; hint: string;
  onClick?: () => void; loading?: boolean;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Icon className="size-4 shrink-0 text-muted-foreground/70" aria-hidden />
      </div>
      <div className="you-num mt-2.5 text-[26px] font-semibold leading-none tracking-tight">
        {loading ? <Skeleton className="h-7 w-12" /> : value}
      </div>
      <div className="mt-2 text-[11px] text-muted-foreground/80">{hint}</div>
    </>
  );
  const cls = 'rounded-xl border bg-card p-5 text-left shadow-sm transition-all';
  return onClick ? (
    <button type="button" onClick={onClick} className={cn(cls, 'hover:border-foreground/20 hover:shadow')}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function PipelineSection({ pipeline, navigate }: {
  pipeline: OverviewStats['pipeline'];
  navigate: ReturnType<typeof useYouStore.getState>['navigate'];
}) {
  const blockerIndex = pipeline.findIndex((s) => s.count === 0);
  return (
    <SectionCard
      title="Pipeline"
      description="Create Twin → Capture → Reconstruct → Perform → Render → Artifact. The highlighted stage is your next step."
      icon={Zap}
    >
      {pipeline.length === 0 ? (
        <p className="text-sm text-muted-foreground">No pipeline stages reported yet.</p>
      ) : (
        <div className="-mx-1 flex gap-1 overflow-x-auto you-scroll px-1 pb-1">
          {pipeline.map((stage, i) => {
            const blocked = i === blockerIndex;
            return (
              <div key={stage.stage} className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => navigate(stageTarget(stage.stage))}
                  aria-label={`Go to ${stage.stage} (${stage.count})`}
                  className={cn(
                    'w-44 rounded-lg border bg-card p-3.5 text-left transition-all hover:border-foreground/20 hover:shadow',
                    blocked && 'border-emerald-500/50 bg-emerald-500/[0.04] ring-1 ring-emerald-500/25',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[13px] font-medium">{stage.stage}</span>
                    {blocked ? (
                      <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/12 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">
                        <CircleCheck className="size-3" aria-hidden /> next
                      </span>
                    ) : null}
                  </div>
                  <div className="you-num mt-1.5 text-xl font-semibold leading-none">{stage.count}</div>
                  <div className="mt-1.5 line-clamp-2 min-h-8 text-[11px] leading-snug text-muted-foreground">{stage.hint}</div>
                </button>
                {i < pipeline.length - 1 ? (
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground/40" aria-hidden />
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

function GetStarted({ navigate }: { navigate: ReturnType<typeof useYouStore.getState>['navigate'] }) {
  const steps: { title: string; description: string; action?: { label: string; run: () => void } }[] = [
    {
      title: 'Create a twin',
      description: 'Twins are the persistent human objects every workflow builds on.',
      action: { label: 'Create Twin', run: () => navigate('twins', { action: 'create' }) },
    },
    { title: 'Grant scoped consent', description: 'Capture and reconstruction are consent-gated by design — explicit, purpose-bound, revocable.' },
    { title: 'Start a capture session', description: 'Follow the checklist: front face, profile, hands, silhouette — evidence is immutable once uploaded.' },
    { title: 'Reconstruct to HTIR', description: 'The compiler turns evidence into the canonical Human Twin Intermediate Representation.' },
    { title: 'Review confidence & improve', description: 'Deficiencies map to targeted evidence requests — the improve loop.' },
    { title: 'Perform & render', description: 'Drive a performance and render a derived output, then export or integrate.' },
  ];
  return (
    <SectionCard title="Get started" description="The canonical first flow — six steps from person to rendered artifact." icon={CircleCheck}>
      <ol className="space-y-3">
        {steps.map((step, i) => (
          <li key={step.title} className="flex items-start gap-3">
            <span className="you-num mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border bg-muted text-[11px] font-semibold text-muted-foreground">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-medium">{step.title}</span>
                {step.action ? (
                  <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]" onClick={step.action.run}>
                    <Plus className="size-3" aria-hidden /> {step.action.label}
                  </Button>
                ) : null}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">{step.description}</p>
            </div>
          </li>
        ))}
      </ol>
    </SectionCard>
  );
}

export function OverviewView() {
  const navigate = useYouStore((s) => s.navigate);
  const q = useQuery({
    queryKey: ['overview'],
    queryFn: api.overview,
    refetchInterval: 15_000,
  });

  if (q.isPending) {
    return (
      <div className="space-y-6">
        <PageHeader title="Overview" description="Human reality infrastructure — build, trust and render authorized digital twins." />
        <StatTileSkeletons />
        <div className="space-y-2"><Skeleton className="h-24 w-full rounded-xl" /></div>
        <RowSkeletons rows={4} />
      </div>
    );
  }

  if (q.isError) {
    return (
      <div className="space-y-6">
        <PageHeader title="Overview" description="Human reality infrastructure — build, trust and render authorized digital twins." />
        <QueryError
          error={q.error}
          title="Overview data unavailable"
          onRetry={() => void q.refetch()}
        />
        <p className="text-center text-xs text-muted-foreground">
          The Studio renders only real backend state — retry once the API is reachable.
        </p>
      </div>
    );
  }

  const s = q.data;
  const cold = s.twins === 0 && s.captures === 0 && s.versions === 0 && s.renders === 0;

  const tiles = [
    { icon: UserRound, label: 'Twins', value: s.twins, hint: 'persistent human objects', onClick: () => navigate('twins') },
    { icon: BadgeCheck, label: 'Ready twins', value: s.twinsReady, hint: 'cleared for performance', onClick: () => navigate('twins') },
    { icon: Camera, label: 'Captures', value: s.captures, hint: 'authorized sessions', onClick: () => navigate('captures') },
    { icon: Files, label: 'Evidence assets', value: s.evidenceAssets, hint: 'immutable evidence', onClick: () => navigate('captures') },
    { icon: Layers, label: 'Versions', value: s.versions, hint: 'HTIR compiles', onClick: () => navigate('twins') },
    { icon: ImageIcon, label: 'Renders', value: s.renders, hint: 'derived outputs', onClick: () => navigate('renders') },
    { icon: ShieldCheck, label: 'Active grants', value: s.activeGrants, hint: 'consent in force', onClick: () => navigate('trust') },
    { icon: ClipboardList, label: 'Open evidence requests', value: s.openEvidenceRequests, hint: 'targeted evidence due', onClick: () => navigate('twins') },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description="Human reality infrastructure — build, trust and render authorized digital twins."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void q.refetch()} className="gap-1.5">
              <RotateCw className="size-3.5" aria-hidden /> Refresh
            </Button>
            <Button size="sm" onClick={() => navigate('twins', { action: 'create' })} className="gap-1.5">
              <Plus className="size-3.5" aria-hidden /> Create Twin
            </Button>
          </>
        }
      />

      {cold ? <GetStarted navigate={navigate} /> : null}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {tiles.map((t) => (
          <StatTile key={t.label} {...t} />
        ))}
      </div>

      <PipelineSection pipeline={s.pipeline} navigate={navigate} />

      <div className="grid gap-6 lg:grid-cols-3">
        <SectionCard
          title="Recent activity"
          description="Event ledger — newest first"
          icon={Activity}
          className="lg:col-span-2"
          actions={<span className="you-num text-[11px] text-muted-foreground">{s.recentEvents.length} events</span>}
        >
          {s.recentEvents.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No events yet"
              hint="Actions you take — captures, compiles, renders, consent changes — appear here."
            />
          ) : (
            <ul className="max-h-96 space-y-1 overflow-y-auto you-scroll pr-1" aria-label="Recent events">
              {s.recentEvents.map((e) => {
                const target = eventTarget(e.entityType);
                const row = (
                  <div className="flex items-center gap-3 rounded-lg border bg-card/60 px-3 py-2 transition-colors hover:bg-muted/40">
                    <span className="shrink-0 rounded border bg-muted/60 px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
                      {e.type}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs">
                      <span className="font-medium">{e.entityType}</span>
                      {e.entityId ? <span className="ml-1.5 font-mono text-[10.5px] text-muted-foreground">{e.entityId.slice(0, 14)}…</span> : null}
                      {payloadSummary(e.payload) ? (
                        <span className="ml-2 font-mono text-[10.5px] text-muted-foreground/70">{payloadSummary(e.payload, 70)}</span>
                      ) : null}
                    </span>
                    <span className="you-num shrink-0 text-[11px] text-muted-foreground" title={e.createdAt}>{timeAgo(e.createdAt)}</span>
                  </div>
                );
                return (
                  <li key={e.id}>
                    {target ? (
                      <button type="button" className="w-full text-left" onClick={() => navigate(target)} aria-label={`Open ${e.entityType} in ${target}`}>
                        {row}
                      </button>
                    ) : row}
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="Quick actions" description="Shortest paths" icon={Zap}>
          <div className="grid gap-2">
            <Button variant="outline" className="h-auto w-full justify-start gap-2.5 px-3 py-3 text-[13px]" onClick={() => navigate('twins', { action: 'create' })}>
              <Plus className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
              <span className="min-w-0 flex-1 text-left">
                <span className="block font-medium">Create Twin</span>
                <span className="block text-[11px] font-normal text-muted-foreground">Start the canonical flow</span>
              </span>
            </Button>
            <Button variant="outline" className="h-auto w-full justify-start gap-2.5 px-3 py-3 text-[13px]" onClick={() => navigate('captures')}>
              <Camera className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
              <span className="min-w-0 flex-1 text-left">
                <span className="block font-medium">Review captures</span>
                <span className="block text-[11px] font-normal text-muted-foreground">Sessions, evidence & quality</span>
              </span>
            </Button>
            <Button variant="outline" className="h-auto w-full justify-start gap-2.5 px-3 py-3 text-[13px]" onClick={() => navigate('labs')}>
              <FlaskConical className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
              <span className="min-w-0 flex-1 text-left">
                <span className="block font-medium">Run Lab benchmark</span>
                <span className="block text-[11px] font-normal text-muted-foreground">Simulated research truth</span>
              </span>
            </Button>
            <Button variant="outline" className="h-auto w-full justify-start gap-2.5 px-3 py-3 text-[13px]" onClick={() => navigate('agent-avatars')}>
              <Bot className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
              <span className="min-w-0 flex-1 text-left">
                <span className="block font-medium">Start agent session</span>
                <span className="block text-[11px] font-normal text-muted-foreground">Possess a Body with a Soul</span>
              </span>
            </Button>
          </div>
          <div className="mt-4 rounded-lg border bg-muted/30 p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <TriangleAlert className="size-3" aria-hidden /> Honest-by-design
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              This dashboard never fabricates progress or quality. Numbers come from the canonical
              backend; jobs show only backend-reported steps.
            </p>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

export default OverviewView;
