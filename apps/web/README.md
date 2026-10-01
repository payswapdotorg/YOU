# YOU Studio (apps/web) — local development environment

Single Next.js 16 application implementing the YOU local-dev environment per
`docs/DEPLOYMENT.md`: Studio SPA at `/`, `/api/v1` route set, Prisma/SQLite
persistence, local content-addressed object store with HMAC-signed URLs, and
z-ai SDK provider adapters (real provider compute when credentials are present;
deterministic adapters otherwise).

## Run

```bash
cd apps/web
bun install                # or: pnpm install
cp .env.example .env       # then edit secrets for anything beyond local dev
bun run db:push            # create the SQLite schema
bun run dev                # http://localhost:3000
```

## Spec authority

`AGENTS.md` and `docs/*` in the repository root. This app is the wave-1
implementation promoted from the integration sandbox (see
`docs/TASK_LEDGER.md` wave-2 note and `docs/REPOSITORY_STATUS.md`). Honest
capability state is tracked in the ledger — no surface here claims production
deployment.
