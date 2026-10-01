# YOU Task Ledger

Legend: [ ] pending [>] active/partial [x] verified (in the local dev environment unless noted)

Wave 1 was implemented in the integration sandbox (Next.js 16 + Prisma/SQLite local stand-ins per docs/DEPLOYMENT.md "local: deterministic fixtures" — R2→local content-addressed object store with signed URLs, Neon→SQLite, provider compute→z-ai SDK adapters). Nothing here claims production deployment.

Wave 2 note (2026-10-01): the wave-1 implementation source was promoted into this repository at `apps/web` (TL wave-2 decision, branch `wave-2/promote-studio`). Subsequent lanes implement against the repo; the integration sandbox remains the live verification station.

## G0 — Tech Lead
[x] G0.1 architecture/contracts audit
[x] G0.2 freeze shared schemas (in-app contracts lib mirroring contracts/{htir,events,lab}/v1)
[x] G0.3 establish branch/PR conventions
[x] G0.4 dependency graph and integration gates

## Worker A — Core/API
[x] A1 tenant/user/application/auth (session cookie + scoped API keys)
[x] A2 Evidence/Capture schema + R2 upload flow (local object-store adapter, signed URLs)
[x] A3 HTIR/Twin persistence (immutable published TwinVersions)
[x] A4 Consent/verification/provenance (consent server-enforced, provenance + audit events live; verification-session APIs landed e2742ca; evaluate route landed ad29189 — deterministic 409/200 state machine, immutable result, honesty invariants; station-verified 6/6 incl. re-evaluate 409 + durable event)
[x] A5 event envelope/jobs/webhooks (durable jobs, events, webhook fan-out w/ delivery records)
[x] A6 Performance APIs (from-text)
[x] A7 Agent Avatar control API (bodies/souls/possession/sessions/turns)
[x] A8 SDK JS (packages/sdk-js @you/sdk-js 0.1.0 landed ad29189 — standalone workspace package, zero runtime deps, YouClient with templates + verificationSessions surfaces, SDK smoke end-to-end; tsc 0)
[x] A9 usage/metering
[x] A10 integration tests (tests/contract/verification-flow.test.mjs + aggregator landed ad29189 — 6/6 green at the station incl. real provider compute flow, consent fail-closed negatives, idempotency replays, evaluate immutability)

## Worker B — Studio/UX
[x] B1 Stripe survey (public-pattern translation only, no authed inspection)
[x] B2 information architecture
[x] B3 design system (zinc + emerald, dark sidebar, single-route SPA shell)
[x] B4 Twin Studio (create → capture → review → improve → compare)
[x] B5 capture quality/evidence requests
[x] B6 performance/template/render Studio (templates surface = working Stage-3 surface over the real API since W3.B c582c42)
[x] B7 Agent Avatar Studio (state-driven avatar stage, soul swap)
[x] B8 Labs/benchmarks UX (simulated-evidence labeling enforced)
[x] B9 Solution Artifact runtime (Overview|Compare|Evidence|Improve|Performance|Provenance|API)
[x] B10 API/docs playground
[x] B11 browser E2E evidence (headless browser verification, zero console errors)

## Worker C — Labs/AI
[x] C1 adapter contracts
[x] C2 Technology Registry (33 candidates, honest licenses/statuses)
[x] C3 Compute Broker (provider-neutral contract + local executor; quote/submit/status/cancel landed 0490dc0 with honest labels + refusals, avatar tool execution, benchmark latency honesty)
[x] C4 reconstruction pipeline (vlm-recon-1, real VLM compute)
[x] C5 performance/retargeting (from-text tracks; retargeting not applicable wave 1)
[x] C6 render adapters (svg-portrait-1 deterministic, ai-image-1, ai-video-1)
[x] C7 Agent Body/Soul runtime (soul swap under same body, embodied state events)
[x] C8 Organization Compiler
[x] C9 Lab World (seeded, deterministic)
[x] C10 benchmark/evaluator (generalist/hand-designed/searched, determinism verified)
[x] C11 Failure Atlas/Pipeline Genome
[x] C12 provider adapters (zai suite w/ real latencies, 429 backoff)

