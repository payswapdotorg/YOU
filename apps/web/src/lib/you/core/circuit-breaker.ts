// ═══════════════════════════════════════════════════════════════════════════
// YOU core — per-provider circuit breaker (Worker A lane, P6.A6-FULL).
//
// A rolling-window breaker in front of every external provider call
// ('zai' = in-sandbox SDK binding, 'openrouter' = hosted vision). When a
// provider keeps failing, the breaker OPENS and further calls fail FAST with
// a typed ProviderUnavailableError — user-facing routes translate that into
// honest 503s with retry guidance instead of hanging or burning retries.
//
// State machine:
//   closed    — calls pass through; failures are timestamped into a rolling
//               window; >= failureThreshold within windowMs ⇒ OPEN.
//   open      — calls refuse immediately (retryAfterMs = remaining cooldown);
//               after cooldownMs the next call becomes a half-open PROBE.
//   half-open — exactly ONE probe runs at a time (single-flight); success ⇒
//               CLOSED (window cleared), failure ⇒ OPEN again (cooldown
//               restarts). Concurrent calls during a probe refuse fast.
//
// Manual control (operator surface): resetBreaker() force-closes (used by
// POST /api/v1/maintenance/provider-breaker after an incident is fixed);
// tripBreaker() force-opens (drain a misbehaving provider deliberately).
//
// Scope disclosure: breaker state is PROCESS-LOCAL (same class as the P6.A6
// interim rate limiter — a multi-instance deployment runs one breaker per
// instance, which under-reacts per instance but never falsely opens).
//
// SHARING NOTE (F-07 class): `next dev` (and per-entry production route
// bundles) give every compiled route entry its OWN module registry — a plain
// module-level Map would hand the maintenance/metrics/compile routes a
// DIFFERENT breaker set than the one the provider seam records into. The Map
// is therefore pinned on globalThis (the same documented workaround db.ts
// uses for PrismaClient): one breaker set per PROCESS, shared by every route
// entry that links this module.
//
// Env knobs (read per call; fail-closed safe defaults; .env.example):
//   YOU_BREAKER_ENABLED           "1" (default) / "0" — off = passthrough
//   YOU_BREAKER_FAILURE_THRESHOLD failures in window to open (default 5)
//   YOU_BREAKER_WINDOW_MS         rolling failure window    (default 60000)
//   YOU_BREAKER_COOLDOWN_MS       open ⇒ half-open wait     (default 30000)
//
// ZERO-IMPORT MODULE (erasable TS only): imported directly by node:test unit
// suites under Node >= 23.6 type stripping. App callers import it via
// '@/lib/you/core/circuit-breaker'.
// ═══════════════════════════════════════════════════════════════════════════

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerConfig {
  enabled: boolean;
  failureThreshold: number;
  windowMs: number;
  cooldownMs: number;
}

