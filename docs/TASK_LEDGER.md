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
[>] A4 Consent/verification/provenance (consent server-enforced, provenance + audit events live; verification-session APIs pending)
[x] A5 event envelope/jobs/webhooks (durable jobs, events, webhook fan-out w/ delivery records)
[x] A6 Performance APIs (from-text)
[x] A7 Agent Avatar control API (bodies/souls/possession/sessions/turns)
[ ] A8 SDK JS (repo package not yet updated; in-app typed client exists)
[x] A9 usage/metering
[ ] A10 integration tests (deferred per environment constraints)

## Worker B — Studio/UX
[x] B1 Stripe survey (public-pattern translation only, no authed inspection)
[x] B2 information architecture
[x] B3 design system (zinc + emerald, dark sidebar, single-route SPA shell)
[x] B4 Twin Studio (create → capture → review → improve → compare)
[x] B5 capture quality/evidence requests
[x] B6 performance/template/render Studio (templates surface is an honest Stage-3 roadmap state)
[x] B7 Agent Avatar Studio (state-driven avatar stage, soul swap)
[x] B8 Labs/benchmarks UX (simulated-evidence labeling enforced)
[x] B9 Solution Artifact runtime (Overview|Compare|Evidence|Improve|Performance|Provenance|API)
[x] B10 API/docs playground
[x] B11 browser E2E evidence (headless browser verification, zero console errors)

## Worker C — Labs/AI
[x] C1 adapter contracts
[x] C2 Technology Registry (33 candidates, honest licenses/statuses)
[>] C3 Compute Broker (provider-neutral contract + local executor; quote/submit surface pending)
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
[>] F8 provenance/consent/security audit (enforcement + negative tests verified; formal audit pending)
[ ] F9 fresh-browser hosted deployment (Vercel/Workers/Neon topology not yet deployed; sandbox preview browser-verified)
[ ] F10 TL sign-off (wave 1 accepted as local-environment complete; final acceptance pending F1/F8/F9)

## Wave 2 — repo promotion + open gates
[x] W2.0 implementation source promoted into apps/web (TL; branch wave-2/promote-studio)
[x] W2.0b promote repair (TL, 2026-10-01): the promote commit shipped without apps/web/src/components/you/build/* (root .gitignore blanket `build/`), with an unresolvable @radix-ui/react-aspect-ratio ^1.7.1 pin, and without a lockfile — every fresh clone failed install/tsc/boot. Both W2 workers independently diagnosed and locally worked around it; repair landed 872c135 (modules committed, pin ^1.1.7, lint patterns, bun.lock).
[>] W2.A verification-session APIs (A4) + packages/sdk-js update (A8) + integration tests (A10) — Worker A lane. PARTIAL LANDED e2742ca (TL-verified from the worker's honest-partial delivery after its pod tool layer died): schema models, templates API + analyze durable job, verification-session create/read/evidence with consent fail-closed — all endpoint-verified at the station. REMAINING (continuation worker): verification-sessions/:id/evaluate route, A8 sdk-js extraction, A10 integration tests, fix-tree gate transcripts.
[>] W2.B Stage-3 templates: API routes POST /templates, GET /templates/:id, POST /templates/:id/analyze — LANDED e2742ca (persistence half, verified: idempotency replay, analyze job end-to-end). Studio templates surface (Worker B UX lane) NOT STARTED — first W2-B dispatch never obtained a pod (chat record wedged http-500, no workspace); re-dispatch pending. Frozen contract: docs/API_CONTRACTS.md "Templates and scenes".
[x] W2.C Compute Broker quote/submit/status/cancel surface (C3), agent tool execution in avatar sessions, benchmark latency honesty — Worker C lane. LANDED 0490dc0 (byte-exact reconstruction from the worker's tool-call record; station gates green; worker's in-pod runtime evidence: real-provider golden loop incl. MP4, broker transcripts, executed avatar tool_use). Worker report + extraction artifacts in the integration sandbox replay-artifacts/you-wave2/.
