# YOU Architecture Lock

## 1. Product boundary
YOU is the infrastructure layer for authorized creation and use of digital human representations. It serves consumer apps, developers, games, e-commerce, creative tools, enterprises and AI providers.

Core loop:
`Person/Agent -> Evidence -> Twin -> Representation -> Performance -> Reality -> Output`

## 2. Canonical representation
HTIR is the semantic intermediate representation for a human. It is implementation-neutral and versioned.

HTIR domains:
- identity binding (opaque IDs, credentials, consent references)
- morphology/anthropometry
- geometry/skeleton/hands/face
- appearance/materials/hair
- articulation/blendshapes
- neural appearance
- motion/performance profile
- optional voice
- style
- confidence/provenance
- domain extensions

Explicit geometry and neural appearance are complementary. Do not force one reconstruction technique to serve all applications.

## 3. Evidence separation
Raw captures are immutable evidence. Derived representations reference evidence by content hash/version. Reconstruction may be repeated with newer engines without rewriting original evidence.

## 4. Planes
Control: tenant/user/app/keys/policies/jobs/billing/events.
Evidence: upload, scanning, capture sessions, evidence manifests.
Twin: HTIR, versions, representations and compilers.
Performance: pose, facial expression, gaze, voice, timing and interaction states.
Technology: candidate registry, adapters, benchmarks, provenance/licensing.
Lab: worlds, organizations, Body/Soul assignments, search, experiments, evaluation.
Render: offline/realtime, image/video/3D/AR.
Experience: Dashboard, Studio, Docs, Solution Artifacts.
Trust: consent, ownership, liveness, provenance, policy and audit.
Compute: provider-neutral quotes/submissions/status.

## 5. Compiler
Developer requests state an objective and constraints rather than a model:
Intent -> capability graph -> eligible technologies -> pipeline -> compute -> render -> artifact.

The selected pipeline is recorded as a reproducible PipelineCandidate.

## 6. Performance
Performance is first class and independent from identity. A performance may originate from:
- camera/video
- mocap/depth/IMU
- audio
- text/dialog
- generated animation
- game input
- live interaction state

AI-agent embodiment uses states such as listening, reading, typing, thinking, tool_use, speaking, interrupted, idle and unavailable. The LLM is not the renderer.

## 7. Styles
Style is a compiler target:
photorealistic, anime, cartoon, low-poly, game, illustration and user-defined supported styles. Identity semantics remain distinct from style.

## 8. AI-provider embodiment
An Agent Body is reusable capability/role/tool/memory/policy infrastructure. A Soul is an LLM/VLM/runtime binding. A Body may be possessed by different Souls without changing the Body contract.

System-one/system-two labels are routing profiles, not fixed model names.

## 9. Lab
Labs discover executable organizations and pipelines under explicit objectives/constraints. Simulated worlds are not production truth. Generalist and hand-designed baselines are mandatory.

## 10. Solution Artifact
Every substantial workflow may emit a portable interactive artifact containing result, evidence, controls, provenance, consent state, feedback requests and additional-evidence requests. It is a presentation/review surface over canonical backend state.

## 11. Security boundary
Raw biometrics and medical material must not be exposed to application tenants merely because they have a Twin ID. Every access is policy evaluated. Large media stays in object storage; relational storage holds metadata and hashes.

## 12. API/MCP parity
UI/HTTP/SDK/MCP all call shared application services. None may become a second source of truth.
