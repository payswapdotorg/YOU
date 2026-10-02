# Backup & Restore — Phase 6 (P6.A5)

**Status:** procedures + a restore drill that has actually been executed.
A backup that has never been restored is a hope, not a backup — the drill
below is the proof, and it is re-runnable (`bun scripts/backup-db.sh` then
the drill steps).

## What needs protecting

| Plane | Local/dev | Hosted target | Mechanism |
|---|---|---|---|
| Relational (tenants, twins, consents, sessions, jobs, keys…) | SQLite `apps/web/db/custom.db` | Neon PostgreSQL | Neon branch history + PITR (provider-side); local: `scripts/backup-db.sh` (consistent `sqlite3 .backup` snapshot + checksum + row-count evidence) |
| Object bytes (evidence media, content-addressed) | `apps/web/db/you-objects/` | Cloudflare R2 private bucket | R2 durability (provider-side, 11 9's) + the content-addressing law: keys are `kind/sha256.ext`, so the DB rows + original bytes can always re-derive the key; GC (P6.A4) is the retention control, not a backup substitute |
| Secrets | env/secret store | platform secret manager | never in the repo (audited); re-provisionable per `docs/INFRA_PROVISIONING.md` |
| Contracts/code | git | GitHub | provider-side + the frozen manifest (`contracts/SHA256SUMS.v1`) verifies integrity on every CI run |

## Local backup procedure

```
cd <repo>
bun scripts/backup-db.sh
# → backups/<timestamp>/custom.db (+ .sha256, integrity.txt, rowcounts.txt)
```

The snapshot is taken with `sqlite3 .backup` (consistent against a live
writer; `cp` fallback with the caveat disclosed) and verified with
`PRAGMA integrity_check`.

## Restore procedure (and the drill)

1. Stop the app (a restore over a live writer corrupts).
2. `bun scripts/backup-db.sh --restore backups/<timestamp>`
   — refuses to restore on checksum mismatch.
3. Boot the app and verify: row counts match `rowcounts.txt`, the storage
   route still serves capability URLs (the HMAC secret is env-side, NOT in
   the db — restored data + same secret = same capabilities), and one known
   record round-trips.

**Drill evidence (executed 2026-10-02, this station):** live db backed up
while the dev server was running (consistent snapshot), a twin row was
deleted, the backup restored, the twin returned; capability URLs issued
before the backup still verified after restore (secret continuity).
Recorded in the P6.A5 PR; the drill is re-runnable via the procedure above.

## Hosted (production) procedure — after P6.T3

- **Neon:** scheduled branch backups + PITR window per plan; restore =
  branch action; verify with the same row-count + capability round-trip
  checks (the drill generalizes — only the restore verb changes).
- **R2:** object durability is provider-side; the DB backup + original
  bytes are the recovery path for logical deletion mistakes (content
  addressing makes re-upload idempotent).
- **Drill cadence:** restore drill on preview after every schema migration
  and at least monthly in production (owner: TL).

## Retention (ties to P6.A4)

Deletion is lazy and reference-driven: twin deletes cascade rows, the
`maintenance.gc-storage` job sweeps unreferenced object bytes. Retention
policy decisions (how long evidence outlives its subject rows) are
operator policy, executed by the GC job cadence — the platform provides
the mechanism, not the policy.
