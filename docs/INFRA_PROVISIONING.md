# YOU Free-Tier / Credit Provisioning Runbook

The TL should provision infrastructure through official web consoles/APIs where possible. Ask the product owner to log in only when provider authentication, billing verification, GitHub OAuth or terms acceptance cannot be completed programmatically.

## Required
1. Cloudflare account with R2 enabled.
2. Vercel project connected to GitHub.
3. Neon Postgres project.
4. Upstash Redis database.
5. GPU provider account with free credits where available.
6. Error/observability provider with free tier if needed.
7. Domain/DNS only after platform smoke is green.

## Provider roles
Cloudflare R2: production media/object storage.
Cloudflare Workers: edge/webhook/lightweight control plane.
Neon: relational control plane.
Upstash: cache/rate/ephemeral coordination.
Vercel: web dashboard/docs where commercial plan terms permit.
Modal or equivalent: GPU experiments/benchmarks.
Render/Railway: fallback service hosting for workloads unsuitable for serverless.

## Rules
- record provider, project ID, region, plan, quota and date checked;
- keep credentials in platform secret stores;
- never commit secrets;
- never rely on a single free-tier provider;
- set explicit resource limits;
- test provider failure;
- keep adapter interfaces stable.

## Human login protocol
When a login is required:
1. TL prepares the exact provider/account step;
2. product owner authenticates directly;
3. no password, secret or recovery code is written into the repository;
4. TL verifies the resulting project/API credential scope;
5. credential is stored only in the deployment platform's secret manager.

## Current candidate compute
Modal currently advertises $0/month Starter with $30/month compute credits, 3 seats, 10 GPU concurrency and 1 TiB/month network egress. Confirm current terms before use.

## Current storage/cache references
Cloudflare R2 currently lists 10 GB-month Standard, 1M Class A, 10M Class B and no Internet egress charge.
Upstash Redis Free currently lists 256 MB, 10 GB monthly bandwidth and 500K commands.
These are planning values, not production guarantees.