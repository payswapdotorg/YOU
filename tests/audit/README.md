# tests/audit — W3.C F8 audit battery (read-only on application source)

Worker YOU-W3-C lane. These scripts drive the app at the pinned base
(`74fbe0bbc7f43437f7e603324cde04780d959b68`) through its public HTTP API and
record verbatim transcripts. They never modify `apps/web/src/**`, `packages/**`,
`docs/**`, `contracts/**` or prisma schema.

## Files
- `boot-and-run.sh <1|2> [fresh]` — boots apps/web on :3230 (explicit
  `DATABASE_URL` → `apps/web/db/custom.db`, fixed `YOU_STORAGE_SECRET`) and runs
  one battery part. `fresh` recreates the SQLite db + object store for a
  deterministic run. Run each part in a single shell session.
- `battery.sh <1|2>` — the check battery (curl) writing
  `transcript-part{1,2}.txt` (verbatim commands/status/bodies/verdicts).
- `db-probe.mjs` — Prisma fixtures the API cannot create itself: tenant B
  (isolation), grant TTL expiry/restore, published TwinVersion fixture, session
  expiry, idempotency row counts, webhook delivery records.
- `listener.mjs` — request-bin HTTP listener (:3231) capturing webhook
  deliveries verbatim to JSONL.
- `sign-url.mjs` — battery-side replica of `core/storage.ts` signing (same
  HMAC/encoding) to construct correctly-signed but EXPIRED or UNSAFE-key
  capabilities — both must be rejected by the storage route.
- `transcript-part1.txt`, `transcript-part2.txt` — verbatim battery evidence
  (generated; committed as the audit record).

## Why DB fixtures are legitimate scaffolding
Consent TTLs are integer HOURS (min 1) and sessions live 7 days — a live
battery cannot wait them out. The probe expires/restores rows directly to
exercise the fail-closed re-arm paths; the enforcement logic under test is
entirely the app's (the probe only mutates data, never code).

## Compatibility note (environment, not an app defect)
`apps/web/.env.example` uses relative `DATABASE_URL="file:../db/custom.db"`.
In a standalone clone this resolves (schema-relative) to
`apps/web/db/custom.db` as documented. When the repo is cloned INSIDE another
Next.js project whose own `.env` sets `DATABASE_URL` (this station's layout),
bun/prisma env resolution lets the outer absolute value win and `bun run
db:push` silently targets the outer project's db file. The battery therefore
always sets `DATABASE_URL` explicitly.
