'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Avatar stage — stylized geometric SVG avatar whose expression reflects the
// CURRENT performance state, driven only by REAL emitted agent-turn events.
// Deterministic CSS animations (youav-* prefix), zero external assets.
// ═══════════════════════════════════════════════════════════════════════════
import { useId } from 'react';
import { formatDistanceToNow } from 'date-fns';
import type { AgentPerformanceEvent, PerformanceState } from '@/lib/you/contracts';
import { PERFORMANCE_STATE_COLORS } from '@/components/you/artifact/track-timeline';
import { cn } from '@/lib/utils';

const CSS = `
.youav-breathe { animation: youav-breathe 4.6s ease-in-out infinite; }
@keyframes youav-breathe { 0%,100% { transform: translateY(0); } 50% { transform: translateY(2.4px); } }
.youav-blink { animation: youav-blink 5.4s infinite; transform-box: fill-box; transform-origin: center; }
@keyframes youav-blink { 0%,93.5%,100% { transform: scaleY(1); } 95.5% { transform: scaleY(0.08); } }
.youav-dot { animation: youav-dot 1.15s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
@keyframes youav-dot { 0%,100% { transform: scale(0.55); opacity: 0.45; } 50% { transform: scale(1); opacity: 1; } }
.youav-bar { animation: youav-bar 0.85s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
@keyframes youav-bar { 0%,100% { transform: scaleY(0.3); } 50% { transform: scaleY(1); } }
.youav-mouth { animation: youav-mouth 0.5s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
@keyframes youav-mouth { 0%,100% { transform: scaleY(0.45); } 50% { transform: scaleY(1.1); } }
.youav-arc { animation: youav-arc 1.7s ease-out infinite; }
@keyframes youav-arc { 0% { opacity: 0; } 35% { opacity: 1; } 100% { opacity: 0; } }
.youav-spin { animation: youav-spin 7s linear infinite; transform-box: fill-box; transform-origin: center; }
@keyframes youav-spin { to { transform: rotate(360deg); } }
.youav-key { animation: youav-key 0.7s ease-in-out infinite; }
@keyframes youav-key { 0%,100% { opacity: 0.35; } 50% { opacity: 1; } }
`;

function rel(iso?: string | null): string {
  if (!iso) return '';
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }); } catch { return ''; }
}

/** pupil gaze offset per state */
function gaze(state: string | null): { x: number; y: number } {
  switch (state) {
    case 'thinking': return { x: -1.6, y: -2.2 };
    case 'reading':
    case 'typing': return { x: 0, y: 2.2 };
    case 'listening': return { x: 2.4, y: 0 };
    case 'speaking': return { x: 0, y: -0.8 };
    default: return { x: 0, y: 0 };
  }
}

