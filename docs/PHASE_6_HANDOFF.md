# YOU Phase 6 — Production Readiness & Product Completion Handoff

Date: 2026-10-02
Owner: TL
Status: FINAL NEXT-PHASE DIRECTIVE

## Objective

Move YOU from a feature-complete local/hosted beta implementation into a production-hardened platform with reproducible real-human capture, real hosted reconstruction/rendering, complete provider-neutral infrastructure, operational safeguards, and release evidence.

The product owner does NOT need to be the real-human capture subject.

## F1 real-human capture protocol

Run F1 with a separately authorized QA subject:
- an employee/team member;
- a contracted tester;
- a consenting advisor/volunteer;
- or another explicitly authorized participant.

The subject should be able to complete the entire guided capture protocol in a clean browser/device. No product-owner biometric media is required.

If no appropriate person is available, create a documented Operator Capture Session workflow and leave F1 open rather than pretending synthetic data is equivalent.

Minimum F1 data:
- one guided phone-video capture;
- explicit capture/usage consent;
- active/liveness challenge;
- quality evaluation;
- reconstruction;
- persisted TwinVersion;
- deletion/export test;
- provenance record.

Use the minimum retention period. Do not use the capture for model training unless there is a separate explicit training consent.

## Product completion tracks

### P0 — fix CI before expanding
- determine why pnpm/action-setup fails in GitHub Actions;
- pin supported Node/pnpm versions;
- avoid network-dependent floating package versions;
- make clean-clone CI deterministic;
- require build + typecheck + lint + contract + security tests.

### P1 — hosted storage and compute
- provision Cloudflare R2 and switch production object storage to R2 behind the existing object-store seam;
- keep database-backed storage only as dev/beta fallback;
- provision at least one free/credit-backed GPU provider behind Compute Broker;
- provision provider credentials only through secret managers;
- add provider budget/concurrency/circuit-breaker controls;
- implement actual hosted reconstruction and rendering;
- remove any false 'production' capability labels.

### P2 — real capture / reconstruction
- execute F1 with an authorized QA subject;
- prove liveness/verification;
- reconstruct with a production-eligible adapter;
- persist immutable TwinVersion;
- expose confidence and deficiencies honestly;
- verify targeted additional evidence flow.

### P3 — complete rendering
- real image rendering;
- real video rendering;
- Template -> SceneRecipe -> Twin -> Performance -> Render;
- verify temporal consistency and identity preservation;
- add output expiration and download/export policy.

### P4 — AI-provider embodiment
Support:
- OpenAI
- Anthropic
- xAI/Grok
- other compatible LLM/VLM providers
- customer-owned models

Keep Soul provider-neutral.
Support states: listening, reading, typing, thinking, tool_use, speaking, interrupted, idle, unavailable.
Expose low-latency realtime transport separately from offline rendering.
Use WebRTC for live media where appropriate.

### P5 — Solution Artifact completion
Every major workflow can produce:
- result
- compare
- evidence
- improve
- performance
- provenance
- consent
- API/code
- feedback
- targeted evidence requests

Feedback creates canonical FeedbackRequest objects and never mutates immutable evidence.

### P6 — production trust
Add:
- API key rotation/revocation;
- hashed API keys;
- secure sessions;
- CSRF strategy;
- CORS allowlists;
- CSP and security headers;
- SSRF protections;
- upload MIME/codec/size/duration validation;
- malware scanning/quarantine;
- decompression-bomb protection;
- EXIF/privacy stripping where policy allows;
- rate limits;
- tenant/application isolation tests;
- audit export;
- deletion workflows;
- data retention policies;
- signed URL TTLs;
- replay protection;
- webhook timestamp/signature verification and idempotent delivery;
- abuse detection for impersonation/deepfake/bulk generation;
- kill switches for sensitive capabilities.

### P7 — reliability
Implement:
- durable job state;
- retry with bounded exponential backoff;
- dead-letter handling;
- idempotency on all mutation endpoints;
- provider health/circuit breakers;
- graceful degradation;
- cancellation;
- request tracing;
- structured logs;
- metrics;
- error tracking;
- uptime/health checks;
- dependency health dashboard.

### P8 — disaster recovery
Document and test:
- Neon backup/restore;
- R2 object recovery/versioning strategy;
- secret rotation;
- database migration rollback;
- restore of a complete TwinVersion lineage;
- recovery from provider outage;
- recovery from corrupted output;
- incident response.

