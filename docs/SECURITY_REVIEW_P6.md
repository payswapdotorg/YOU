# Production Security Review — Phase 6 (P6.T4)

**Reviewer:** TL (this station) · **Date:** 2026-10-02 · **Scope:** the `main`
tree through `bb339c6` — auth surface, secrets, storage capabilities, provider
adapters, input validation, logging hygiene, and the Phase-6 hardening wave
(P6.T2 freeze, P6.A1 R2 adapter, P6.A2 config hardening, P6.A3 key rotation,
P6.C1 recon provider switch).

Method: line-level audit of every security-relevant module (`core/auth.ts`,
`core/storage.ts`, `core/r2.ts`, `core/config.ts`, `core/errors.ts`,
`core/bootstrap.ts`, `core/events.ts`, `ai/openrouter.ts`,
`ai/recon-provider.ts`, the session/api-keys/storage/catches routes), plus the
contract-test evidence for each behavior claim. No pentest, no external audit —
this is a code review, honestly scoped.

## Findings

### Closed this phase

| # | Area | Finding | Disposition |
|---|---|---|---|
| C-1 | Secrets | `YOU_STORAGE_SECRET` (and all provider/backend creds) were validated only at first use — a misconfigured production deploy could boot and serve until the first upload/signature. | **CLOSED by P6.A2**: `instrumentation.ts` → `assertProductionConfig()` fails the boot with the complete violation list (presence, ≥32-char entropy, dev-default detection, selected-backend quad, provider key). Verified: 5-violation refusal, silent healthy boot, dev-default refusal. |
| C-2 | Auth | The demo bootstrap auto-provisioned `founder@you.dev` + issued sessions on every `POST /api/v1/session` — a production backdoor. | **CLOSED by P6.A2**: disabled unless dev or explicit `YOU_DEMO_BOOTSTRAP=1`; refusal is a clean `503 service_unavailable`. E2E-tested both ways. |
| C-3 | API keys | No rotation path — a leaked key forced revocation + manual redistribution. | **CLOSED by P6.A3**: `POST /api/v1/api-keys/:id/rotate` rotates in place (same row, old secret dies instantly, no overlap window); revocation stays terminal (409 on rotate). Lifecycle E2E 4/4. |
| C-4 | Key storage | Verified: sha256-only persistence, one-time secret return, prefix-only identification, list never leaks. (Pre-existing, re-verified.) | Confirmed by `api-key-lifecycle.test.mjs`. |
| C-5 | Storage capabilities | Verified: HMAC-SHA256 capability URLs with expiry, `timingSafeEqual` comparison, strict key grammar, FS traversal guard. **Preserved unchanged through the R2 backend addition** (P6.A1) — the capability layer is backend-independent by design. | Confirmed by `storage-r2`/`storage-db` suites. |
| C-6 | Provider egress | R2 + OpenRouter adapters fail closed on missing config (never guess, never fall back); provider errors surface verbatim (no fake success); no secrets in logs. | Confirmed by code review + mock-R2/mock-OpenRouter suites. |
| C-7 | Input validation | Uploads: mime allowlist (png/jpeg/webp), 10MB cap, consent-gated; storage keys path-safe; idempotency keys on mutating jobs; catch-all `/api/v1/*` returns the JSON envelope (never framework HTML). | Confirmed by existing contract suites (F-01/F-02). |
| C-8 | Webhooks | HMAC-SHA256 over `timestamp + "." + rawBody` with per-endpoint stored secrets (used only for signing, never logged). | Confirmed by hardening suite (F-04). |
| C-9 | Cookies | `HttpOnly; SameSite=Lax; Path=/` always, `Secure` appended when `x-forwarded-proto` is https. | Confirmed by hardening suite (F-03). |
| C-10 | Contract drift | Frozen v1 surface enforced by CI (`check-contracts-freeze.mjs`): manifest integrity + bidirectional route/spec match. First additive change (A3) complied in-commit. | Gate PASSED on every PR this phase. |

### Open (accepted / scheduled)

| # | Area | Finding | Risk | Remediation |
|---|---|---|---|---|
| O-1 | Rate limiting | `ERR.RATE_LIMITED` is defined but never returned — no endpoint is rate-limited. Unauthenticated `POST /api/v1/session` (dev) and capability-URL verification are the most exposed. | **Medium** (bounded: capability URLs are signed + expiring; uploads are consent-gated and size-capped) | **P6.A6** (ledger item): Upstash Redis-backed limiter once P6.T3 provisions it; interim option is a per-tenant in-memory limiter. |
| O-2 | Recon provider default | `YOU_RECON_PROVIDER` defaults to `local` (in-sandbox z-ai endpoint) even in production — biometric evidence routing must be a deliberate production choice. | **Low** (config validation passes because `local` is valid) | Deployment-runbook rule: production sets `openrouter` explicitly. Consider forcing the choice in production config for the release deploy (documented in DEPLOYMENT). |
| O-3 | Session model | Opaque 32-byte random tokens, 7-day TTL, no server-side revocation UI, single-tenant demo lineage. | **Low** for the Phase-6 scope | Real multi-user auth (passwords/OAuth) is explicitly out of Phase-6 scope (F10 sign-off records it). Sessions expire; DB rows are auditable. |
| O-4 | Secrets at rest | Provider credentials live in platform env/secret stores (per the runbook); SQLite dev db is dev-only. Production Postgres (Neon) TLS + secret manager enforcement lands with P6.T3. | **Info** | P6.T3 operator logins pending. |

## Verdict

**Production-ready for the Phase-6 scope, conditional on P6.T3 (infra) completing:**
the auth/secrets/capability surface is hardened and test-evidenced; the two
Medium findings (O-1 rate limiting, O-2 provider default) have scheduled
remediations (A6, deployment runbook) and bounded interim risk. No Critical
findings open.
