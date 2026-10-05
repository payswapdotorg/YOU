// ═══════════════════════════════════════════════════════════════════════════
// Cost budgets — the PURE half of the PR-13 budget layer (Worker C, P6.C12).
//
// Owns everything that must be unit-testable without the app toolchain:
//   - the budget-config resolution RULES (db row specificity → env → the
//     documented default; unlimited is an EXPLICIT env opt-in, never a
//     default — the fail-closed law);
//   - the pure guard decision (accrued spend + new quote vs budget, compared
//     in ROUNDED CENTS so binary float artifacts can never flip a refusal —
//     the same law as compute-routing.ts quotaDecision);
//   - the accrual row shape (UsageRecord metric 'compute.quoted_usd') and the
//     per-pipeline / per-application aggregation over those rows;
//   - the rolling-period math (the last periodHours — matching the C3 quota
//     window semantics).
//
// ZERO-IMPORT MODULE (erasable TS only — no `@/` aliases, no runtime deps):
// imported directly by node:test suites under Node >= 23.6 type stripping.
// App callers import it via '@/lib/you/lab/cost-budgets'.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Accrual metric (UsageRecord rows) ──────────────────────────────────────

/**
 * The usage metric broker submits accrue under. One row per ACCEPTED broker
 * submit, quantity = the submit-time quote's cost.usd (modeled-basis — the
 * conservative upper bound that counts failed/dead/cancelled submits too,
 * exactly like the C3 quota window spend). meta carries
 * { workload, providerId, jobId, applicationActorId, basis }.
 */
export const BUDGET_METRIC = 'compute.quoted_usd';

/** Default budget period (rolling window) — matches the C3 QUOTA_WINDOW_HOURS. */
export const DEFAULT_BUDGET_PERIOD_HOURS = 24;

/** The documented fail-closed default ceiling (no db row, no env override). */
export const DEFAULT_BUDGET_USD = 50;

// ─── Budget config sources ──────────────────────────────────────────────────

export type BudgetSource =
  | 'db:application+pipeline'
  | 'db:application'
  | 'db:pipeline'
  | 'db:tenant'
  | 'env'
  | 'default';

export interface BudgetConfig {
  readonly source: BudgetSource;
  readonly mode: 'limited' | 'unlimited';
  /** finite budget USD when mode='limited'; null when mode='unlimited'. */
  readonly budgetUsd: number | null;
  readonly periodHours: number;
  /**
   * The scope the budget applies to. 'env'/'default' configs are
   * tenant-wide; db configs carry the row's application/pipeline scoping.
   */
  readonly applicationId: string | null;
  readonly pipeline: string | null;
  readonly note: string;
}

// ─── Env parse (the unlimited EXPLICIT opt-in) ─────────────────────────────

export const BUDGET_ENV = 'YOU_COMPUTE_TENANT_MAX_COST_USD';

/** Explicit opt-in tokens that disable the env/default guard entirely. */
export const UNLIMITED_ENV_TOKENS: readonly string[] = ['unlimited', 'none', 'off'];

export const COMPUTE_BUDGET_EXCEEDED_CODE = 'compute_quota_exceeded';
export const COMPUTE_BUDGET_UNVERIFIABLE_CODE = 'compute_quota_unverifiable';

/**
 * Parse the env ceiling. Law (unchanged from C3 for the numeric cases):
 *   - unset / empty / non-numeric / negative → the documented DEFAULT (a
 *     garbage value can never silently disable the guard — fail-closed);
 *   - an explicit "0" is a VALID operator choice (block all paid work);
 *   - P6.C12: an explicit unlimited-token ('unlimited' | 'none' | 'off',
 *     case-insensitive) is the ONLY way to disable the guard — unlimited is
 *     an explicit opt-in, never a default.
 */
