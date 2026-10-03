// ═══════════════════════════════════════════════════════════════════════════
// YOU core — provider circuit breaker (Worker A lane, P6.A6 full).
//
// One breaker per provider (zai / openrouter). Semantics:
// - CLOSED: calls pass. Provider failures are recorded as timestamps in a
//   ROLLING window; reaching `failureThreshold` distinct failures inside
//   `windowMs` OPENS the breaker.
// - OPEN: calls fail fast with the typed ProviderUnavailableError — never a
//   hang, never a spin. After `cooldownMs` the breaker goes HALF-OPEN.
// - HALF-OPEN: exactly one probe call is admitted (concurrent/sequential
//   others still fail fast). Probe success → CLOSED (window cleared);
//   probe failure → OPEN again with a fresh cooldown. A probe that crashes
//   without recording goes stale after max(cooldownMs, 30s) and is replaced.
// - reset() is the manual operator path (POST /api/v1/breakers/:p/reset).
//
// A "failure" means: a retryable-class provider call exhausted its bounded
// retries (see core/resilience.ts). A provider that ANSWERED — even with a
// 4xx — is healthy and never trips the breaker.
//
// State lives on globalThis (symbol-keyed): one registry per server process,
// shared across Next route bundles / HMR reloads in dev, exactly like the
// Prisma client cache. In-memory state is per-instance — the same disclosed
// limitation as the P6.A6-interim rate limiter (multi-instance needs the
// shared store; honest until P6.T3 provisions it).
//
// IMPORT-FREE (pure logic + injectable clock) so node:test can import it
// directly via type stripping.
// ═══════════════════════════════════════════════════════════════════════════

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerConfig {
  failureThreshold: number; // failures inside windowMs that trip the breaker
  windowMs: number; // rolling failure window
  cooldownMs: number // open → half-open delay
}

export interface BreakerVerdict {
  allowed: boolean;
  state: BreakerState;
  retryAfterMs: number | null; // when open: ms until half-open
}

export interface BreakerSnapshot {
  provider: string;
  state: BreakerState;
  failureThreshold: number;
  windowMs: number;
  cooldownMs: number;
  failuresInWindow: number;
  openedAt: string | null; // ISO
  lastFailureAt: string | null; // ISO
  retryAfterMs: number | null;
  probeInFlight: boolean;
}

/** Typed degraded-state error: the provider is refused FAST, with guidance. */
export class ProviderUnavailableError extends Error {
  readonly kind = 'provider-unavailable';
  readonly provider: string;
  readonly state: BreakerState;
  readonly retryAfterMs: number;
  constructor(provider: string, state: BreakerState, retryAfterMs: number) {
    const waitSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
    super(
      `provider "${provider}" is unavailable (circuit breaker ${state}) — refusing to call it instead of hanging; retry in ~${waitSec}s (the breaker half-opens automatically) or ask the operator to reset it`,
    );
    this.name = 'ProviderUnavailableError';
    this.provider = provider;
    this.state = state;
    this.retryAfterMs = retryAfterMs;
  }
}

export class CircuitBreaker {
  private failures: number[] = [];
  private openedAt: number | null = null;
  private lastFailureAt: number | null = null;
  private probeAt: number | null = null;
  // (fields are explicit — parameter properties are not strip-only-compatible
  // for the node:test type-stripping import path; see file header)
  readonly provider: string;
  private readonly cfg: BreakerConfig;
  private readonly now: () => number;

  constructor(provider: string, cfg: BreakerConfig, now: () => number = Date.now) {
    this.provider = provider;
    this.cfg = cfg;
    this.now = now;
  }

  private get probeMaxAgeMs(): number {
    return Math.max(this.cfg.cooldownMs, 30_000);
  }

  private prune(t: number): void {
    this.failures = this.failures.filter((ts) => t - ts < this.cfg.windowMs);
  }

  private stateAt(t: number): { state: BreakerState; retryAfterMs: number | null } {
    if (this.openedAt === null) return { state: 'closed', retryAfterMs: null };
    const age = t - this.openedAt;
    if (age < this.cfg.cooldownMs) return { state: 'open', retryAfterMs: this.openedAt + this.cfg.cooldownMs - t };
    return { state: 'half-open', retryAfterMs: null };
  }

  /**
   * Admit-or-refuse a call. CONSUMES the half-open probe slot when it
   * returns allowed=true in half-open — the caller MUST then report via
   * recordSuccess()/recordFailure().
   */
  canExecute(): BreakerVerdict {
    const t = this.now();
    this.prune(t);
    const { state, retryAfterMs } = this.stateAt(t);
    if (state === 'closed') return { allowed: true, state, retryAfterMs: null };
    if (state === 'open') return { allowed: false, state, retryAfterMs };
    // half-open: one live probe at a time (stale probes are re-taken)
    const probeLive = this.probeAt !== null && t - this.probeAt < this.probeMaxAgeMs;
    if (probeLive) return { allowed: false, state: 'half-open', retryAfterMs: 0 };
    this.probeAt = t;
    return { allowed: true, state: 'half-open', retryAfterMs: null };
  }

