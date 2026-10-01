# YOU Deployment Architecture

## Prototype topology

Browser/PWA
  -> Vercel-hosted Next.js dashboard/docs/studio
  -> Cloudflare Worker edge/API adapter
  -> Neon PostgreSQL control plane
  -> Upstash Redis for cache/rate/job coordination
  -> Cloudflare R2 private media/artifact storage
  -> Compute Broker
      -> local/customer GPU
      -> managed GPU provider
      -> external model API

## Environment
local -> deterministic fixtures
preview -> isolated database/bucket/redis namespace
beta -> production-like controls and quotas
production -> commercially permitted hosting plans and metered compute

Vercel Hobby is for personal/non-commercial development only under current Vercel terms. Do not use it as a commercial production dependency.

## Free-tier posture
Use free tiers to bootstrap the control plane, not to promise unlimited compute.
R2 currently lists 10 GB-month Standard storage, 1M Class A, 10M Class B and free egress.
Upstash Redis Free currently lists 256 MB, 10 GB bandwidth and 500K monthly commands.
Neon Free remains suitable for low-volume prototypes.
These limits are checked-date planning inputs and must be revalidated before deployment.

## Compute Broker
ComputeRequest -> eligible providers -> quote -> submit -> status -> collect.
Provider-specific statuses never escape the adapter.

## Cost safety
Hard upload/render limits, job quotas, per-tenant budgets, provider budget guards, concurrency limits and visible degraded states are mandatory.

## Deployment gates
Fresh browser can sign up -> create Twin -> upload authorized capture -> job executes -> artifact lands in R2 -> artifact is reviewable -> denied policy is blocked -> logs/events are observable -> rollback documented.
