// ═══════════════════════════════════════════════════════════════════════════
// YOU core — production configuration validation (Worker A lane, P6.A2).
//
// Boot-time fail-fast for secret/config hardening: collect EVERY violation
// once, then throw with the full list (never whack-a-mole one env var at a
// time). Called from instrumentation.ts register() — the app refuses to boot
// in production with a misconfigured secret surface.
//
// Laws:
// - dev/test stay permissive (the demo bootstrap + weak dev secrets are the
//   documented local path — .env.example is the contract);
// - production requires: YOU_STORAGE_SECRET (>= 32 chars, NOT the published
//   dev default), and the full config of any SELECTED backend/provider
//   (R2: all four vars; OpenRouter: the API key) — the same fail-closed
//   contracts the call sites enforce, validated UP FRONT instead of at
//   first upload;
// - the demo bootstrap (founder@you.dev auto-provisioning) is DISABLED in
//   production unless YOU_DEMO_BOOTSTRAP=1 opts in explicitly.
// ═══════════════════════════════════════════════════════════════════════════

export const DEV_STORAGE_SECRET_DEFAULT = 'dev-change-me';
const MIN_SECRET_LENGTH = 32;

export interface ConfigViolation {
  varName: string;
  problem: string;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Collect every production-config violation (empty list = healthy). */
export function productionConfigViolations(): ConfigViolation[] {
  const problems: ConfigViolation[] = [];

  const secret = process.env.YOU_STORAGE_SECRET?.trim() ?? '';
  if (!secret) {
    problems.push({ varName: 'YOU_STORAGE_SECRET', problem: 'missing — signs every storage capability URL' });
  } else {
    if (secret === DEV_STORAGE_SECRET_DEFAULT) {
      problems.push({ varName: 'YOU_STORAGE_SECRET', problem: 'still the published .env.example dev default — rotate before production' });
    }
    if (secret.length < MIN_SECRET_LENGTH) {
      problems.push({ varName: 'YOU_STORAGE_SECRET', problem: `only ${secret.length} chars — HMAC-SHA256 keys need >= ${MIN_SECRET_LENGTH} chars of entropy` });
    }
  }

  const backend = (process.env.YOU_STORAGE_BACKEND ?? 'fs').trim().toLowerCase();
  if (backend === 'r2') {
    for (const v of ['YOU_R2_ACCOUNT_ID', 'YOU_R2_ACCESS_KEY_ID', 'YOU_R2_SECRET_ACCESS_KEY', 'YOU_R2_BUCKET']) {
      if (!process.env[v]?.trim()) {
        problems.push({ varName: v, problem: `missing — required because YOU_STORAGE_BACKEND=r2 (fail closed at the storage seam, validated here up front)` });
      }
    }
  } else if (backend !== 'fs' && backend !== 'db') {
    problems.push({ varName: 'YOU_STORAGE_BACKEND', problem: `must be "fs", "db" or "r2" (got "${backend}")` });
  }

  const provider = (process.env.YOU_RECON_PROVIDER ?? 'local').trim().toLowerCase();
  if (provider === 'openrouter') {
    if (!process.env.OPENROUTER_API_KEY?.trim()) {
      problems.push({ varName: 'OPENROUTER_API_KEY', problem: 'missing — required because YOU_RECON_PROVIDER=openrouter (fail closed at the provider switch)' });
    }
  } else if (provider !== 'local') {
    problems.push({ varName: 'YOU_RECON_PROVIDER', problem: `must be "local" or "openrouter" (got "${provider}")` });
  }

  return problems;
}

/** Boot-time gate: throws with the complete violation list in production. */
export function assertProductionConfig(): void {
  if (!isProduction()) return;
  const problems = productionConfigViolations();
  if (problems.length) {
    const lines = problems.map((p) => `  - ${p.varName}: ${p.problem}`).join('\n');
    throw new Error(
      `YOU production configuration is not deployable — ${problems.length} violation(s):\n${lines}\n` +
      `Fix the environment (secret manager, never .env files in production) and restart.`,
    );
  }
}

/**
 * Demo bootstrap (founder@you.dev auto-provisioning on POST /api/v1/session):
 * ON in dev, OFF in production unless YOU_DEMO_BOOTSTRAP=1 opts in.
 */
export function demoBootstrapEnabled(): boolean {
  const raw = process.env.YOU_DEMO_BOOTSTRAP?.trim();
  if (raw === '1') return true;
  if (raw === '0') return false;
  return !isProduction();
}
