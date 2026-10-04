# Cost budgets & latency SLOs (P6.C12 — PR-13)

This document is the operator guide for the cost/latency optimization lane:

1. [Cost budgets (PR-13)](#1-cost-budgets-pr-13) — enforced before dispatch
2. [Latency budgets on hot paths](#2-latency-budgets-on-hot-paths) — declared SLOs, observed measurements
3. [Optimizations with evidence](#3-optimizations-with-evidence) — run-id-cited before/after records
4. [The dashboard](#4-the-dashboard) — Usage & Billing → Cost & Latency
5. [Honesty labels](#5-honesty-labels) — observed vs modeled vs declared
6. [Tests & gates](#6-tests--gates)

---

## 1. Cost budgets (PR-13)

Every broker-submitted workload (`render.image`, `render.video` via
`POST /api/v1/renders`; the routed submission surface is
`submitComputeRouted` in `apps/web/src/lib/you/lab/compute.ts`) is checked
against a cost budget **BEFORE dispatch**: the per-job quote (computed by the
C3 broker from the shared honest-cost tables) plus the tenant's accrued spend
in the current rolling period must stay within the budget, or the submit
fails fast with the typed 402 `compute_quota_exceeded` envelope — never a
silent skip, never a queued-forever job (the RenderJob row is marked `failed`
with the verbatim refusal).

### Budget resolution (most specific wins)

| Priority | Source | Scope |
| --- | --- | --- |
| 1 | `CostBudget` row `(tenantId, applicationId, pipeline)` | per application actor AND workload |
| 2 | `CostBudget` row `(tenantId, applicationId)` | per application actor |
| 3 | `CostBudget` row `(tenantId, pipeline)` | per workload |
| 4 | `CostBudget` row `(tenantId)` | tenant-wide |
| 5 | env `YOU_COMPUTE_TENANT_MAX_COST_USD` | tenant-wide fallback |
| 6 | documented default **$50** / rolling 24h | the fail-closed default |

- **`applicationId`** is the submitting APPLICATION ACTOR (an API key id —
  `AuthContext.actorType === 'application'`). Interactive human sessions
  accrue tenant-wide (`application null`).
- **`pipeline`** is a broker workload (`render.image` | `render.video` |
  `twin.compile`) or null for all workloads.
- Invalid rows (negative/non-finite `budgetUsd`, non-positive `periodHours`)
  are skipped — a garbage row can never disable the guard. Ties break to the
  most recently updated row.
- **UNLIMITED is an explicit opt-in, never a default.** The ONLY way to
  disable the env/default guard is an explicit env token:
  `YOU_COMPUTE_TENANT_MAX_COST_USD=unlimited` (aliases: `none`, `off`).
  Unset/garbage/negative values fall back to the fail-closed default.
  A db `CostBudget` row always enforces (finite values only — unlimited is
  never a row value).
- **Periods are rolling windows** (the last `periodHours`), matching the C3
  quota semantics. Accrual older than the period drops out (reset semantics).

### Seeding budget rows

The contracts inventory is frozen — there is deliberately **no API write
surface** for budgets (the TL freezes new route operations at landing).
Operators seed rows directly:

```js
// e.g. from apps/web with the Prisma client
await db.costBudget.create({
  data: {
    tenantId: '<tenant id>',
    applicationId: null,          // or the API-key actor id
    pipeline: 'render.image',     // or null for all workloads
    budgetUsd: 25,
    periodHours: 24,              // rolling window
    note: 'production render budget',
  },
});
```

The contract test suite (`tests/contract/lab-cost-latency.test.mjs`) seeds
rows exactly this way.

### Usage accrual

Every accepted broker submit writes a `UsageRecord` row:

- `metric`: `compute.quoted_usd`
- `quantity`: the submit-time quote's `cost.usd`
- `meta`: `{ workload, providerId, jobId, applicationActorId, basis }`

The accrual is the durable per-tenant / per-application / per-pipeline usage
truth behind both the guard's window spend and the usage API. It is the
conservative upper bound (failed/dead/cancelled submits are counted too —
the fail-closed direction), and it is always **modeled-basis**: provider
pricing is not exposed to this sandbox, so every quoted cost is labeled
`modeled`, never `observed`.

### The usage API

`GET /api/v1/usage` (session or read-scoped API key; tenant-scoped) gained
two ADDITIVE sections — the legacy `metrics`/`totals` shape is unchanged:

```jsonc
{
  "metrics": [...], "totals": {...},        // legacy, unchanged
  "cost": {
    "basis": "modeled (quoted costs; ...)",
    "budget": {
      "mode": "limited", "source": "db:tenant",   // db:*|env|default
      "budgetUsd": 25, "periodHours": 24,
      "periodStartedAt": "...", "accruedUsd": 0.04,
      "remainingUsd": 24.96, "note": "..."
    },
    "byPipeline": [{ "pipeline": "render.image", "quotedUsd": 0.04, "submits": 1 }],
    "byApplication": [{ "applicationActorId": null, "quotedUsd": 0.04, "submits": 1 }],
    "series": [{ "day": "2026-10-04", "quotedUsd": 0.04, "submits": 1 }],  // 14 days
    "accrualMetric": "compute.quoted_usd"
  },
  "optimizations": [...]   // see §3
}
```

## 2. Latency budgets on hot paths

### Declared SLOs

| Bucket | Covers | p95 target |
| --- | --- | --- |
| `api.read` | GET `/api/v1/session`, `/overview`, `/twins`, `/usage`, `/metrics` | 250 ms |
| `live.session.setup` | POST `/api/v1/live-sessions` (consent → row → signaling token) | 200 ms |
| `live.state.stream` | POST `/api/v1/live-sessions/:id/state` (idempotent state append) | 100 ms |

These are **declared** targets (ours, not provider SLAs) — see
`apps/web/src/lib/you/core/latency.ts` (`SLO_DECLARATIONS`).

### The measurement point (honest disclosure)

The P6.A7 middleware issues the `x-request-id` (the observability baseline
correlation field), but a Next.js middleware **cannot observe response
completion** — `NextResponse.next()` resolves before the route handler runs.
So the honest server-side measurement point is the route-handler wrapper:
`handleRoute(fn, { request, slo })` in `apps/web/src/lib/you/core/errors.ts`
measures the REAL handler wall-clock and records it scoped by the
middleware-issued request id. Routes without `opts` keep byte-identical
behavior (zero overhead).

### The metrics surface

`GET /api/v1/metrics` (operator session only — API keys refused) gained a
`latency` section:

```jsonc
{
  "counters": { ..., "slo_breaches{bucket=api.read}": 2 },
  "latency": {
    "slos": [{
      "id": "api.read", "targetP95Ms": 250, "basis": "declared SLO ...",
      "observations": 512, "totalObservations": 1042, "breaches": 2,
      "p50Ms": 41, "p95Ms": 212, "percentileMethod": "nearest-rank over ...",
      "lastObservation": { "requestId": "...", "route": "GET /api/v1/twins", ... }
    }],
    "scope": "process-local ring buffers (last 512 per SLO) — ...",
    "honesty": ["p50/p95 are computed from observed handler wall-clock only — ...", ...]
  }
}
```

- p50/p95 are **nearest-rank over real observations only** — every percentile
  is a value that was actually measured; no interpolation, no fabrication.
- Zero observations → `null` percentiles (unknown is unknown).
- Observations live in process-local ring buffers (last 512 per bucket,
  pinned on `globalThis` — the same next-dev module-registry law as the A6
  counters). Multi-instance deployments under-observe by the instance count;
  the surface says so instead of implying global truth.
- Breach counters are lifetime counters (not ring-buffer-scoped) and are
  merged into the canonical counters view as `slo_breaches{bucket=…}`.

## 3. Optimizations with evidence

Evidence-driven only: every optimization cites the benchmark run-ids it is
based on, and those ids resolve to real `BenchmarkRun` rows. The wiring lives
in `apps/web/src/lib/you/lab/optimization-evidence.ts`; the records surface
via `GET /api/v1/usage` → `optimizations` and the dashboard.

### 3.1 Parallelized independent per-organization evaluation (latency)

- **Changed**: `evaluateOrganizations` (`apps/web/src/lib/you/lab/benchmark.ts`)
  now runs the per-org evaluations concurrently (`Promise.all`). The
  sequential path is preserved verbatim as `evaluationMode: "sequential"` —
  the pre-C12 code path, kept for reproduction.
- **Evidence**: the same worldSeed evaluated in both modes through the REAL
  app (`POST /api/v1/lab/runs { worldSeed, evaluationMode }`). The run
  persists `metrics.costLatency.evaluation.{mode, wallClockMs}` (observed).
  The pairing picks the latest sequential + parallel runs per seed.
- **What it does NOT change**: per-org scores. Coverage/confidence/determinism
  are pure functions of (world, genome) — byte-identical across modes. Each
  org's `latencyMs` keeps its own grounding measurement. Only the RUN's
  wall-clock improves (sequential ≈ sum of orgs; parallel ≈ max).
- **Reproduce**: `POST /api/v1/lab/runs` twice with the same seed, once with
  `evaluationMode: "sequential"`, once with `"parallel"` (the default), then
  read `GET /api/v1/usage` → `optimizations`.

### 3.2 Content-hash cache for deterministic sub-results (latency+cost)

- **Changed**: `generateWorld(seed)` and `compileOrganizations(...)` run
  behind a bounded process-local memo cache
  (`apps/web/src/lib/you/lab/hot-path-cache.ts`) keyed by sha256 over the
  stable-stringified inputs — a mutated genome compiles under a different key
  and never reuses the un-mutated compile.
- **Evidence**: a cold-cache run (both caches miss) vs a warm-cache run (both
  hit) on the same seed in one process. The run persists
  `metrics.costLatency.compile.{worldKey, orgKey, worldCacheHit, orgCacheHit,
  cacheHits, cacheMisses, worldCompileMs}` (observed).
- **Honest scope**: the absolute win is small (world generation + compilation
  are fast pure functions) — the numbers are reported exactly as measured,
  never exaggerated. Provider grounding calls are NEVER cached (that would
  fake latency evidence).
- **Reproduce**: run the same seed twice in one process (the test suite does
  exactly this and asserts cold→warm pairing).

### Development-sandbox evidence runs

The contract suite (`lab-cost-latency.test.mjs`, test 14) generates the
canonical evidence pair on every gate run: two real lab runs (sequential,
then parallel) on one seed, with the run-ids asserted to exist and the
parallel wall-clock asserted ≤ sequential. The dashboard renders whatever
pairs exist in the current deployment's database — on a fresh deployment it
shows honest empty states ("awaiting paired runs") rather than the
development sandbox's historical numbers.

The verification run that gated this branch (station sandbox, 2026-10-04,
worldSeed 424942, three baseline organizations, real in-pod z-ai grounding
calls) produced this pair:

| Side | Run id | Mode | Cache | Evaluation wall-clock | Grounding calls |
| --- | --- | --- | --- | --- | --- |
| before | `cmutu05e400sli9h4ybotowmv` | sequential | cold | 1460 ms | 3/3 real (760 + 223 + 475 = 1458 ms serial) |
| after | `cmutu06q200tdi9h4cb0gsogq` | parallel | warm | 891 ms | 1/3 real (326 ms), 2/3 honestly `unavailable` (provider 429 mid-run) |

Honest readings of that pair: the sequential wall-clock is the serial sum of
three real measured grounding latencies (1458 ≈ 1460 ms); the parallel
wall-clock is well under it even though two of its three grounding calls
were rate-limited mid-run (labeled `unavailable` — no measurement claimed,
per-org coverage/confidence identical across modes: 0.6 / 0.8 / 0.8). The
same pair is the cache evidence (cold → warm on identical content keys).

## 4. The dashboard

`Usage & Billing` view → **Cost & Latency** section
(`apps/web/src/components/you/develop/cost-latency-panel.tsx`):

- **Cost budget** — mode/source/budget/accrued/remaining + consumption bar;
  unlimited shows an explicit-opt-in badge.
- **Quoted-cost usage** — 14-day usage-over-time chart + per-pipeline and
  per-application breakdown tables (honest zeros on fresh deployments).
- **Latency SLOs** — target vs observed p50/p95 per bucket, observation
  counts, breach badges, honest "no observations yet" nulls.
- **Optimization evidence** — before/after cards with cited run-ids, deltas
  and improvement %, or the empty-state reason when no pair exists.

The metrics surface is operator-session gated — the dashboard shows an
honest "metrics unavailable" state for API-key sessions instead of guessing.

## 5. Honesty labels

| Label | Meaning | Where |
| --- | --- | --- |
| `observed` | a real measurement (handler wall-clock, grounding-call latency, evaluation wall-clock) | latency stats, run `costLatency` |
| `modeled` | an estimate (quoted costs — provider pricing not exposed to this sandbox) | every quoted USD |
| `declared` | a target WE set (not a provider SLA, not a measurement) | SLO targets |
| `process-local` | single-instance truth; multi-instance aggregates at the collector | counters, breakers, latency ring buffers, hot-path cache |

Unknown is unknown: zero observations → null percentiles; no paired runs →
empty-state reasons; pre-C12 run metrics → no evidence extracted.

## 6. Tests & gates

- Suite: `tests/contract/lab-cost-latency.test.mjs` (node:test — pure unit
  over the budget/latency/evidence/cache modules + boots/reuses the shared
  app server; real broker submits, real lab runs). Imported by the
  `tests/contract/index.mjs` aggregator.
- Standalone C3 e2e gate (`node --test tests/contract/compute-broker-e2e.test.mjs`)
  was updated to the PR-13 refusal envelope (`budgetUsd`/`accruedUsd`/
  `budgetSource` instead of the C3 `ceilingUsd`/`windowSpendUsd` fields) —
  the guard semantics (fail-closed 402, counted, pre-dispatch) are unchanged.
- Station gates: `cd apps/web && bun run lint && bunx tsc --noEmit`, then
  from repo root `node --test tests/contract/` — all green before reporting.

### Known gaps (honest)

- `twin.compile` jobs are created via `createJob` directly (not through the
  broker) by the twins compile route — those submits are not budget-guarded
  or accrued. The budget layer guards the broker submission surface
  (`POST /api/v1/renders`); routing twin.compile through the broker is a
  separate lane decision.
- Latency observations and the hot-path cache are process-local (labeled);
  a shared-store rollout is the same pending full-A6 item as the counters.
- SLO targets are declared, not SLAs; no alerting is wired (the surface is
  read-only truth).
