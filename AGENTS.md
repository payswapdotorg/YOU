# YOU Agent Operating Contract

Status: FROZEN FOR IMPLEMENTATION

## Authority hierarchy
1. AGENTS.md
2. docs/ARCHITECTURE.md
3. docs/API_CONTRACTS.md
4. docs/DATA_MODEL.md
5. docs/SECURITY_PRIVACY.md
6. docs/LAB_DESIGN.md
7. docs/PROVIDER_ADAPTERS.md
8. docs/DEPLOYMENT.md
9. docs/UX_STRIPE_SURVEY.md
10. docs/IMPLEMENTATION_PLAN.md
11. docs/TASK_LEDGER.md
12. docs/PHASE_6_HANDOFF.md
13. docs/PRODUCTION_CHECKLIST.md
14. docs/F1_OPERATOR_CAPTURE.md
15. docs/INFRA_PROVISIONING.md
16. docs/adr/*
17. tests/code/evidence

Chat history is not an implementation dependency.

## Mission
Build YOU as technology-neutral Human Reality Infrastructure: persistent human twins, performance/control streams, reality compilation, agent embodiment, autonomous R&D labs, and portable interactive Solution Artifacts.

## Canonical thesis
The canonical object is HTIR (Human Twin Intermediate Representation). Implementations are replaceable adapters. Production flows are:
capture -> evidence -> reconstruction -> HTIR -> representation compiler -> performance -> reality/render -> provenance -> artifact.

## Non-negotiables
- No core domain contract imports a model/provider/GPU vendor/game engine.
- Every replaceable technology has a versioned adapter, capability profile, provenance and license record.
- Consent is explicit, scoped, revocable and server-enforced.
- Identity/liveness evidence is distinct from visual similarity.
- Historical TwinVersions are immutable.
- Lab worlds are simulated/research truth, never production human truth.
- Agent Body and Agent Soul are separate; Souls are swappable.
- HTTP, SDK, MCP and UI use the same application-service authority.
- Long-running jobs have one durable source of truth.
- No fake progress, fake quality or implied medical validity.
- Production promotion requires reproducibility, benchmark, rights/privacy/security and cost/latency evidence.
- Provider free tiers are optional accelerators, never hard dependencies.
- Do not train on user biometric data unless an explicit, separate consent/policy permits it.
- No proprietary competitor source/assets/branding are copied.

## Three-worker ownership
Worker A — Core/API: contracts, persistence, auth, consent, provenance, events, SDKs.
Worker B — Studio/UX: dashboard, docs, Solution Artifacts, capture/review UX, Stripe survey.
Worker C — Labs/AI: reconstruction adapters, technology registry, compute broker, agent body/soul runtime, lab worlds, organization compiler, benchmarks.

TL owns contracts, integration, security, promotion, releases and architecture changes.

Workers must not edit another lane's owned implementation. Cross-lane contract changes go through TL and docs first.

## Completion evidence
Every task reports: work item IDs, files changed, tests, real evidence, fixture evidence, contract changes, license/provenance, latency/cost, security, risks, blockers, deviations.

## Architecture changes
Create an ADR before changing a frozen boundary. Do not silently redefine HTIR, job states, consent, provenance, agent body/soul, promotion, storage authority or adapter seams.