export function parseEnvBudget(raw: string | undefined): BudgetConfig {
  const trimmed = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (trimmed !== '' && UNLIMITED_ENV_TOKENS.includes(trimmed)) {
    return {
      source: 'env',
      mode: 'unlimited',
      budgetUsd: null,
      periodHours: DEFAULT_BUDGET_PERIOD_HOURS,
      applicationId: null,
      pipeline: null,
      note: `${BUDGET_ENV}="${raw?.trim()}" — the EXPLICIT operator opt-out of the cost guard (unlimited is never a default; db budget rows still apply)`,
    };
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n >= 0) {
      return {
        source: 'env',
        mode: 'limited',
        budgetUsd: n,
        periodHours: DEFAULT_BUDGET_PERIOD_HOURS,
        applicationId: null,
        pipeline: null,
        note: `${BUDGET_ENV}=${n} (tenant-wide env ceiling; db budget rows are MORE specific and win)`,
      };
    }
  }
  return {
    source: 'default',
    mode: 'limited',
    budgetUsd: DEFAULT_BUDGET_USD,
    periodHours: DEFAULT_BUDGET_PERIOD_HOURS,
    applicationId: null,
    pipeline: null,
    note: `no budget config — the documented fail-closed default $${DEFAULT_BUDGET_USD} applies (unlimited is an explicit opt-in, never a default)`,
  };
}

// ─── Db row selection (pure specificity rules) ──────────────────────────────

/** A CostBudget row as the db-bound half passes it in (shape-only). */
export interface BudgetRow {
  readonly id: string;
  readonly applicationId: string | null;
  readonly pipeline: string | null;
  readonly budgetUsd: number;
  readonly periodHours: number;
  readonly note: string | null;
  readonly updatedAt: Date;
}

export interface BudgetScope {
  readonly tenantId: string;
  /** the submitting application actor (API key id) when actorType='application'. */
  readonly applicationId: string | null;
  /** the broker workload being submitted ('render.image' | 'render.video' | 'twin.compile'). */
  readonly workload: string;
}

/**
 * Specificity rank: (tenant, application, pipeline)=3 > (tenant, application)=2
 * > (tenant, pipeline)=1 > (tenant,)=0. Rows outside the scope (a different
 * applicationId, a different pipeline) never match.
 */
export function budgetRowRank(row: BudgetRow, scope: BudgetScope): number {
  if (row.applicationId !== null && row.applicationId !== scope.applicationId) return -1;
  if (row.pipeline !== null && row.pipeline !== scope.workload) return -1;
  let rank = 0;
  if (row.applicationId !== null) rank += 2;
  if (row.pipeline !== null) rank += 1;
  return rank;
}

/**
 * Pick the MOST SPECIFIC budget row for the scope. Ties (possible because
 * SQLite unique indexes allow repeated NULL composite keys) break to the most
 * recently updated row — deterministic within a query result set. Invalid rows
 * (non-finite or negative budgetUsd — unlimited is never a row value) are
 * skipped: a garbage row can never disable the guard.
 */
export function pickBudgetRow(rows: readonly BudgetRow[], scope: BudgetScope): BudgetRow | null {
  let best: BudgetRow | null = null;
  let bestRank = -1;
  for (const row of rows) {
    const rank = budgetRowRank(row, scope);
    if (rank < 0) continue;
    if (!Number.isFinite(row.budgetUsd) || row.budgetUsd < 0) continue;
    if (!Number.isFinite(row.periodHours) || row.periodHours <= 0) continue;
    if (
      best === null ||
      rank > bestRank ||
      (rank === bestRank && row.updatedAt.getTime() > best.updatedAt.getTime())
    ) {
      best = row;
      bestRank = rank;
    }
  }
  return best;
}

/** The BudgetConfig for a picked db row. */
export function budgetConfigFromRow(row: BudgetRow): BudgetConfig {
  const source: BudgetSource =
    row.applicationId !== null && row.pipeline !== null
      ? 'db:application+pipeline'
      : row.applicationId !== null
        ? 'db:application'
        : row.pipeline !== null
          ? 'db:pipeline'
          : 'db:tenant';
  return {
    source,
    mode: 'limited',
    budgetUsd: row.budgetUsd,
    periodHours: row.periodHours,
    applicationId: row.applicationId,
    pipeline: row.pipeline,
    note: row.note ?? `db CostBudget row ${row.id} (${source})`,
  };
}

// ─── Period math (rolling windows) ──────────────────────────────────────────

export function periodStartedAt(now: Date, periodHours: number): Date {
  return new Date(now.getTime() - periodHours * 60 * 60 * 1000);
}

// ─── Pure guard decision ────────────────────────────────────────────────────