export function breakerConfig(): BreakerConfig {
  const num = (name: string, fallback: number): number => {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const raw = process.env.YOU_BREAKER_ENABLED?.trim();
  return {
    enabled: raw === '0' ? false : true, // fail-safe: on unless explicitly disabled
    failureThreshold: num('YOU_BREAKER_FAILURE_THRESHOLD', 5),
    windowMs: num('YOU_BREAKER_WINDOW_MS', 60_000),
    cooldownMs: num('YOU_BREAKER_COOLDOWN_MS', 30_000),
  };
}

/** Typed fail-fast error — the "provider is down, do not hammer it" signal. */
export class ProviderUnavailableError extends Error {
  readonly code = 'provider_unavailable' as const;
  readonly provider: string;
  readonly breakerState: BreakerState;
  /** When it would be reasonable to try again (ms from now). */
  readonly retryAfterMs: number;
  constructor(provider: string, breakerState: BreakerState, retryAfterMs: number, detail: string) {
    super(
      `provider "${provider}" is unavailable (circuit breaker ${breakerState}) — ${detail}` +
        (retryAfterMs > 0 ? `; reasonable to retry in ~${Math.ceil(retryAfterMs / 1000)}s` : ''),
    );
    this.name = 'ProviderUnavailableError';
    this.provider = provider;
    this.breakerState = breakerState;
    this.retryAfterMs = retryAfterMs;
  }
}

interface BreakerBox {
  state: BreakerState;
  failures: number[]; // epoch-ms timestamps, rolling window
  openedAt: number | null;
  openedReason: string | null;
  lastError: string | null;
  lastFailureAt: number | null;
  probeInFlight: boolean;
  successCount: number;
  failureCount: number; // lifetime (informational)
}

/** globalThis pinning surface (see SHARING NOTE above). */
interface BreakerGlobalStore {
  __youBreakerBoxes?: Map<string, BreakerBox>;
}
const breakerGlobal = globalThis as typeof globalThis & BreakerGlobalStore;
const boxes: Map<string, BreakerBox> = (breakerGlobal.__youBreakerBoxes ??= new Map<string, BreakerBox>());

function box(provider: string): BreakerBox {
  let b = boxes.get(provider);
  if (!b) {
    b = {
      state: 'closed', failures: [], openedAt: null, openedReason: null,
      lastError: null, lastFailureAt: null, probeInFlight: false,
      successCount: 0, failureCount: 0,
    };
    boxes.set(provider, b);
  }
  return b;
}

function pruneWindow(b: BreakerBox, windowMs: number, now: number): void {
  while (b.failures.length > 0 && now - b.failures[0] > windowMs) b.failures.shift();
}

function open(b: BreakerBox, now: number, reason: string): void {
  b.state = 'open';
  b.openedAt = now;
  b.openedReason = reason;
  b.probeInFlight = false;
}

export interface BreakerStatus {
  state: BreakerState;
  failuresInWindow: number;
  failureThreshold: number;
  windowMs: number;
  cooldownMs: number;
  openedAt: string | null;
  openedReason: string | null;
  lastError: string | null;
  lastFailureAt: string | null;
  retryAfterMs: number;
  successCount: number;
  failureCount: number;
}

/** Honest per-provider snapshot for the metrics surface (read-only: never mutates the box). */
export function breakerSnapshot(): Record<string, BreakerStatus> {
  const cfg = breakerConfig();
  const now = Date.now();
  const out: Record<string, BreakerStatus> = {};
  for (const [provider, b] of boxes) {
    const retryAfterMs =
      b.state === 'open' && b.openedAt !== null
        ? Math.max(0, b.openedAt + cfg.cooldownMs - now)
        : 0;
    out[provider] = {
      state: b.state,
      failuresInWindow: b.failures.reduce((n, ts) => (now - ts <= cfg.windowMs ? n + 1 : n), 0),
      failureThreshold: cfg.failureThreshold,
      windowMs: cfg.windowMs,
      cooldownMs: cfg.cooldownMs,
      openedAt: b.openedAt !== null ? new Date(b.openedAt).toISOString() : null,
      openedReason: b.openedReason,
      lastError: b.lastError,
      lastFailureAt: b.lastFailureAt !== null ? new Date(b.lastFailureAt).toISOString() : null,
      retryAfterMs,
      successCount: b.successCount,
      failureCount: b.failureCount,
    };
  }
  return out;
}

/**
 * READ-ONLY availability check — safe to call from routes before accepting
 * provider-dependent work. Throws ProviderUnavailableError while the breaker
 * is open and cooling; passes when closed, half-open, or when the cooldown
 * has elapsed (the next real provider call becomes the recovery probe).
 * Never mutates breaker state.
 */
export function assertProviderAvailable(provider: string, now: () => number = Date.now): void {
  const cfg = breakerConfig();
  if (!cfg.enabled) return;
  const b = box(provider);
  if (b.state !== 'open') return; // closed or half-open — probe capacity is enforced at call time
  const t = now();
  if (b.openedAt !== null && t - b.openedAt >= cfg.cooldownMs) return; // probes admissible now
  const retryAfterMs = Math.max(0, (b.openedAt ?? t) + cfg.cooldownMs - t);
  throw new ProviderUnavailableError(provider, 'open', retryAfterMs, 'cooldown has not elapsed');
}

/**
 * Run `fn` under the provider's breaker. Semantics:
 *  - refuses (throws ProviderUnavailableError) without calling fn while open /
 *    cooling or while a half-open probe is already in flight (single-flight);
 *  - the first call after the cooldown IS the recovery probe;
 *  - success closes + clears (half-open recovery, fresh window in closed);
 *  - failure records into the rolling window and may open the breaker;
 *  - the fn's own error is rethrown VERBATIM after recording.
 * Injectable clock for deterministic tests.
 */
export async function callWithBreaker<T>(
  provider: string,
  fn: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const cfg = breakerConfig();
  if (!cfg.enabled) return fn(); // off = pure passthrough (no state recorded)
  const b = box(provider);
  let isProbe = false;
  const t0 = now();
  if (b.state === 'open') {
    if (b.openedAt !== null && t0 - b.openedAt >= cfg.cooldownMs) {
      // cooldown elapsed — THIS call becomes the single recovery probe
      b.state = 'half-open';
      b.probeInFlight = true;
      isProbe = true;
    } else {
      const retryAfterMs = Math.max(0, (b.openedAt ?? t0) + cfg.cooldownMs - t0);
      throw new ProviderUnavailableError(provider, 'open', retryAfterMs, 'cooldown has not elapsed');
    }
  } else if (b.state === 'half-open') {
    if (b.probeInFlight) {
      throw new ProviderUnavailableError(
        provider, 'half-open', 250,
        'a recovery probe is already in flight — refusing to stampede the provider',
      );
    }
    b.probeInFlight = true;
    isProbe = true;
  }
  try {
    const value = await fn();
    b.successCount += 1;
    if (b.state === 'half-open') {
      // probe succeeded — close and clear the failure window
      b.state = 'closed';
      b.failures = [];
      b.openedAt = null;
      b.openedReason = null;
    }
    return value;
  } catch (err) {
    const t = now();
    b.failureCount += 1;
    b.lastFailureAt = t;
    b.lastError = err instanceof Error ? err.message : String(err);
    if (b.state === 'half-open') {
      // probe failed — reopen with a fresh cooldown
      open(b, t, `half-open probe failed: ${b.lastError.slice(0, 200)}`);
    } else {
      b.failures.push(t);
      pruneWindow(b, cfg.windowMs, t);
      if (b.failures.length >= cfg.failureThreshold) {
        open(b, t, `${b.failures.length} failures within the ${cfg.windowMs}ms window`);
      }
    }
    throw err;
  } finally {
    if (isProbe) b.probeInFlight = false; // only the probe holder releases the slot
  }
}

/**
 * Manual reset (operator): force-close with a FRESH box — the provider stays
 * visible in snapshots as `closed` (an operator resetting `openrouter` and
 * then seeing it vanish from the snapshot would be surprising), with zeroed
 * failure window and lifetime counters.
 */
export function resetBreaker(provider: string): void {
  boxes.set(provider, {
    state: 'closed', failures: [], openedAt: null, openedReason: null,
    lastError: null, lastFailureAt: null, probeInFlight: false,
    successCount: 0, failureCount: 0,
  });
}

/** Manual trip (operator): force-open immediately with a stated reason. */
export function tripBreaker(provider: string, reason = 'manually tripped by operator'): void {
  const b = box(provider);
  open(b, Date.now(), reason);
}
