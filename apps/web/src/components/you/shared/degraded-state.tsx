'use client';
// ═══════════════════════════════════════════════════════════════════════════
// YOU Studio — shared degraded/error surface (Worker B lane, P6.B8).
// Follows the shared/primitives.tsx conventions.
//
// HONEST BY CONSTRUCTION (PRODUCTION_CHECKLIST "Product" — honest states):
//  - shows WHAT is degraded (which flow + which provider/path),
//  - shows the typed reason from the backend envelope, verbatim,
//  - derives retry guidance from retryAfterMs the backend actually sent
//    (live countdown + ONE automatic retry after the window, then manual),
//  - NO fabricated progress: no progress bars, no fake steps, no spinners
//    while nothing is running.
// Also hosts the P6.B8 error-taxonomy surfaces: ApiErrorNotice (rate-limited
// et al.) and the flow-level useApiErrorSurface/ApiErrorSurface pair.
// Model/logic lives in lib/you/client/degraded.ts + error-taxonomy.ts (pure,
// unit-tested); dead-letter payload parsing is READ-ONLY consumption of
// core/deadletter.ts.
// ═══════════════════════════════════════════════════════════════════════════
import { useEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Gauge, Unplug, RotateCw, Skull, TriangleAlert } from 'lucide-react';
import {
  countdownSecondsFrom,
  formatRetrySeconds,
  type DeadLetterLike,
  type DegradedDescriptor,
  deadJobExplanation,
  degradedFromApiError,
} from '@/lib/you/client/degraded';
import { classifyApiError, type ApiErrorClassification } from '@/lib/you/client/error-taxonomy';
import { parseDeadLetterError } from '@/lib/you/core/deadletter';
import type { JobView } from '@/lib/you/contracts';

// ─── retry countdown (client-side ticking over backend-provided ms) ─────────

/**
 * Live countdown over a backend-provided retryAfterMs. The window start is
 * tracked with the React "adjust state when a prop changes" pattern (guarded,
 * idempotent): a NEW retryAfterMs — a fresh refusal after a retry — restarts
 * the window without a painted intermediate frame (no flicker). `now` ticks
 * via an interval (the sole timer), and the remaining value is computed
 * during render from the backend hint — nothing is invented.
 */
export function useRetryCountdown(retryAfterMs?: number): number | null {
  const [win, setWin] = useState<{ ms: number | undefined; receivedAt: number | null }>({
    ms: undefined,
    receivedAt: null,
  });
  if (win.ms !== retryAfterMs) {
    setWin({
      ms: retryAfterMs,
      receivedAt: retryAfterMs !== undefined && retryAfterMs > 0 ? Date.now() : null,
    });
  }
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (retryAfterMs === undefined || retryAfterMs <= 0) return;
    const deadline = Date.now() + retryAfterMs;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= deadline) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [retryAfterMs]);

  if (retryAfterMs === undefined || retryAfterMs <= 0 || win.receivedAt === null) return null;
  return countdownSecondsFrom(retryAfterMs, win.receivedAt, now);
}

// ─── degraded surface ─────────────────────────────────────────────────────────

/**
 * One automatic retry per degraded episode, fired exactly when the backend's
 * Retry-After window elapses (P6.B8): the user should not have to babysit a
 * cooldown the backend itself quantified. Guarded so it can NEVER loop —
 * the parent flips `autoRetry` off after the first fire (onAutoRetryFired),
 * a fresh window re-arms at most once, and no window (no retryAfterMs)
 * means no automatic action (an absent hint must not become a guess).
 */
function useAutoRetryOnce(
  retryAfterMs: number | undefined,
  remaining: number | null,
  autoRetry: boolean,
  retrying: boolean | undefined,
  onRetry: (() => void) | undefined,
  onAutoRetryFired: (() => void) | undefined,
): void {
  // the window that already fired (ref — accessed ONLY inside the effect, so
  // a genuinely NEW retryAfterMs re-arms the single fire; an identical repeat
  // window stays fired = conservative no-loop)
  const firedWindowRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!autoRetry || !onRetry || retrying) return;
    if (retryAfterMs === undefined || retryAfterMs <= 0) return;
    if (remaining === null || remaining > 0) return;
    if (firedWindowRef.current === retryAfterMs) return;
    firedWindowRef.current = retryAfterMs;
    onAutoRetryFired?.();
    onRetry();
  }, [autoRetry, onRetry, retrying, retryAfterMs, remaining, onAutoRetryFired]);
}

