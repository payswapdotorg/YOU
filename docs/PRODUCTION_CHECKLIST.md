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
[x] subject isolation  <!-- subject-export suite: per-subject bundles never cross; capability URLs are per-object -->
[x] upload validation  <!-- mime allowlist + 10MB cap + consent gate + path-safe keys; contract suites -->
[ ] malware/quarantine path
[ ] SSRF controls
[ ] security headers/CSP/CORS
[x] webhook replay/signature protection  <!-- F-04: HMAC over timestamp+rawBody; hardening suite -->
[x] audit logs  <!-- audit() on every mutating route incl. key.rotated; verified across suites -->
[x] retention/deletion enforcement  <!-- P6.A4 (e6718e6/a1a73a4): reference-driven GC job + subject export; policy cadence documented -->
[x] abuse controls  <!-- P6.A6-interim (f65dad4): rate limits on session/uploads/key-mutations; full Upstash item pending T3 -->

## Reliability
[x] durable jobs  <!-- Job rows + fire-and-forget runner; steps/output honest; contract suites poll to terminal states -->
[x] idempotency  <!-- F-01 suite: same key+body → same result; 409 on divergent replay -->
[ ] bounded retries
[ ] dead-letter strategy
[ ] provider circuit breaker
[ ] graceful degraded states
[x] tracing  <!-- P6.A7 (a98e102): x-request-id correlation on all /api/v1 (inbound echo, smuggling guard) + audit events -->
[ ] metrics
[ ] error tracking
[x] uptime checks  <!-- P6.A7: unauthenticated /api/v1/health (db probe, honest 503, no-store) -->

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
