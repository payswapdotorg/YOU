// ═══════════════════════════════════════════════════════════════════════════
// YOU Develop — playground sandbox/test mode (P6.B9, Worker B lane).
//
// A DOCUMENTED sandbox mode for the API playground:
//   YOU_PLAYGROUND_SANDBOX=1  → playground executes route through the
//                               deterministic fixtures seam WHEN PRESENT;
//   YOU_PLAYGROUND_SANDBOX=0  → off (live execution);
//   unset / invalid           → FAIL-CLOSED to off (live execution).
//
// Honesty laws (the order's, verbatim): "honest 'sandbox unavailable' state
// when not configured — never fake responses". The deterministic fixtures
// seam is a REGISTRATION point: nothing on this base registers a fixtures
// handler, so a requested sandbox resolves to unavailable with the honest
// reason instead of inventing responses. When a future lane registers
// deterministic fixtures (registerPlaygroundFixtures), the same resolution
// flips to available — no change needed here.
//
// Zero imports (pure module + one module-scoped registry slot — the
// node:test law): importable from server routes and contract tests alike.
// ═══════════════════════════════════════════════════════════════════════════

/** The documented env placeholder name (.env.example carries it commented). */
export const PLAYGROUND_SANDBOX_ENV_VAR = 'YOU_PLAYGROUND_SANDBOX';

export interface SandboxInput {
  /** Raw env value of YOU_PLAYGROUND_SANDBOX (undefined = unset). */
  raw?: string | undefined;
}

export interface SandboxResolution {
  /** An explicit value is present in the environment (0, 1 or invalid). */
  configured: boolean;
  /** The operator asked for sandbox mode (value "1"). */
  requested: boolean;
  /** Sandbox execution is actually possible (requested + fixtures seam present). */
  available: boolean;
  /** "sandbox" only when available; "live" everywhere else (fail-closed). */
  mode: 'live' | 'sandbox';
  /** The honest, human-readable reason for this resolution. */
  reason: string;
}

/**
 * Resolve the sandbox mode. FAIL-CLOSED: unset, empty, "0" and any invalid
 * value all resolve to live execution — sandbox can never turn itself on by
 * accident. The reason never echoes the raw env value (an operator may have
 * typed a secret there by mistake — the message names the constraint only).
 */
export function resolveSandboxMode(input: SandboxInput, fixturesSeamPresent: boolean): SandboxResolution {
  const raw = input.raw;
  if (raw === undefined || raw.trim() === '') {
    return {
      configured: false,
      requested: false,
      available: false,
      mode: 'live',
      reason: `not configured — ${PLAYGROUND_SANDBOX_ENV_VAR} is unset (default off; live execution)`,
    };
  }
  const value = raw.trim();
  if (value === '0') {
    return {
      configured: true,
      requested: false,
      available: false,
      mode: 'live',
      reason: 'disabled by configuration (live execution)',
    };
  }
  if (value === '1') {
    if (!fixturesSeamPresent) {
      return {
        configured: true,
        requested: true,
        available: false,
        mode: 'live',
        reason: `requested via ${PLAYGROUND_SANDBOX_ENV_VAR}=1, but no deterministic fixtures seam is present on this deployment — live execution continues; the sandbox never fabricates responses`,
      };
    }
    return {
      configured: true,
      requested: true,
      available: true,
      mode: 'sandbox',
      reason: 'active — playground executes route through the deterministic fixtures seam',
    };
  }
  return {
    configured: true,
    requested: false,
    available: false,
    mode: 'live',
    reason: `invalid value — ${PLAYGROUND_SANDBOX_ENV_VAR} must be "0" or "1"; fail-closed to live execution`,
  };
}

// ─── the deterministic fixtures seam (registration point) ────────────────────

export interface PlaygroundFixtureCall {
  method: string;
  specPath: string;
  resolvedPath: string;
  query: Record<string, string>;
  body?: string | undefined;
}

export type PlaygroundFixtureHandler = (call: PlaygroundFixtureCall) => Promise<Response> | Response;

/**
 * Module-scoped registry slot. NOTHING registers on this base — that is the
 * honest "seam not present" state surfaced by resolveSandboxMode above. The
 * signature is the wiring point a future deterministic-fixtures lane plugs
 * into; until then it stays null and the playground says so.
 */
let registeredFixtures: PlaygroundFixtureHandler | null = null;

/** Register the deterministic fixtures handler (future lane; idempotent overwrite). */
export function registerPlaygroundFixtures(handler: PlaygroundFixtureHandler | null): void {
  registeredFixtures = handler;
}

/** The registered fixtures handler, or null when the seam is not present. */
export function playgroundFixtures(): PlaygroundFixtureHandler | null {
  return registeredFixtures;
}

/** Whether the deterministic fixtures seam is present. */
export function playgroundFixturesPresent(): boolean {
  return registeredFixtures !== null;
}
