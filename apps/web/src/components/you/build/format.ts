// Formatting helpers shared by Worker B1 build components.
import { formatDistanceToNow, format } from 'date-fns';

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Relative time, e.g. "3 minutes ago" / "in 2 days". */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

/** Absolute timestamp, e.g. "Feb 3, 2026, 14:05". */
export function timeAbs(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return format(new Date(iso), 'MMM d, yyyy, HH:mm');
  } catch {
    return iso;
  }
}

/** Confidence 0..1 → "72%" (tabular via you-num on the consumer). */
export function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

/** Compact single-line payload summary for event feeds (mono styling upstream). */
export function payloadSummary(payload: Record<string, unknown> | null | undefined, max = 96): string {
  if (!payload || typeof payload !== 'object') return '';
  const s = Object.entries(payload)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Safe color swatch string — only renders valid-looking CSS colors. */
export function safeColor(c: string | undefined): string | null {
  if (!c) return null;
  return /^#[0-9a-fA-F]{3,8}$/.test(c) || /^(rgb|hsl)a?\(/.test(c) ? c : null;
}
