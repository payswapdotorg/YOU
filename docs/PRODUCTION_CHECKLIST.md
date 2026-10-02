# YOU Production Checklist

## Blocking
[x] CI green on clean clone  <!-- PR-1 closed: 7 consecutive green PRs through 25e8686 -->
[ ] R2 production object storage
[ ] hosted provider/GPU credentials
[ ] F1 real authorized QA capture
[ ] F9 full hosted artifact
[ ] backup/restore test
[ ] deletion/export test
[ ] incident/rollback test

## Security
[x] API keys hashed/rotatable  <!-- P6.A3 bb339c6: sha256-only, in-place rotation, terminal revocation; api-key-lifecycle 4/4 -->
[x] signed URL TTLs  <!-- 600s default, expiring HMAC capabilities, timing-safe compare; storage suites -->
[ ] tenant isolation
[ ] subject isolation
[x] upload validation  <!-- mime allowlist + 10MB cap + consent gate + path-safe keys; contract suites -->
[ ] malware/quarantine path
[ ] SSRF controls
[ ] security headers/CSP/CORS
[x] webhook replay/signature protection  <!-- F-04: HMAC over timestamp+rawBody; hardening suite -->
[x] audit logs  <!-- audit() on every mutating route incl. key.rotated; verified across suites -->
[ ] retention/deletion enforcement
[ ] abuse controls

## Reliability
[ ] durable jobs
[ ] idempotency
[ ] bounded retries
[ ] dead-letter strategy
[ ] provider circuit breaker
[ ] graceful degraded states
[ ] tracing
[ ] metrics
[ ] error tracking
[ ] uptime checks

## Product
[ ] Twin
[ ] capture
[ ] targeted evidence
[ ] quality review
[ ] performance
[ ] image render
[ ] video render
[ ] style compiler
[ ] Agent Avatar
[ ] Soul swap
[ ] realtime
[ ] Solution Artifact
[ ] feedback
[ ] developer API
[ ] SDK
[ ] webhooks
[ ] usage/billing
[ ] e-commerce try-on
[ ] game export

## Labs
[ ] Technology Registry
[ ] licenses/weights/data/provider terms
[ ] Lab World
[ ] Organization Compiler
[ ] Body/Soul evaluation
[ ] benchmark
[ ] Failure Atlas
[ ] Pipeline Genome
[ ] promotion/rollback

## Release
[ ] no critical/high findings
[ ] production secrets verified
[ ] quotas/budgets verified
[ ] fresh-browser smoke
[ ] rollback verified
[ ] TL sign-off
