# YOU Full Implementation Plan

## Stage 0 — Contract freeze
TL verifies all canonical documents, generates no code assumptions from chat, and creates the first integration branch. Freeze HTIR, jobs, event envelope, consent, artifact, adapter and compute contracts.

## Stage 1 — Core platform
A: Postgres schema, auth, tenants/apps, captures, Twins, versions, consent, provenance, events, signed R2 URLs.
B: dashboard shell, navigation, object list/detail primitives, docs shell, Solution Artifact viewer.
C: adapter interfaces, Technology Registry, Compute Broker interfaces, Lab domain interfaces, Agent Body/Soul interfaces.

Exit: all services compile against shared contracts.

## Stage 2 — Real Twin loop
A: capture/session APIs and persistence.
B: guided capture/review UI with quality states and evidence-request flow.
C: reconstruction adapter runner and one openly licensed pipeline candidate plus a mock/fixture adapter.

Exit: authorized sample -> actual reconstruction adapter -> persisted HTIR/representation -> reviewable Twin.

## Stage 3 — Performance and rendering
A: Performance/event contracts and API.
B: template ingestion, Studio, render job UX.
C: performance extraction, retargeting, image render and video render adapters.

Exit: Twin + Performance + Template -> playable artifact.

## Stage 4 — AI provider embodiment
A: Agent Avatar APIs, tenant policy, event schema.
B: Agent Avatar Studio/session UX and review.
C: Body/Soul runtime, Soul Router, provider adapters and embodied state machine.

Exit: external LLM can drive a YOU avatar without becoming canonical state.

## Stage 5 — Labs
A: persistent Lab job/run evidence.
B: Lab UI and interactive experiment/benchmark Solution Artifacts.
C: synthetic worlds, organization compiler, search, failure atlas, pipeline genome.

Exit: HUMAN-RECON-001 benchmark can execute and produce reproducible evidence.

## Stage 6 — ecosystem
Add try-on, game exports, realtime WebRTC, AR, more reconstruction engines, closed provider characterization and customer-owned compute.

## Stage 7 — production hardening
Security review, threat modeling, load tests, cost guards, provenance, deletion/export workflows, audit, canary promotion, disaster recovery and fresh-browser acceptance.

## No-drift integration rule
Workers commit only within their lanes. Shared contract change requires TL approval. Each wave starts only after its dependency gate. Fix-only mode begins at final acceptance; no feature expansion after that point.