export interface BudgetRefusal {
  readonly code: typeof COMPUTE_BUDGET_EXCEEDED_CODE | typeof COMPUTE_BUDGET_UNVERIFIABLE_CODE;
  readonly message: string;
  readonly details: Record<string, unknown>;
}

export interface BudgetGuardDecision {
  readonly allowed: boolean;
  readonly config: BudgetConfig;
  readonly accruedUsd: number;
  readonly quotedUsd: number;
  readonly remainingUsd: number;
  readonly refusal: BudgetRefusal | null;
}

/**
 * The pure cost-budget guard: accrued spend in the current rolling period
 * plus the new quote must stay within the budget. Compared in ROUNDED CENTS
 * so binary float artifacts (0.04 + 0.01 vs 0.05) can never flip a refusal.
 *
 * FAIL-CLOSED: if any input is non-finite or negative (accounting broken),
 * the submit is REFUSED with the distinct unverifiable code — never guessed.
 */
export function budgetGuardDecision(opts: {
  config: BudgetConfig;
  accruedUsd: number;
  quotedUsd: number;
  workload: string;
  providerId?: string;
}): BudgetGuardDecision {
  const { config, workload } = opts;
  const accruedUsd = opts.accruedUsd;
  const quotedUsd = opts.quotedUsd;

  if (config.mode === 'unlimited') {
    return {
      allowed: true,
      config,
      accruedUsd: Number.isFinite(accruedUsd) ? accruedUsd : 0,
      quotedUsd,
      remainingUsd: Number.POSITIVE_INFINITY,
      refusal: null,
    };
  }

  const budgetUsd = config.budgetUsd ?? 0;
  const numbersOk =
    Number.isFinite(budgetUsd) && budgetUsd >= 0 &&
    Number.isFinite(accruedUsd) && accruedUsd >= 0 &&
    Number.isFinite(quotedUsd) && quotedUsd >= 0;

  if (!numbersOk) {
    return {
      allowed: false,
      config,
      accruedUsd,
      quotedUsd,
      remainingUsd: Number.NaN,
      refusal: {
        code: COMPUTE_BUDGET_UNVERIFIABLE_CODE,
        message:
          `cost-budget accounting is unverifiable for workload "${workload}" ` +
          `(budget=${budgetUsd}, accrued=${accruedUsd}, quoted=${quotedUsd}) — the submit is refused (fail-closed), never guessed`,
        details: {
          workload,
          providerId: opts.providerId ?? null,
          budgetSource: config.source,
          budgetUsd,
          accruedUsd,
          quotedUsd,
          periodHours: config.periodHours,
        },
      },
    };
  }

  const remainingCents = Math.round(budgetUsd * 100) - Math.round(accruedUsd * 100);
  const remainingUsd = remainingCents / 100;
  const projectedCents = Math.round((accruedUsd + quotedUsd) * 100);
  const budgetCents = Math.round(budgetUsd * 100);

  if (projectedCents <= budgetCents) {
    return { allowed: true, config, accruedUsd, quotedUsd, remainingUsd, refusal: null };
  }
  return {
    allowed: false,
    config,
    accruedUsd,
    quotedUsd,
    remainingUsd,
    refusal: {
      code: COMPUTE_BUDGET_EXCEEDED_CODE,
      message:
        `cost budget exceeded: accrued $${accruedUsd.toFixed(2)} + new quote $${quotedUsd.toFixed(2)} ` +
        `> budget $${budgetUsd.toFixed(2)} (${config.source}, rolling ${config.periodHours}h, modeled-basis quoted costs — ` +
        `a conservative upper bound that counts failed/dead/cancelled broker submits too) — submit refused (fail-closed)`,
      details: {
        workload,
        providerId: opts.providerId ?? null,
        budgetSource: config.source,
        budgetUsd,
        budgetApplicationId: config.applicationId,
        budgetPipeline: config.pipeline,
        accruedUsd,
        quotedUsd,
        remainingUsd,
        periodHours: config.periodHours,
        basis: 'modeled (quoted costs; observed provider pricing is not exposed to this sandbox)',
      },
    },
  };
}

// ─── Accrual aggregation (per pipeline / per application) ───────────────────

/** One accrual row as the db-bound half reads it (meta already parsed). */
export interface AccrualRow {
  readonly quantity: number;
  readonly createdAt: Date;
  readonly workload: string | null;
  readonly applicationActorId: string | null;
  readonly jobId: string | null;
}

