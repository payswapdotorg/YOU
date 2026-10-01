'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Performance track timeline — reusable visualizer for PerformanceTrack[].
// Renders each track as a horizontal strip of frame segments colored by
// PerformanceState, with a shared duration ruler and a 9-state legend.
// Used by Performances view and Solution Artifact → Performance tab.
// ═══════════════════════════════════════════════════════════════════════════
import type { PerformanceState, PerformanceTrack } from '@/lib/you/contracts';
import { cn } from '@/lib/utils';

// Studio-wide state palette (deterministic hex — no blue/indigo).
export const PERFORMANCE_STATES: PerformanceState[] = [
  'listening', 'reading', 'typing', 'thinking', 'tool_use',
  'speaking', 'interrupted', 'idle', 'unavailable',
];

export const PERFORMANCE_STATE_COLORS: Record<string, string> = {
  listening: '#10b981',   // emerald
  reading: '#8b5cf6',     // violet
  typing: '#78716c',      // stone
  thinking: '#f59e0b',    // amber
  tool_use: '#f97316',    // orange
  speaking: '#f43f5e',    // rose
  interrupted: '#ef4444', // red
  idle: '#a1a1aa',        // zinc-400
  unavailable: '#52525b', // zinc-600
  custom: '#d946ef',      // fuchsia
};

export const NEUTRAL_FRAME_COLOR = '#d4d4d8'; // zinc-300 (frames without state)

export function fmtMs(ms?: number | null): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

interface Segment {
  /** start % of total */
  left: number;
  width: number;
  color: string;
  opacity: number;
  title: string;
}

function buildSegments(track: PerformanceTrack, total: number): Segment[] {
  if (!track.frames.length || total <= 0) return [];
  const pts = track.frames.map((f) => f.t).filter((t) => Number.isFinite(t));
  const maxT = Math.max(...pts, 0);
  const end = Math.max(total, maxT);
  return track.frames.map((frame, i) => {
    const start = Math.max(0, frame.t ?? 0);
    const next = track.frames[i + 1]?.t ?? end;
    const width = Math.max(0, (next ?? end) - start);
    const color = frame.state
      ? (PERFORMANCE_STATE_COLORS[frame.state] ?? PERFORMANCE_STATE_COLORS.custom)
      : NEUTRAL_FRAME_COLOR;
    const intensity = typeof frame.intensity === 'number' ? Math.min(1, Math.max(0, frame.intensity)) : null;
    const parts = [
      `t ${Math.round(start)} ms`,
      frame.state ? `state: ${frame.state}` : `kind: ${track.kind}`,
      intensity !== null ? `intensity ${intensity.toFixed(2)}` : null,
      frame.note ?? null,
    ].filter(Boolean);
    return {
      left: (start / end) * 100,
      width: Math.max(0.4, (width / end) * 100),
      color,
      opacity: intensity !== null ? 0.45 + intensity * 0.55 : 1,
      title: parts.join(' · '),
    };
  });
}

function StateLegend({ present }: { present: Set<string> }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {PERFORMANCE_STATES.map((s) => {
        const on = present.has(s);
        return (
          <span
            key={s}
            className={cn(
              'inline-flex items-center gap-1.5 font-mono text-[10px]',
              on ? 'text-foreground' : 'text-muted-foreground/50',
            )}
            title={on ? `present in this performance` : 'not present in this performance'}
          >
            <span
              className="size-2 rounded-[3px]"
              style={{ backgroundColor: PERFORMANCE_STATE_COLORS[s], opacity: on ? 1 : 0.3 }}
              aria-hidden
            />
            {s}
          </span>
        );
      })}
    </div>
  );
}

export function TrackTimeline({
  tracks,
  durationMs,
  className,
}: {
  tracks: PerformanceTrack[];
  durationMs?: number | null;
  className?: string;
}) {
  const valid = tracks.filter((t) => t.frames && t.frames.length > 0);
  const frameMax = valid.reduce(
    (acc, t) => Math.max(acc, ...t.frames.map((f) => f.t ?? 0)),
    0,
  );
  const total = Math.max(durationMs ?? 0, frameMax, 1);
  const present = new Set<string>();
  for (const t of valid) for (const f of t.frames) if (f.state) present.add(f.state);

  if (!valid.length) {
    return (
      <div className="rounded-lg border border-dashed bg-card/50 px-4 py-8 text-center text-sm text-muted-foreground">
        No track frames recorded for this performance.
      </div>
    );
  }

  return (
    <div className={cn('space-y-4', className)}>
      {/* Duration ruler */}
      <div>
        <div className="relative h-4">
          {[0, 25, 50, 75, 100].map((p) => (
            <div key={p} className="absolute top-0 flex flex-col items-center" style={{ left: `${p}%`, transform: 'translateX(-50%)' }}>
              <span className="h-1.5 w-px bg-border" aria-hidden />
              <span className="you-num mt-0.5 font-mono text-[9px] text-muted-foreground">
                {p === 0 ? '0' : `${Math.round((total * p) / 100)}ms`}
              </span>
            </div>
          ))}
        </div>
        <div className="h-px bg-border" aria-hidden />
      </div>

      {/* Track strips */}
      <div className="space-y-2.5">
        {valid.map((track) => {
          const segments = buildSegments(track, total);
          return (
            <div key={track.trackId} className="grid grid-cols-[86px_minmax(0,1fr)] items-center gap-3 sm:grid-cols-[140px_minmax(0,1fr)]">
              <div className="min-w-0">
                <div className="truncate font-mono text-[10px] text-muted-foreground" title={track.trackId}>
                  {track.trackId.length > 18 ? `${track.trackId.slice(0, 16)}…` : track.trackId}
                </div>
                <span className="inline-flex rounded border bg-muted/40 px-1.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
                  {track.kind}
                </span>
              </div>
              <div
                className="relative h-6 overflow-hidden rounded-md border bg-muted/30"
                role="img"
                aria-label={`${track.kind} track, ${track.frames.length} frames`}
              >
                {segments.map((seg, i) => (
                  <div
                    key={i}
                    className="absolute inset-y-0"
                    style={{
                      left: `${Math.min(99.6, seg.left)}%`,
                      width: `${Math.min(100, seg.width)}%`,
                      backgroundColor: seg.color,
                      opacity: seg.opacity,
                    }}
                    title={seg.title}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <StateLegend present={present} />
      <p className="you-num font-mono text-[10px] text-muted-foreground">
        total {fmtMs(total)} · {valid.length} {valid.length === 1 ? 'track' : 'tracks'} ·{' '}
        {valid.reduce((n, t) => n + t.frames.length, 0)} frames
      </p>
    </div>
  );
}
