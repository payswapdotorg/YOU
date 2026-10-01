# YOU Deployment Architecture

Checked 2026-10-01.

## Prototype topology
Browser/PWA -> Vercel Next.js -> Cloudflare Workers edge/API -> Neon PostgreSQL + Upstash Redis + Cloudflare R2 -> Compute Broker -> local/customer GPU, managed GPU, or external model API.

## Environment
local: deterministic fixtures.
preview: isolated preview DB/R2/Redis namespaces.
beta: production-like quotas and policy.
production: commercially permitted hosting + metered compute.

Vercel Hobby is personal/non-commercial under current Vercel Terms. Do not use it as a commercial production dependency: https://vercel.com/legal/terms

## Current free-tier planning references
Cloudflare R2: 10 GB-month Standard storage, 1M Class A, 10M Class B, free Internet egress: https://developers.cloudflare.com/r2/pricing/
Upstash Redis Free: 256 MB data, 10 GB monthly bandwidth, 500K commands: https://upstash.com/pricing/redis
Neon Free: https://neon.com/pricing
These figures are planning inputs and must be revalidated before deployment.

## Compute
ComputeRequest -> eligible provider adapters -> quote -> submit -> status -> collect.
Provider-specific behavior never escapes the adapter.

## Security/cost
Private buckets, short-lived signed access, upload duration/size limits, job budgets, concurrency controls, rate limits, audit events, provider budget guards and explicit degraded states.

## Deployment gate
Fresh browser sign-up -> authorized capture -> actual reconstruction/render job -> R2 artifact -> fresh-browser review/playback -> denied policy blocked -> logs/metrics observable -> rollback documented.