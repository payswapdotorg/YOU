# YOU — Final Tech Lead Handoff

Read this file after AGENTS.md. The repository is the sole source of truth.

Mission: build a Stripe-like Human Reality Infrastructure platform:
Person/Agent -> Evidence -> Twin -> Representation -> Performance -> Reality -> Output.

Architecture: HTIR is canonical; models, reconstruction engines, renderers, LLMs, game engines and GPU/cloud providers are replaceable adapters.

Team:
Worker A Core/API; Worker B Studio/UX; Worker C Labs/AI; TL contracts/integration/security/promotion/release.

First waves:
A: auth, tenants/apps, evidence/capture, R2 signing, Twin/version, consent, provenance, jobs/events/webhooks.
B: Stripe survey, dashboard IA, Twin Studio, capture/review, Solution Artifact viewer, docs/playground.
C: adapter registry, Compute Broker, reconstruction runner, Performance, Agent Body/Soul, Lab World, Organization Compiler, benchmarks.

Acceptance:
real authorized capture -> actual reconstruction -> persisted HTIR -> Performance -> image/video render -> AI-provider avatar -> feedback/evidence request -> new TwinVersion -> reproducible Lab -> security/provenance -> fresh-browser hosted proof.

Rules:
no model/provider in core contracts; no implicit consent; no raw biometric exposure by default; no fake progress; no Lab simulation as production truth; no promotion without reproducibility/benchmark/rights/privacy/security/cost/latency evidence; no competitor code/assets copying.