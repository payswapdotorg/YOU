# YOU Hosted-Deployment Runbook (F9)

Status: OPERATOR RUNBOOK — wave 3, worker W3.C. The deploy itself is
operator-gated (TL promotion decision). This document is consistent with
`docs/DEPLOYMENT.md` (prototype topology checked 2026-10-01); every place the
repository implementation differs from that topology is called out explicitly
as a **gap note** and mirrored as a finding in the W3.C audit report.

Audience: the operator who executes the first hosted deployment (preview
environment first, production promotion only after the F9 acceptance checklist
passes).

---

## 0. What is being deployed

One Vercel Next.js app: `apps/web` (Studio SPA at `/` + `/api/v1` route set).
Everything else in the repository is contracts/reference (`contracts/**`,
`services/**` are interface mirrors, not deployed services — see gap note G-3).

Current local-stand-in mapping (per `docs/DEPLOYMENT.md` "local: deterministic
fixtures"):

| Stand-in (local)             | Hosted target                  | Swap point |
|------------------------------|--------------------------------|------------|
| SQLite (`apps/web/db/custom.db`) | Neon PostgreSQL            | `prisma/schema.prisma` datasource + `DATABASE_URL` |
| Local object store (`apps/web/db/you-objects/`, HMAC-signed URLs) | Cloudflare R2 (private bucket, signed access) | `src/lib/you/core/storage.ts` adapter seam |
| In-process durable job runner (Job rows + fire-and-forget) | Upstash Redis-backed queues (planned topology) | NOT yet wired — see G-2 |
| z-ai SDK provider adapters   | same adapters, hosted credentials | `src/lib/you/ai/zai.ts` (backend-only) |

## 1. Vercel app (apps/web)

### Build
- Import the GitHub repo, set **Root Directory = `apps/web`**.
- Build command: default (`next build`). Note: the package `build` script
  (`next build && cp …standalone…`) targets SELF-HOSTED standalone output —
  Vercel does not need the copy steps; leave Vercel on its default build and
  use the standalone script only for non-Vercel hosting.
- `next.config.ts` sets `output: "standalone"` — harmless on Vercel.
- All `/api/v1/**` routes run on the Node runtime (no `edge` declarations in
  the route files) — required for Prisma and the z-ai SDK. Do not move API
  routes to the edge runtime without a TL decision.
- Licensing: **Vercel Hobby is personal/non-commercial** under current Vercel
  Terms (docs/DEPLOYMENT.md). Commercial production must use a Vercel plan
  that permits it, or self-host the standalone build.

### Environment matrix (Vercel → apps/web)

| Variable | Value / source | Notes |
|---|---|---|
| `DATABASE_URL` | Neon connection string (pooled endpoint) | see §2. Include `?sslmode=require` when Neon asks for it. |
| `YOU_STORAGE_SECRET` | operator-generated 32+ byte random (e.g. `openssl rand -hex 32`) | HMAC secret for object-store signed URLs. **Local `.env.example` ships `dev-change-me` — never deploy that value.** Rotation invalidates all signed URLs (they expire in ≤600s anyway) but not stored objects. |
| `YOU_STORAGE_BACKEND` | `"db"` on hosted | **Required on serverless** — see gap note G-7. The default `"fs"` backend writes under `apps/web/db/you-objects/`, which is read-only on Vercel lambdas (live evidence: `ENOENT: mkdir '/var/task/db'` on the hosted upload path, F9 checklist item 2, 2026-10-01). `"db"` stores the same content-addressed immutable objects as `YouObject` rows in the app database (works on SQLite locally and PostgreSQL/Neon hosted; push the schema first). |
| z-ai SDK credentials | the SDK's own configuration env for the hosting environment | `src/lib/you/ai/zai.ts` is the single server-side entry point; the SDK is backend-only and must never be imported client-side. |
| `NODE_ENV` | set by Vercel | — |

No other env vars are read by `apps/web` at the pinned base
(`rg 'process.env' apps/web/src` → `DATABASE_URL` via Prisma,
`YOU_STORAGE_SECRET` in `core/storage.ts`, SDK internals). Preview/production
get separate Neon branches + R2 buckets + Redis namespaces per
docs/DEPLOYMENT.md ("preview: isolated preview DB/R2/Redis namespaces").

## 2. Neon PostgreSQL (SQLite stand-in migration)

The pinned base runs SQLite. Moving to Neon is a **code change owned by
TL/Worker A** (the prisma `provider`), executed as:

1. In a TL-approved branch, change `prisma/schema.prisma`:
   `provider = "sqlite"` → `provider = "postgresql"` (`url = env("DATABASE_URL")`
   is already env-driven — no change).
2. Column-type survey (verified at the pinned base): every JSON sub-structure
   is stored as `String` (SQLite has no list types), `DateTime` fields are
   ISO timestamps, ids are `cuid()` strings. All map to PostgreSQL
   `text`/`timestamp(3)`/`text` without data-shape changes. `@unique`
   constraints (e.g. `Template.idempotencyKey`, `Job.idempotencyKey`,
   `Tenant.slug`, `User.email`, `Session.token`, `ApiKey.hash`) become unique
   indexes — REQUIRED for the idempotency replay path that the F8 battery
   verified (P2002 catch → return existing).
3. Create the schema on Neon:
   - **Option A (recommended for the F9 gate — fresh start):** `bunx prisma db
     push` against the Neon URL. The F9 acceptance flow is fresh-browser
     sign-up → new tenant → new capture; no legacy data is required.
   - **Option B (data migration):** write a one-time ETL (SQLite `SELECT` →
     PostgreSQL `INSERT` per model, preserving ids/timestamps). Risks: 38
     models, JSON-as-string columns must be copied verbatim (they are parsed
     lazily by `parseJson`), and `TwinVersion` has no `tenantId` (tenant comes
     via `Twin` relations) — a naive "add tenantId everywhere" migration would
     be wrong. No migration history exists at the pinned base (`db push`
     stand-in), so `prisma migrate dev` will baseline, not replay.
4. Risks (explicit):
   - **Idempotency uniqueness** is only as good as the unique index — verify
     with `\d` on Neon that `Template.idempotencyKey` / `Job.idempotencyKey`
     unique constraints exist after the push (the battery's W3C-034/038 checks
     re-run in hosted acceptance).
   - SQLite `PRAGMA`-level behaviors (e.g. `busy_timeout`) do not exist on
     Postgres; Prisma handles this, but connection pooling through Neon's
     pooled endpoint is required for serverless (use the pooled URL, not the
     direct one).
   - `db.ts` enables `log: ['query']` unconditionally — on hosted this is
     noisy/log-costly; gating it behind `NODE_ENV` is a Worker A decision
     (finding F-07, low).

## 3. Cloudflare R2 (local object-store adapter swap)

### The seam (verified at the pinned base)
`src/lib/you/core/storage.ts` is the entire local adapter surface:
- `putObject(buf, {kind, mime})` → content-addressed immutable key
  `${kind}/${sha256}.${ext}` (never overwrites; `wx` flag locally)
- `getObject(key)` → bytes or null (traversal-guarded)
- `signStorageUrl(key, ttl)` → `/api/v1/storage/<key>?exp=<epochSec>&sig=<urlsafe-b64-hmac>`
- `verifyStorageSig(key, exp, sig)` → HMAC-SHA256(`${key}.${exp}`,
  `YOU_STORAGE_SECRET`), timing-safe compare, expiry-checked
- `mimeFromKey/extFromMime` maps

Consumers: `POST /api/v1/captures/:id/assets` (put), `GET
/api/v1/evidence/:id/url` (sign; SESSION-ONLY auth — raw evidence is never
exposed to API keys), `GET /api/v1/storage/[...key]` (serve after
`verifyStorageSig`; **no auth — the signature IS the capability**, TTL 600s).

### Swap strategy (choose one; both preserve the API surface)
- **Strategy 1 — proxy mode (smallest diff):** keep the URL shape and the
  `/api/v1/storage/[...key]` route; replace `getObject` with an R2 `GetObject`
  (stream bytes through the route after `verifyStorageSig` — the HMAC check
  stays in the app, R2 holds bytes). `putObject` becomes R2 `PutObject` with
  the same content-addressed key. Signed URLs stay app-issued. No client
  changes; the route is the bandwidth egress point.
- **Strategy 2 — presigned mode:** `/api/v1/evidence/:id/url` returns an R2
  presigned GET URL instead of the app URL. `verifyStorageSig`/storage route
  become unused for reads. Shorter egress path through R2, but the URL shape
  changes (absolute host) and the capability semantics move to R2's signer —
  `YOU_STORAGE_SECRET` is then only the local-dev stand-in. Client impact: the
  Studio consumes `url` from the API response verbatim, so it tolerates
  absolute URLs, but any hardcoded relative-path assumptions must be checked
  (none found in the API surface at the pinned base).
- Either way, the adapter boundary is the module's exported function set —
  swap the module internals, keep the signatures (AGENTS.md: "Do not silently
  redefine … storage authority … adapter seams"; an ADR is required before the
  swap lands).

### Config
- Private bucket, no public access (SECURITY_PRIVACY control 5).
- `YOU_STORAGE_SECRET` (Strategy 1) or R2 credentials with presign permission
  (Strategy 2), plus region/endpoint env.
- Free-tier planning inputs from docs/DEPLOYMENT.md (revalidate before
  deploying): R2 10 GB-month storage, 1M Class A / 10M Class B ops, free
  egress.

### Data migration
Local objects live under `apps/web/db/you-objects/<kind>/<sha256>.<ext>` —
keys are already the R2 object keys (content-addressed, path-safe). Migration
= recursive upload preserving the key layout, then re-verify each
`EvidenceAsset.storageKey` resolves (a one-time reconciliation script
comparing `EvidenceAsset.storageKey` set vs R2 key list). Evidence bytes are
irreplaceable biometric data — migrate before decommissioning the local store,
and keep a backup copy until the hosted acceptance flow has passed.

## 4. Upstash Redis

Per docs/DEPLOYMENT.md, Upstash Redis sits in the prototype topology
(preview: isolated Redis namespaces). **What uses it TODAY at the pinned
base: nothing in `apps/web`** — there is no redis client anywhere in the app
source. The current stand-ins:
- Durable jobs: `Job` rows (single source of truth, ADR-0005) + an in-process
  fire-and-forget runner (`core/jobs.ts` `runJob`).
- Webhook fan-out: `WebhookDelivery` rows + background fetch attempts with a
  5s timeout; **no retry scheduler** (wave-1 honesty note in
  `core/events.ts`).

Gap note **G-2**: wiring Upstash (job queue triggers, webhook retries with
backoff, rate limits per SECURITY_PRIVACY "abuse policy") is a Worker A/TL
lane decision that does not exist at the pinned base. The hosted deployment
CAN go live without Redis, with these disclosed limitations:
- in-process runner means jobs execute on the serverless instance that
  received the request (cold starts re-read `Job` rows; a crashed
  mid-execution job stays `running` with its honest last state — no
  external worker resumes it);
- webhook deliveries attempt once; failures are recorded verbatim with
  `lastError`, never retried.
If/when Redis lands, envs: `UPSTASH_REDIS_REST_URL` + token, per-environment
namespace. Planning inputs (docs/DEPLOYMENT.md, revalidate): free tier 256 MB
data / 10 GB monthly bandwidth / 500K commands.

## 5. Compute broker (what must NOT change)

`src/lib/you/lab/compute.ts` (Worker C lane) implements the provider-neutral
contract mirrored from `services/compute/src/index.ts`:
`ComputeRequest { workload, minVramGb?, maxCostUsd?, privacy? }` and
`ComputeProvider { capabilities, quote, submit, status, cancel }`.

Invariants that hosted deployment must preserve (AGENTS.md non-negotiables +
F8-verified behavior):
- Provider-specific behavior never escapes the adapter; no core domain
  contract imports a vendor.
- `submit()` creates the canonical durable `Job` row first (single source of
  truth); the API returns `{jobId}` immediately (202).
- Cost labels stay honest (`modeled` vs `zero-deterministic`), latency
  estimates prefer OBSERVED history and disclose scope, failures are recorded
  verbatim — never fabricated progress (verified by battery W3C-023: a
  compile with an incomplete evidence set failed honestly with
  `validation_failed: no evidence assets found …`).
- Provider adapters (z-ai SDK, `ai/zai.ts`) are backend-only and
  fail-closed when policy/terms are unresolved (SECURITY_PRIVACY control 11).
Adding a hosted GPU provider = a new adapter behind the same interface, not a
contract change. An ADR is required for any seam change.

## 6. Cutover order + rollback

Order (each step gated; do not parallelize 2–4 on the production namespace):

1. **Neon project + branch** (preview). Record the connection string.
2. **Prisma provider switch + schema push** (TL-approved branch; fresh-start
   recommended). Verify unique constraints (§2.3).
3. **R2 bucket + adapter swap** (ADR'd; Strategy 1 recommended for the first
   cutover). Upload existing evidence objects if migrating local data.
4. **Vercel project** (preview): root `apps/web`, env matrix from §1 pointing
   at preview Neon/R2/secret. Deploy preview.
5. **F9 acceptance checklist** (§7) executed against the preview URL from a
   FRESH browser profile. Any failure → fix → redeploy → re-run the whole
   checklist.
6. **Production promotion**: repeat 1–4 on production namespaces (separate
   Neon branch, R2 bucket, secret), deploy, re-run the checklist against the
   production URL. TL sign-off (F10) only after this.

Rollback:
- Vercel: instant redeploy of the previous build (keep the last-known-good
  deployment pinned; `vercel rollback` or promote the old build).
- Neon: drop the migrated branch / restore from Neon point-in-time restore;
   because the pinned base keeps a SQLite fallback, the app can be pointed
   back at a local/standalone deployment while hosted is rolled back.
- R2: objects are immutable and content-addressed — rollback never deletes
   objects; the previous adapter deployment simply resumes serving them.
- Secrets: rotating `YOU_STORAGE_SECRET` invalidates in-flight signed URLs
  only (≤600s TTL); no data loss.
- Document every rollback performed (docs/DEPLOYMENT.md deployment gate
  requires "rollback documented").

## 7. Fresh-browser acceptance checklist (the F9 gate)

Executed from a browser profile with no prior cookies, against the deployed
URL, in order (mirrors docs/DEPLOYMENT.md "Deployment gate"):

1. Fresh-browser sign-up: load `/` (Studio SPA renders, no console errors),
   `POST /api/v1/session` flow works (demo tenant bootstrap on the hosted DB).
2. Authorized capture: create a twin → open a capture session → GRANT consent
   (capture scope) → upload a sample image → 201.
3. Consent fail-closed re-verified on hosted: attempt an upload with consent
   revoked → expect the `consent_required` envelope (re-runs battery
   W3C-006/014 semantics).
4. Actual reconstruction/render job: `POST /twins/:id/compile` (reconstruct
   grant) → 202 `jobId` → poll `GET /jobs/:id` until a terminal state; render
   `POST /renders` → artifact produced. Honest states accepted (a job may
   fail with a verbatim reason — record it; fabricated success is NOT
   accepted).
5. R2 artifact: the artifact bytes are served (signed URL from
   `GET /evidence/:id/url` or artifact URL) — verify content-type and bytes.
6. Fresh-browser review/playback: SECOND fresh profile reviews/plays back the
   artifact via the Studio.
7. Denied policy blocked: with no/revoked grant, capture and compile must
   fail-closed on hosted (this is the "denied policy blocked" gate).
8. Logs/metrics observable: Vercel runtime logs show the API requests; Neon
   console shows the rows; R2 shows the objects.
9. Rollback documented: the operator records the rollback procedure actually
   tested (e.g. redeploy previous build once in preview).

## 8. Gap notes — inconsistencies with docs/DEPLOYMENT.md (also in the audit report)

- **G-1 (info):** topology shows "Cloudflare Workers edge/API" between Vercel
  and the data layer; no Workers code exists at the pinned base —
  `services/api` is a contract mirror. The Next.js app serves `/api/v1`
  directly. Runbook assumes direct serving; introducing Workers is a TL/ADR
  decision.
- **G-2 (info/low):** Upstash Redis is in the topology but unused by the app
  source (see §4). Deployable without it, limitations disclosed.
- **G-3 (info):** `services/**` are reference/interface packages (compute
  broker mirror), not deployables.
- **G-4 (low):** `apps/web/.env.example` documents `DATABASE_URL` as relative
  `file:../db/custom.db` with a comment saying it resolves to
  `apps/web/db/custom.db` — true for a standalone clone; in nested layouts an
  outer `.env` can win silently (observed at the station, see
  tests/audit/README.md compatibility note). Hosted (Vercel) is unaffected —
  env values are absolute there.
- **G-5 (low):** the package `build` script performs standalone-copy steps
  that Vercel does not need (self-hosted path only).
- **G-6 (info):** webhook deliveries have no retry scheduler at the pinned
  base (single attempt, verbatim record) — acceptable for preview, decide
  before production SLAs.
- **G-7 (high, found live 2026-10-01):** the FS object store is
  non-viable on serverless. F9 checklist item 2 executed against the first
  production deployment failed with `500 internal_error — ENOENT: no such
  file or directory, mkdir '/var/task/db'` (the Vercel lambda bundle root
  is read-only; the local dev adapter assumed a writable cwd). Fix landed
  the same day: `YOU_STORAGE_BACKEND=db` stores content-addressed immutable
  objects as `YouObject` rows through the app database — the signed-URL
  capability model, key format, and `putObject`/`getObject` seam are
  UNCHANGED (battery W3C signed-URL semantics still hold; bytes are
  served by the same capability-checked route). This is the hosted
  dev-tier stand-in exactly as SQLite stands in for Neon locally; the
  production target remains Cloudflare R2 (Strategy 1 in §"object store")
  behind the same seam. Database sizing note: Neon free tier (0.5GB) holds
  ~50 max-size (10MB) evidence uploads — ample for preview/verification;
  R2 becomes the pressure-release valve before production scale.