## Final gates
[>] F1 real authorized capture (full consent-gated upload flow verified with synthetic authorized samples; a real person's capture pending)
[x] F2 real Twin reconstruction (actual VLM analysis → persisted HTIR/TwinVersion; confidence honestly low on partial evidence)
[x] F3 real performance (deterministic track builder)
[x] F4 real image/video artifact (provider MP4 5.3MB + deterministic SVG + provider image)
[x] F5 AI-provider avatar flow (live LLM embodiment w/ state events)
[x] F6 feedback → targeted evidence request → TwinVersion update (v1→v2, confidence 0.32→0.416)
[x] F7 Lab reproduction (seed 42, determinism 1.0, reproducible reports)
[x] F8 provenance/consent/security audit (formal battery landed 76a48b5: 104 checks — consent fail-closed across 5 surfaces, scope enforcement, raw-evidence restriction, signed-URL capability + tamper/expiry, path traversal, tenant + subject isolation, idempotency, webhook end-to-end, error envelopes — 104 PASS / 0 FAIL / 1 INFO, STATION-REGENERATED transcripts matching the worker's numbers exactly)
[>] F9 fresh-browser hosted deployment (LIVE: https://you-platform.vercel.app — Vercel production + Neon PostgreSQL wandering-night-61504191, schema pushed, demo tenant + lab seed bootstrapped; runbook landed 76a48b5; checklist items 1/3/7/8 PASSED live — SPA render, session bootstrap, consent fail-closed envelopes, Neon observability; items 2/4/5/6 (provider compute + artifact playback on hosted) PENDING hosted z-ai provider credentials — honest state, no fabricated success)
[ ] F10 TL sign-off (wave 1 accepted as local-environment complete; final acceptance pending F1/F8/F9)

## Wave 2 — repo promotion + open gates
[x] W2.0 implementation source promoted into apps/web (TL; branch wave-2/promote-studio)
[x] W2.0b promote repair (TL, 2026-10-01): the promote commit shipped without apps/web/src/components/you/build/* (root .gitignore blanket `build/`), with an unresolvable @radix-ui/react-aspect-ratio ^1.7.1 pin, and without a lockfile — every fresh clone failed install/tsc/boot. Both W2 workers independently diagnosed and locally worked around it; repair landed 872c135 (modules committed, pin ^1.1.7, lint patterns, bun.lock).
[x] W2.A verification-session APIs (A4) + packages/sdk-js update (A8) + integration tests (A10) — Worker A lane. LANDED COMPLETE via the W3.A continuation (ad29189, TL-verified: replay-integrity exact, lint/tsc 0, tests 6/6). PARTIAL LANDED e2742ca (TL-verified from the worker's honest-partial delivery after its pod tool layer died): schema models, templates API + analyze durable job, verification-session create/read/evidence with consent fail-closed — all endpoint-verified at the station. REMAINING (continuation worker): verification-sessions/:id/evaluate route, A8 sdk-js extraction, A10 integration tests, fix-tree gate transcripts.
[x] W2.B Stage-3 templates: API routes POST /templates, GET /templates/:id, POST /templates/:id/analyze — LANDED e2742ca (persistence half, verified: idempotency replay, analyze job end-to-end). Studio templates surface (Worker B UX lane) LANDED c582c42 via the W3.B continuation (TL-verified: replay integrity exact, lint/tsc/boot green, API end-to-end incl. idempotency replay and analyze-job persisted coverage, secret sweep clean; worker browser-verified all fixture states with zero console errors). Frozen contract: docs/API_CONTRACTS.md "Templates and scenes".
[x] W2.C Compute Broker quote/submit/status/cancel surface (C3), agent tool execution in avatar sessions, benchmark latency honesty — Worker C lane. LANDED 0490dc0 (byte-exact reconstruction from the worker's tool-call record; station gates green; worker's in-pod runtime evidence: real-provider golden loop incl. MP4, broker transcripts, executed avatar tool_use). Worker report + extraction artifacts in the integration sandbox replay-artifacts/you-wave2/.

## Wave 3 — lane completions + final gates (2026-10-01 evening)
[x] W3.A Worker A lane completion (evaluate route + sdk-js + integration tests) — LANDED ad29189 (TL-verified from the batch-store harvest after the platform's turn-spawn window killed the composer path; the raw-completions kick doctrine, AGENT_BOOT_PROMPT §12). Replay-integrity exact (11 files, +1852/−12 matching the worker's report byte-for-byte); station gates: lint 0, tsc 0, node --test 6/6 (incl. real provider compute: capture.quality + twin.compile with published TwinVersion, templates idempotency, verification evaluate + 409 immutability); secret sweep clean. Worker report: replay-artifacts/you-wave3/ (station re-extraction).
[x] W3.C F8 audit battery (read-only) + F9 hosted-deployment runbook — LANDED 76a48b5. Station RE-RAN the battery itself: part 1 = 48 PASS / 0 FAIL, part 2 = 56 PASS / 0 FAIL / 1 INFO — exactly the worker's numbers; transcripts station-regenerated (the worker's pod-generated transcripts were bash outputs, not Write-tool calls — regenerated as stronger evidence). Read-only lane verified (0 app-source modifications). Findings F-01/F-02 (LOW) + 6 gap notes routed to the runbook.
[>] F9 hosted deployment (station-executed per the runbook, ahead of the wave-3 landing): Vercel project you-platform + Neon wandering-night-61504191 (org key) + prisma provider switch on station/f9-deploy + schema push + production deploy — https://you-platform.vercel.app LIVE with demo tenant + HUMAN-RECON-001 seed on hosted Postgres. Checklist 1/3/7/8 passed live; 2/4/5/6 pending hosted provider credentials (operator decision). Hobby-tier licensing caveat documented in the runbook §1.

## Wave 4 — audit-findings hardening (2026-10-01 night)
[x] W4.A F-01..F-04, F-06, F-07 hardening — LANDED (cherry-pick of the worker's 658d9c1). TL contract decisions executed: idempotency body-fingerprint binding (409 idempotency_conflict on same-key/different-body across templates create/analyze + compile), API-surface catch-all envelope, cookie Secure behind https, webhook HMAC signatures (X-You-Timestamp + X-You-Signature), .env.example nested-layout warning, query logging gated to non-production. F-05 (Redis/Workers topology) deferred by TL — operator-level. Station-verified: lint 0, tsc 0, tests 12/12 (clean env — the station's ambient DATABASE_URL interference demonstrated finding F-06/G-4 live). Findings F-01..F-04, F-06, F-07 CLOSED; battery W3C-143 upgraded from INFO to asserted envelope check.