function ProviderChips({ descriptor }: { descriptor: DegradedDescriptor }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {descriptor.provider ? (
        <Badge variant="outline" className="font-mono text-[10px]" data-you-degraded-provider={descriptor.provider}>
          provider: {descriptor.provider}
        </Badge>
      ) : null}
      {descriptor.breakerState ? (
        <Badge variant="outline" className="font-mono text-[10px]">breaker: {descriptor.breakerState}</Badge>
      ) : null}
      <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">{descriptor.code}</Badge>
    </div>
  );
}

function RetryGuidance({
  descriptor, onRetry, retrying, remaining, autoRetry,
}: {
  descriptor: DegradedDescriptor;
  onRetry?: () => void;
  retrying?: boolean;
  remaining: number | null;
  autoRetry?: boolean;
}) {
  const hasCountdown = descriptor.retryAfterMs !== undefined && descriptor.retryAfterMs > 0;
  const cooling = hasCountdown && remaining !== null && remaining > 0;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-muted-foreground" data-you-degraded-retry>
        {hasCountdown
          ? cooling
            ? <>Suggested retry in <span className="you-num font-mono font-medium text-foreground">{formatRetrySeconds(remaining ?? 0)}</span>
              {autoRetry
                ? <> — an automatic retry will fire when it elapses (once).</>
                : <> — this is the backend’s cooldown estimate, not a progress timer.</>}</>
            : <>The suggested cooldown has elapsed{autoRetry ? ' — retrying now…' : ' — retrying now is reasonable.'}</>
          : <>No retry estimate was provided by the backend — retry manually when ready.</>}
      </p>
      {onRetry ? (
        <Button
          size="sm" variant="outline" className="h-7 gap-1.5"
          onClick={onRetry}
          disabled={retrying}
          data-you-degraded-retry-button
        >
          <RotateCw className={cn('size-3.5', retrying && 'animate-spin')} aria-hidden />
          {retrying ? 'Retrying…' : 'Retry now'}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The honest degraded surface. `variant="inline"` sits inside cards/panels;
 * `variant="full-view"` replaces a whole view. Shows what is degraded, the
 * typed reason, and retry guidance derived from retryAfterMs. There is
 * deliberately NO progress bar here — a degraded flow is not progressing.
 */
export function DegradedState({
  descriptor, variant = 'inline', onRetry, retrying, className, autoRetry, onAutoRetryFired,
}: {
  descriptor: DegradedDescriptor;
  variant?: 'inline' | 'full-view';
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
  /** Fire ONE automatic retry when the backend's window elapses (P6.B8). */
  autoRetry?: boolean;
  /** Notifies the owner the automatic retry was spent (no looping). */
  onAutoRetryFired?: () => void;
}) {
  const remaining = useRetryCountdown(descriptor.retryAfterMs);
  useAutoRetryOnce(descriptor.retryAfterMs, remaining, !!autoRetry, retrying, onRetry, onAutoRetryFired);
  const body = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ProviderChips descriptor={descriptor} />
      </div>
      <p className="text-sm text-muted-foreground" data-you-degraded-reason>
        {descriptor.reason}
      </p>
      {descriptor.guidance ? (
        <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          {descriptor.guidance}
        </p>
      ) : null}
      <RetryGuidance descriptor={descriptor} remaining={remaining} onRetry={onRetry} retrying={retrying} autoRetry={autoRetry} />
    </div>
  );

  if (variant === 'full-view') {
    return (
      <div
        role="alert"
        data-you-degraded="full-view"
        className={cn(
          'flex flex-col items-center justify-center gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.05] px-6 py-14 text-center',
          className,
        )}
      >
        <div className="flex size-11 items-center justify-center rounded-full bg-amber-500/10">
          <Unplug className="size-5 text-amber-600 dark:text-amber-400" aria-hidden />
        </div>
        <div className="space-y-1">
          <div className="font-medium">{descriptor.path} is degraded</div>
          <p className="mx-auto max-w-md text-sm text-muted-foreground">
            This surface is unavailable right now — nothing is running and no progress is being made.
          </p>
        </div>
        <div className="w-full max-w-lg text-left">{body}</div>
      </div>
    );
  }

  return (
    <div
      role="alert"
      data-you-degraded="inline"
      className={cn('space-y-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.05] px-4 py-3.5', className)}
    >
      <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
        <TriangleAlert className="size-4 shrink-0" aria-hidden />
        {descriptor.path} is degraded
      </div>
      {body}
    </div>
  );
}

// ─── dead-letter (terminal `dead` jobs) ──────────────────────────────────────

/**
 * The honest dead-job surface (P6.A6-FULL terminal `dead` status). Distinct
 * from `failed`: a dead job EXHAUSTED its bounded retry budget — this panel
 * says so, shows the structured dead-letter truth (attempts / stoppedBy /
 * last error) and points to the operator maintenance path. No links: replay
 * is an operator action, not a studio-user action.
 */
export function DeadJobState({
  deadLetter, kindLabel, className,
}: { deadLetter: DeadLetterLike | null; kindLabel: string; className?: string }) {
  const explanation = deadJobExplanation(
    deadLetter ?? {
      code: 'dead_letter', attempts: 0, stoppedBy: 'unknown',
      firstAttemptAt: '', lastErrorAt: '', lastError: '',
    },
    kindLabel,
  );
  return (
    <div
      role="alert"
      data-you-dead-letter="true"
      className={cn('space-y-2.5 rounded-lg border border-red-500/25 bg-red-500/[0.06] px-4 py-3.5', className)}
    >
      <div className="flex items-center gap-2 text-sm font-medium text-red-700 dark:text-red-400">
        <Skull className="size-4 shrink-0" aria-hidden />
        {explanation.title}
      </div>
      <p className="text-xs text-muted-foreground">{explanation.summary}</p>
      <p className="break-words rounded-md bg-muted/50 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        {explanation.lastError}
      </p>
      <p className="text-xs text-muted-foreground">{explanation.maintenance}</p>
    </div>
  );
}

/**
 * Job-status-aware honest terminal render for job panels: `dead` → the
 * dead-letter surface; `failed` → the last error verbatim; other terminal
 * states (cancelled/unavailable) → the plain status note. Returns null
 * while the job is still live (the caller keeps showing real steps).
 */
export function JobTerminalState({ job, kindLabel }: { job: JobView; kindLabel: string }) {
  if (job.status === 'dead') {
    return <DeadJobState deadLetter={parseDeadLetterError(job.error)} kindLabel={kindLabel} />;
  }
  if (job.status === 'failed') {
    return (
      <p role="alert" className="rounded-md border border-red-500/25 bg-red-500/[0.06] px-3 py-2 text-xs text-red-700 dark:text-red-400">
        {job.error ?? 'The job failed — the backend recorded no error text.'}
      </p>
    );
  }
  if (job.status === 'cancelled' || job.status === 'unavailable') {
    return (
      <p role="alert" className="rounded-md border border-red-500/25 bg-red-500/[0.06] px-3 py-2 text-xs text-red-700 dark:text-red-400">
        Job ended as {job.status}.{job.error ? ` ${job.error}` : ''}
      </p>
    );
  }
  return null;
}

// ─── error taxonomy surface (rate-limited / validation / unknown…) ───────────

/**
 * Inline notice for NON-degraded client errors (P6.B8 taxonomy): renders the
 * honest class headline + the backend detail verbatim, with a live countdown
 * for rate-limited windows (server-enforced — retrying early just eats
 * another 429, so the button stays manual, never automatic).
 */
export function ApiErrorNotice({
  classification, onRetry, retrying, className,
}: {
  classification: ApiErrorClassification;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  const remaining = useRetryCountdown(classification.retryAfterMs);
  const hasWindow = classification.retryAfterMs !== undefined && classification.retryAfterMs > 0;
  const cooling = hasWindow && remaining !== null && remaining > 0;
  return (
    <div
      role="alert"
      data-you-error-kind={classification.kind}
      className={cn('space-y-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.05] px-4 py-3.5', className)}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
        <Gauge className="size-4 shrink-0" aria-hidden />
        {classification.title}
      </div>
      <p className="break-words text-xs text-muted-foreground">{classification.detail}</p>
      {hasWindow ? (
        <p className="text-xs text-muted-foreground" data-you-error-retry>
          {cooling
            ? <>Window resets in <span className="you-num font-mono font-medium text-foreground">{formatRetrySeconds(remaining ?? 0)}</span> — the limit is enforced server-side; retrying earlier will not succeed.</>
            : <>The window has elapsed — retrying now is reasonable.</>}
        </p>
      ) : null}
      {onRetry ? (
        <div>
          <Button
            size="sm" variant="outline" className="h-7 gap-1.5"
            onClick={onRetry}
            disabled={retrying}
            data-you-error-retry-button
          >
            <RotateCw className={cn('size-3.5', retrying && 'animate-spin')} aria-hidden />
            {retrying ? 'Retrying…' : 'Retry now'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ─── the flow-level surface (hook + component) ───────────────────────────────

/**
 * Per-flow API error surface state (P6.B8). `capture(err)` is called from
 * mutation onError handlers: it returns true when the error became an INLINE
 * surface (provider-down degraded, or rate-limited) and the caller should NOT
 * also toast it; false means "not mine" — the caller keeps its usual toast.
 *
 * Degraded refusals arm ONE automatic retry after the backend's Retry-After
 * window (autoRetry); after that single fire, further refusals are manual
 * only. A success (`clear()`) resets the episode.
 */
export function useApiErrorSurface(path: string): {
  degraded: DegradedDescriptor | null;
  rateLimited: ApiErrorClassification | null;
  capture: (err: unknown) => boolean;
  clear: () => void;
  autoRetry: boolean;
  onAutoRetryFired: () => void;
} {
  const [degraded, setDegraded] = useState<DegradedDescriptor | null>(null);
  const [rateLimited, setRateLimited] = useState<ApiErrorClassification | null>(null);
  const [autoRetried, setAutoRetried] = useState(false);

  const capture = useCallback((err: unknown): boolean => {
    const d = degradedFromApiError(err, path);
    if (d) {
      setDegraded(d);
      setRateLimited(null);
      return true;
    }
    const c = classifyApiError(err);
    if (c.kind === 'rate-limited') {
      setRateLimited(c);
      setDegraded(null);
      return true;
    }
    return false;
  }, [path]);

  const clear = useCallback(() => {
    setDegraded(null);
    setRateLimited(null);
    setAutoRetried(false);
  }, []);

  const onAutoRetryFired = useCallback(() => setAutoRetried(true), []);

  return {
    degraded, rateLimited, capture, clear,
    autoRetry: !autoRetried,
    onAutoRetryFired,
  };
}

/**
 * Renders whatever the flow's error surface holds: the degraded surface (with
 * the single automatic retry) or the rate-limited notice. Nothing while the
 * flow is healthy. One line per flow keeps every surface consistent.
 */
export function ApiErrorSurface({
  surface, onRetry, retrying, className,
}: {
  surface: ReturnType<typeof useApiErrorSurface>;
  onRetry: () => void;
  retrying?: boolean;
  className?: string;
}) {
  if (surface.degraded) {
    return (
      <DegradedState
        descriptor={surface.degraded}
        onRetry={onRetry}
        retrying={retrying}
        autoRetry={surface.autoRetry}
        onAutoRetryFired={surface.onAutoRetryFired}
        className={className}
      />
    );
  }
  if (surface.rateLimited) {
    return (
      <ApiErrorNotice
        classification={surface.rateLimited}
        onRetry={onRetry}
        retrying={retrying}
        className={className}
      />
    );
  }
  return null;
}