  /** Read-only verdict — never consumes the probe (route pre-flight use). */
  peek(): BreakerVerdict {
    const t = this.now();
    this.prune(t);
    const { state, retryAfterMs } = this.stateAt(t);
    if (state === 'open') return { allowed: false, state, retryAfterMs };
    if (state === 'half-open') {
      const probeLive = this.probeAt !== null && t - this.probeAt < this.probeMaxAgeMs;
      return { allowed: !probeLive, state: 'half-open', retryAfterMs: null };
    }
    return { allowed: true, state: 'closed', retryAfterMs: null };
  }

  recordSuccess(): void {
    this.probeAt = null;
    this.openedAt = null;
    this.failures = [];
  }

  recordFailure(): void {
    const t = this.now();
    this.probeAt = null;
    this.lastFailureAt = t;
    this.failures.push(t);
    this.prune(t);
    if (this.openedAt !== null) {
      // failed probe (or failure while open): re-open with a fresh cooldown
      this.openedAt = t;
      return;
    }
    if (this.failures.length >= this.cfg.failureThreshold) {
      this.openedAt = t;
    }
  }

  /** Manual operator reset: closed, empty window (POST /api/v1/breakers/:p/reset). */
  reset(): void {
    this.failures = [];
    this.openedAt = null;
    this.probeAt = null;
  }

  snapshot(): BreakerSnapshot {
    const t = this.now();
    this.prune(t);
    const { state, retryAfterMs } = this.stateAt(t);
    return {
      provider: this.provider,
      state,
      failureThreshold: this.cfg.failureThreshold,
      windowMs: this.cfg.windowMs,
      cooldownMs: this.cfg.cooldownMs,
      failuresInWindow: this.failures.length,
      openedAt: this.openedAt !== null ? new Date(this.openedAt).toISOString() : null,
      lastFailureAt: this.lastFailureAt !== null ? new Date(this.lastFailureAt).toISOString() : null,
      retryAfterMs: state === 'open' ? retryAfterMs : null,
      probeInFlight: state === 'half-open' && this.probeAt !== null && t - this.probeAt < this.probeMaxAgeMs,
    };
  }
}

// ─── Registry (globalThis — one set of breakers per server process) ─────────

export const PROVIDER_NAMES = ['zai', 'openrouter'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

const REGISTRY_KEY = Symbol.for('you.core.breakers');

interface BreakerRegistryStore {
  breakers: Map<string, CircuitBreaker>;
}

function registry(): Map<string, CircuitBreaker> {
  const g = globalThis as Record<symbol, BreakerRegistryStore | undefined>;
  let store = g[REGISTRY_KEY];
  if (!store) {
    store = { breakers: new Map() };
    g[REGISTRY_KEY] = store;
  }
  return store.breakers;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback; // fail-closed safe default
  return n;
}

/**
 * Breaker knobs (per-provider override > platform default > safe built-in):
 *   YOU_BREAKER_<PROVIDER>_FAILURES / _WINDOW_MS / _COOLDOWN_MS
 *   YOU_PROVIDER_BREAKER_FAILURES / _WINDOW_MS / _COOLDOWN_MS (defaults 5 / 60s / 30s)
 */
export function breakerEnvConfig(provider: string): BreakerConfig {
  const p = provider.toUpperCase();
  return {
    failureThreshold: envNum(`YOU_BREAKER_${p}_FAILURES`, envNum('YOU_PROVIDER_BREAKER_FAILURES', 5)),
    windowMs: envNum(`YOU_BREAKER_${p}_WINDOW_MS`, envNum('YOU_PROVIDER_BREAKER_WINDOW_MS', 60_000)),
    cooldownMs: envNum(`YOU_BREAKER_${p}_COOLDOWN_MS`, envNum('YOU_PROVIDER_BREAKER_COOLDOWN_MS', 30_000)),
  };
}

/** Get (lazily create) the process-wide breaker for a provider. */
export function providerBreaker(provider: string): CircuitBreaker {
  const map = registry();
  let breaker = map.get(provider);
  if (!breaker) {
    breaker = new CircuitBreaker(provider, breakerEnvConfig(provider));
    map.set(provider, breaker);
  }
  return breaker;
}

/** All live breakers (metrics surface). */
export function providerBreakersSnapshot(): Record<string, BreakerSnapshot> {
  const out: Record<string, BreakerSnapshot> = {};
  for (const breaker of registry().values()) out[breaker.provider] = breaker.snapshot();
  return out;
}

/** Manual reset (operator route). Throws on unknown provider names. */
export function resetProviderBreaker(provider: string): BreakerSnapshot {
  if (!(PROVIDER_NAMES as readonly string[]).includes(provider)) {
    throw new Error(`unknown provider "${provider}" — known providers: ${PROVIDER_NAMES.join(', ')}`);
  }
  const breaker = providerBreaker(provider);
  breaker.reset();
  return breaker.snapshot();
}