### P9 — developer platform
Complete:
- OpenAPI generated from canonical route contracts;
- JS/TS SDK;
- webhook SDK helpers;
- official examples;
- API playground;
- request IDs;
- event IDs;
- usage API;
- sandbox/test mode;
- deterministic fixtures;
- pagination;
- filtering/sorting;
- typed errors;
- idempotency docs.

### P10 — Labs productionization
Keep Labs isolated from production truth but make them operational:
- immutable Lab run manifests;
- deterministic seeds;
- reproducible environments;
- cost budgets;
- model/license provenance;
- benchmark artifacts;
- promotion manifests;
- canary promotion;
- rollback;
- Failure Atlas;
- Pipeline Genome;
- Organization Compiler;
- Soul swap benchmark;
- capture-protocol optimization.

### P11 — technology ecosystem
Expand the registry through:
- GitHub
- Hugging Face
- arXiv/public papers
- authorized APIs/SDKs
- published benchmark datasets
- regional ecosystems

Maintain separate records for code, weights, data, dependencies, provider terms and commercial eligibility.

Never copy protected internals. Closed systems are characterized through published documentation, authorized APIs and observable outputs.

### P12 — style/output compilers
Support:
- photorealistic;
- anime;
- stylized/cartoon;
- low-poly/game;
- illustration;
- application-defined style profiles.

Identity semantics remain separate from style.

### P13 — e-commerce
Implement real:
- virtual try-on adapter contract;
- garment/product assets;
- body-aware rendering;
- product identity preservation;
- output comparison;
- merchant integration surface;
- explicit distinction between visual try-on and physical-fit claims.

### P14 — gaming/AR
Implement:
- GLB/glTF export;
- VRM where appropriate;
- LODs;
- facial controls;
- humanoid retargeting;
- Unity/Unreal integration packages;
- realtime avatar streaming;
- AR-friendly representation.

### P15 — clinical extension boundary
Do not market consumer visual Twins as medical digital twins.
Keep clinical/anatomical models behind separate capabilities, validation, provenance and policy gates.

## Free/credit-backed infrastructure candidates

Preferred control plane:
- Vercel/Next.js for dashboard/docs where plan terms permit;
- Cloudflare Workers for edge/control-plane workloads;
- Neon Postgres;
- Upstash Redis;
- Cloudflare R2;
- Modal for GPU experiments/free credits;
- Render/Railway as alternative low-cost service hosting if required.

The TL must verify terms at provisioning time. Free plans can expire/change and may be unsuitable for commercial production. Production architecture must preserve adapter portability.

For GPU workloads, prefer free/credit-backed starter capacity rather than trying to run large reconstruction models on edge/serverless functions.

## Observability baseline

Record:
request_id
tenant_id
application_id
job_id
twin_id
twin_version
pipeline_id
technology_versions
provider
model
compute provider
latency
cost estimate
failure code
policy decision

Never log raw biometric media, secrets or full authorization headers.

## Production readiness gates

PR-1 CI green on clean clone.
PR-2 production R2 live.
PR-3 hosted GPU/provider path live.
PR-4 F1 real authorized QA subject.
PR-5 F9 hosted end-to-end artifact.
PR-6 security battery green.
PR-7 deletion/export verified.
PR-8 backup/restore verified.
PR-9 provider outage/fallback verified.
PR-10 realtime agent avatar verified.
PR-11 SDK/docs playground verified.
PR-12 production deployment + rollback verified.
PR-13 cost limits enforced.
PR-14 no known critical/high unresolved finding.
PR-15 TL sign-off.

## No-drift execution

Work in numbered waves. The TL freezes contracts before each wave.

Workers remain:
A Core/API
B Studio/UX
C Labs/AI

Each PR must declare:
work items
contract impact
test evidence
browser evidence where relevant
rights/licensing
security
observability
cost/latency
rollback
known gaps

No feature expansion is allowed while a blocking production gate is red.

## Definition of Done

YOU is production-ready only when a fresh developer can:
1. create an account/application;
2. obtain an API key;
3. obtain authorized capture consent;
4. capture a real person;
5. create a Twin;
6. inspect Twin quality;
7. supply additional targeted evidence;
8. produce realistic/anime/stylized representations;
9. create and apply a Performance;
10. render image/video;
11. create an AI-provider agent avatar;
12. swap the Soul;
13. review a Solution Artifact;
14. submit feedback;
15. receive a targeted evidence request;
16. inspect provenance/consent;
17. use SDK/webhooks/events;
18. observe usage/cost;
19. revoke/delete access;
20. recover the system after an injected failure.

All twenty paths must have recorded evidence before F10.