export function parseAccrualMeta(metaJson: string | null | undefined): {
  workload: string | null;
  applicationActorId: string | null;
  jobId: string | null;
} {
  if (!metaJson) return { workload: null, applicationActorId: null, jobId: null };
  try {
    const parsed: unknown = JSON.parse(metaJson);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { workload: null, applicationActorId: null, jobId: null };
    }
    const m = parsed as Record<string, unknown>;
    return {
      workload: typeof m.workload === 'string' ? m.workload : null,
      applicationActorId: typeof m.applicationActorId === 'string' ? m.applicationActorId : null,
      jobId: typeof m.jobId === 'string' ? m.jobId : null,
    };
  } catch {
    return { workload: null, applicationActorId: null, jobId: null };
  }
}

export interface PipelineUsage {
  readonly pipeline: string;
  readonly quotedUsd: number;
  readonly submits: number;
}

export interface ApplicationUsage {
  readonly applicationActorId: string | null;
  readonly quotedUsd: number;
  readonly submits: number;
}

/** Sum of accrual quantities (rounded to cents — the guard's number). */
export function accrualSumUsd(rows: readonly AccrualRow[]): number {
  let sum = 0;
  for (const r of rows) {
    if (Number.isFinite(r.quantity) && r.quantity > 0) sum += r.quantity;
  }
  return Math.round(sum * 100) / 100;
}

/** Per-pipeline breakdown (workload null → 'unknown' — honest, never dropped). */
export function pipelineUsage(rows: readonly AccrualRow[]): PipelineUsage[] {
  const map = new Map<string, { usd: number; submits: number }>();
  for (const r of rows) {
    const key = r.workload ?? 'unknown';
    const cur = map.get(key) ?? { usd: 0, submits: 0 };
    cur.usd += Number.isFinite(r.quantity) ? r.quantity : 0;
    cur.submits += 1;
    map.set(key, cur);
  }
  return [...map.entries()]
    .map(([pipeline, v]) => ({ pipeline, quotedUsd: Math.round(v.usd * 100) / 100, submits: v.submits }))
    .sort((a, b) => b.quotedUsd - a.quotedUsd || a.pipeline.localeCompare(b.pipeline));
}

/** Per-application breakdown (null = interactive human sessions). */
export function applicationUsage(rows: readonly AccrualRow[]): ApplicationUsage[] {
  const map = new Map<string, { usd: number; submits: number }>();
  for (const r of rows) {
    const key = r.applicationActorId ?? '';
    const cur = map.get(key) ?? { usd: 0, submits: 0 };
    cur.usd += Number.isFinite(r.quantity) ? r.quantity : 0;
    cur.submits += 1;
    map.set(key, cur);
  }
  return [...map.entries()]
    .map(([applicationActorId, v]) => ({
      applicationActorId: applicationActorId === '' ? null : applicationActorId,
      quotedUsd: Math.round(v.usd * 100) / 100,
      submits: v.submits,
    }))
    .sort((a, b) => b.quotedUsd - a.quotedUsd);
}

/** Day-bucketed usage-over-time series (UTC day keys, oldest first). */
export function usageOverTime(
  rows: readonly AccrualRow[],
  days: number,
): Array<{ day: string; quotedUsd: number; submits: number }> {
  const dayMs = 24 * 60 * 60 * 1000;
  const todayUtc = new Date();
  const startOfDay = Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), todayUtc.getUTCDate());
  const buckets = new Map<number, { usd: number; submits: number }>();
  for (let i = days - 1; i >= 0; i -= 1) buckets.set(startOfDay - i * dayMs, { usd: 0, submits: 0 });
  for (const r of rows) {
    const t = r.createdAt.getTime();
    const day = Math.floor(t / dayMs) * dayMs;
    const b = buckets.get(day);
    if (!b) continue; // older than the window — not shown (the series is bounded, not total)
    b.usd += Number.isFinite(r.quantity) ? r.quantity : 0;
    b.submits += 1;
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, v]) => ({
      day: new Date(day).toISOString().slice(0, 10),
      quotedUsd: Math.round(v.usd * 100) / 100,
      submits: v.submits,
    }));
}
