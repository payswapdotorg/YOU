# Repository Status — 2026-10-01 (wave 1 close)

Repository: payswapdotorg/YOU
Default branch: main

## Wave 1 implementation (local dev environment)
The canonical loop runs end-to-end in the integration sandbox (Next.js 16 single-route Studio + /api/v1 route set + Prisma/SQLite + local content-addressed object store with HMAC-signed URLs + z-ai SDK provider adapters):

- Evidence → REAL VLM analysis → HTIR v1 persisted → immutable TwinVersion → twin-review Solution Artifact.
- Renders: deterministic SVG adapter, provider image (75s real), provider video MP4 (5.3MB, 252s, cost labeled modeled).
- Agent embodiment: LLM-driven turns with thinking/tool_use/speaking state events; Soul swap under an unchanged Body.
- Lab: HUMAN-RECON-001 benchmark on seeded world 42 — generalist vs hand-designed vs searched, determinism 1.0, failure atlas, promotion drafted (never production).
- Trust: scoped/revocable consent server-enforced on capture/reconstruct/render/embodiment (fail-closed negative tests pass); provenance chains content-hashed; audit events recorded.

## Honest limitations
- Dev stand-ins per DEPLOYMENT.md local environment (SQLite for Neon, local store for R2, in-process runner for Workers/queues). Free tiers remain accelerators, not dependencies.
- F1/F8/F9 final gates open: no real-person capture yet, no formal security audit, no hosted deployment.
- Templates/Live surfaces are roadmap states; benchmark LLM-latency components are modeled and labeled; avatar tools are declared but not executed (states only).
- No test files in the sandbox app (environment constraint); verification is browser-driven evidence.

## CI
GitHub Actions runs docs/contracts checks for this repo. The implemented app lives in the integration sandbox, not in this repository yet; promotion of the implementation source into this repo is a wave-2 decision for the TL.