export function AvatarStage({
  state,
  stateAt,
  why,
  recentEvents,
  ended = false,
  className,
}: {
  state: PerformanceState | 'custom' | null;
  stateAt?: string | null;
  /** P6.B7 turn transparency — the honest WHY under the state chip (always derived from real runtime data). */
  why?: string | null;
  recentEvents: AgentPerformanceEvent[];
  ended?: boolean;
  className?: string;
}) {
  const clipId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const effective = ended ? 'unavailable' : state;
  const color = effective ? (PERFORMANCE_STATE_COLORS[effective] ?? PERFORMANCE_STATE_COLORS.custom) : 'var(--muted-foreground)';
  const look = gaze(effective);
  const eyesOpen = effective !== 'unavailable';
  const halfLidded = effective === 'idle';
  const timeline = [...recentEvents]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 6);

  return (
    <div className={cn('rounded-xl border bg-gradient-to-b from-muted/40 to-card', className)}>
      <style>{CSS}</style>
      <div className="flex flex-col items-center px-4 pb-4 pt-3">
        <svg
          viewBox="0 0 220 190"
          className="h-44 w-full max-w-[260px]"
          role="img"
          aria-label={`Avatar stage — ${effective ?? 'awaiting first event'}${why ? `: ${why}` : ''}${ended ? ' (session ended)' : ''}`}
        >
          <defs>
            <clipPath id={`youav-head-${clipId}`}>
              <circle cx="110" cy="74" r="40" />
            </clipPath>
          </defs>

          <g className={ended ? 'youav-breathe opacity-40 grayscale' : 'youav-breathe'}>
            {/* bust + neck */}
            <rect x="100" y="108" width="20" height="18" fill="var(--muted)" />
            <path
              d="M 58 172 C 62 140 86 127 110 127 C 134 127 158 140 162 172 Z"
              fill="var(--muted)" stroke="var(--border)" strokeWidth="1.5"
            />
            {/* ears */}
            <circle cx="69" cy="78" r="6" fill="var(--muted)" stroke="var(--border)" strokeWidth="1.5"
              style={effective === 'listening' ? { stroke: color, strokeWidth: 2.5 } : undefined} />
            <circle cx="151" cy="78" r="6" fill="var(--muted)" stroke="var(--border)" strokeWidth="1.5"
              style={effective === 'listening' ? { stroke: color, strokeWidth: 2.5 } : undefined} />

            {/* head */}
            <g clipPath={`url(#youav-head-${clipId})`}>
              <circle cx="110" cy="74" r="40" fill="var(--muted)" />
              <rect x="66" y="30" width="88" height="27" fill="var(--foreground)" opacity="0.16" />
            </g>
            <circle cx="110" cy="74" r="40" fill="none" stroke="var(--border)" strokeWidth="1.5" />

            {/* brows */}
            <path
              d={effective === 'interrupted' ? 'M 87 55 Q 94 51 101 55' : 'M 87 55 Q 94 52 101 55'}
              stroke="var(--foreground)" strokeOpacity="0.55" strokeWidth="2.4" strokeLinecap="round" fill="none"
              transform={effective === 'interrupted' ? 'rotate(-9 94 54)' : undefined}
            />
            <path
              d="M 119 55 Q 126 52 133 55"
              stroke="var(--foreground)" strokeOpacity="0.55" strokeWidth="2.4" strokeLinecap="round" fill="none"
              transform={effective === 'interrupted' ? 'rotate(9 126 54)' : undefined}
            />

            {/* eyes — P6.B7: idle is visually distinct via relaxed half-lidded
                eyes (unavailable stays fully closed, engaged states stay open) */}
            {eyesOpen ? (
              <>
                {[95, 125].map((cx) => (
                  <g key={cx} className="youav-blink">
                    <circle cx={cx} cy={72} r="7" fill="var(--background)" stroke="var(--border)" strokeWidth="1.2" />
                    <circle cx={cx + look.x} cy={72 + look.y} r="3" fill="var(--foreground)" opacity="0.85" />
                    <circle cx={cx + look.x + 1} cy={72 + look.y - 1} r="0.8" fill="var(--background)" opacity="0.9" />
                    {halfLidded ? (
                      <rect x={cx - 7.4} y={64.2} width={14.8} height={5.2} rx={2.4} fill="var(--muted)" stroke="var(--border)" strokeWidth="0.8" />
                    ) : null}
                  </g>
                ))}
              </>
            ) : (
              <>
                <path d="M 88 72 Q 95 75 102 72" stroke="var(--foreground)" strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" fill="none" />
                <path d="M 118 72 Q 125 75 132 72" stroke="var(--foreground)" strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" fill="none" />
              </>
            )}

            {/* mouth */}
            {effective === 'speaking' ? (
              <ellipse className="youav-mouth" cx="110" cy="97" rx="9" ry="5.5" fill="var(--foreground)" opacity="0.78" />
            ) : effective === 'interrupted' ? (
              <circle cx="110" cy="96" r="4.2" fill="var(--foreground)" opacity="0.7" />
            ) : (
              <path
                d={effective === 'thinking' ? 'M 101 96 Q 110 99 119 95' : 'M 100 96 Q 110 100 120 96'}
                stroke="var(--foreground)" strokeOpacity="0.7" strokeWidth="2.4" strokeLinecap="round" fill="none"
              />
            )}
          </g>

          {/* ── state decorations (only for real states) ── */}
          {effective === 'thinking' ? (
            <g>
              {[98, 110, 122].map((x, i) => (
                <circle key={x} className="youav-dot" cx={x} cy={i === 1 ? 15 : 20} r="3.4" fill={color} style={{ animationDelay: `${i * 0.16}s` }} />
              ))}
            </g>
          ) : null}

          {effective === 'speaking' ? (
            <g>
              {[0, 1, 2, 3, 4].map((i) => (
                <rect
                  key={i}
                  className="youav-bar"
                  x={166 + i * 8}
                  y={66}
                  width="4.5"
                  height="18"
                  rx="2.2"
                  fill={color}
                  style={{ animationDelay: `${i * 0.11}s` }}
                />
              ))}
            </g>
          ) : null}

          {effective === 'listening' ? (
            <g fill="none" stroke={color} strokeWidth="2" strokeLinecap="round">
              <path className="youav-arc" d="M 160 70 Q 166 78 160 86" />
              <path className="youav-arc" d="M 167 66 Q 176 78 167 90" style={{ animationDelay: '0.25s' }} />
              <path className="youav-arc" d="M 60 70 Q 54 78 60 86" style={{ animationDelay: '0.5s' }} />
              <path className="youav-arc" d="M 53 66 Q 44 78 53 90" style={{ animationDelay: '0.75s' }} />
            </g>
          ) : null}

          {effective === 'tool_use' ? (
            <g>
              <g className="youav-spin">
                <circle cx="176" cy="28" r="9" fill="none" stroke={color} strokeWidth="2.6" strokeDasharray="4 3" />
              </g>
              <circle cx="176" cy="28" r="3" fill={color} />
            </g>
          ) : null}

          {effective === 'typing' ? (
            <g>
              <rect x="140" y="146" width="58" height="26" rx="5" fill="var(--muted)" stroke="var(--border)" strokeWidth="1.5" />
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <rect
                  key={i}
                  className="youav-key"
                  x={146 + (i % 6) * 8}
                  y={152 + (i < 3 ? 0 : 10)}
                  width="5"
                  height="6"
                  rx="1.2"
                  fill={i % 3 === 0 ? color : 'var(--foreground)'}
                  opacity={i % 3 === 0 ? undefined : 0.35}
                  style={{ animationDelay: `${i * 0.18}s` }}
                />
              ))}
            </g>
          ) : null}

          {effective === 'reading' ? (
            <g>
              <path d="M 92 118 Q 101 114 110 118 Q 119 114 128 118 L 128 130 Q 119 126 110 130 Q 101 126 92 130 Z"
                fill="var(--muted)" stroke="var(--border)" strokeWidth="1.5" />
              <path d="M 110 118 L 110 130" stroke="var(--border)" strokeWidth="1.5" />
              <path d="M 96 122 L 105 121" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
              <path d="M 115 121 L 124 122" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
            </g>
          ) : null}

          {effective === 'interrupted' ? (
            <g fill={color}>
              <rect x="157" y="16" width="5" height="14" rx="2.5" />
              <circle cx="159.5" cy="36" r="2.6" />
            </g>
          ) : null}

          {effective === 'custom' ? (
            <path className="youav-arc" d="M 172 22 L 176 30 L 184 34 L 176 38 L 172 46 L 168 38 L 160 34 L 168 30 Z"
              fill={color} opacity="0.85" />
          ) : null}

          {ended ? (
            <g stroke="var(--muted-foreground)" strokeWidth="2.4" strokeLinecap="round" opacity="0.7">
              <path d="M 168 14 L 188 34" />
              <path d="M 188 14 L 168 34" />
            </g>
          ) : null}
        </svg>

        {/* current state chip + the WHY (turn transparency) — aria-live so
            state changes are announced politely to assistive tech */}
        <div className="mt-1 flex items-center gap-2" aria-live="polite">
          <span
            className={cn('inline-block size-2 rounded-full', !ended && effective && effective !== 'idle' && 'you-pulse')}
            style={{ backgroundColor: color }}
            aria-hidden
          />
          <span className="font-mono text-xs text-foreground/85">
            {ended ? 'session ended' : (effective ?? 'awaiting first turn')}
          </span>
          {stateAt && !ended ? (
            <span className="text-[10px] text-muted-foreground">{rel(stateAt)}</span>
          ) : null}
        </div>
        {why && !ended ? (
          <p className="mt-1 max-w-[42ch] text-center text-[11px] leading-snug text-muted-foreground">
            <span className="sr-only">Current state reason: </span>{why}
          </p>
        ) : null}

        {/* state timeline strip — real emitted events only */}
        <div className="mt-3 w-full border-t pt-3">
          <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            State timeline
          </div>
          {timeline.length ? (
            <div className="flex flex-wrap gap-1.5">
              {timeline.map((e) => (
                <span
                  key={e.eventId}
                  className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-[10px]"
                  title={`${e.type} · ${e.timestamp}${e.durationMs != null ? ` · ${Math.round(e.durationMs)}ms` : ''} · source ${e.source}`}
                >
                  <span
                    className="size-1.5 rounded-[3px]"
                    style={{ backgroundColor: PERFORMANCE_STATE_COLORS[e.type] ?? PERFORMANCE_STATE_COLORS.custom }}
                    aria-hidden
                  />
                  {e.type}
                  <span className="text-muted-foreground">{rel(e.timestamp)}</span>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              No performance events yet — states appear here as the soul runtime emits them.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
