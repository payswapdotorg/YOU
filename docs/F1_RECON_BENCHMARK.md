# F1 Reconstruction Benchmark — Real vs Synthetic Evidence

Status: **DESIGN + PARTIAL VERIFICATION** (honest label — see "Current state").

This document defines the benchmark law for the F1 reconstruction path
(`f1.reconstruct`, Worker C lane P6.C4) and states, without embellishment,
what the current evidence actually proves. It operationalizes the acceptance
law of `docs/F1_OPERATOR_CAPTURE.md`:

> F1 passes only when: capture -> consent -> liveness -> quality ->
> reconstruction -> TwinVersion -> review -> deletion/export test has REAL
> evidence. Synthetic or public-dataset evidence may supplement the benchmark,
> but does not close F1.

## What is being benchmarked

The pipeline under test: `POST /api/v1/captures/:id/reconstruct` → durable
`f1.reconstruct` job → consent gate → per-asset liveness/quality checkpoints
(typed fail-closed refusals) → per-asset vision analysis through the
registry-resolved recon seam (`vlm-recon-1`) → aggregation into the
`F1ReconstructionReport` (schema `f1-reconstruction-report/v1`) → published
TwinVersion carrying F1 provenance (evidence manifest hashes, consent grant
id, model + provider used, per-region confidences) with the report attached
as a `f1-recon-report` Representation.

## The honesty split: what synthetic evidence MAY vs MAY NOT prove

| Property | Synthetic/mock evidence can prove it? | Why |
| --- | --- | --- |
| Pipeline determinism (fixed bytes + fixed mock analyses → byte-identical report aggregates) | **YES** | The aggregation, checkpoints, coverage math, and disclosure generation are pure functions; unit-verified. |
| Contract shape (report schema, refusal taxonomy, provenance block, TwinVersion linkage fields) | **YES** | Structural properties are checkable against mocks. |
| Fail-closed behavior (consent gate, all refusal codes, zero-evidence refusal) | **YES** | Refusal paths are triggered deliberately with malformed/malicious fixtures. |
| Checkpoint sniffing correctness (PNG/JPEG/GIF dims, magic tables, aspect bounds) | **YES** | Header-level decoding is deterministic; verified against hand-crafted headers. |
| Registry resolution precedence + fail-closed model selection | **YES** | The registry is a frozen declarative table; precedence is unit-verified with env overrides. |
| **Reconstruction QUALITY** (does the descriptor set honestly describe the captured person?) | **NO — real evidence only** | Descriptor fidelity, per-region confidence calibration, and quality findings are claims about a REAL subject; a mock that returns canned descriptors can only verify plumbing, never fidelity. |
| **VLM observation quality on real photos** (lighting/blur/framing verdicts vs reality) | **NO — real evidence only** | Same epistemic boundary. |
| **Protocol coverage realism** (does a real 8-step session actually produce covered steps?) | **NO — real evidence only** | Coverage depends on what real capture assets actually show. |
| End-to-end F1 acceptance chain (capture → … → deletion/export with real evidence) | **NO — real evidence only** | The law is explicit. |

**No synthetic-claim laundering** is a hard rule of the pipeline itself: an
asset that fails analysis is recorded as failed with the verbatim error;
per-region confidence is `null` when nothing machine-observed the region;
DECLARED coverage (upload-time region claims) is reported as a strictly weaker
evidence tier than OBSERVED (VLM-verified) and never counts toward
confidence. The benchmark inherits the same rule: a mock pass is labeled a
mock pass, never "reconstruction works".

## Determinism vs non-determinism (what "deterministic" honestly means here)

- Deterministic given fixed inputs: checkpoints, refusal classification,
  protocol coverage math, per-region aggregation, weighted means, disclosure
  generation, provenance block construction (rounding is fixed to 3 decimals).
- NOT deterministic: the vision model's outputs (provider-side temperature),
  per-call latency (real, measured, reported in `usage`), and thus the exact
  descriptor text and confidence numbers on any real run. The report does not
  pretend otherwise — `usage.latencyMs` is measured, and confidence values are
  labeled as weighted model self-confidence, not ground truth.

## Benchmark design (for when real evidence exists)

The full benchmark requires a consenting internal tester per
`docs/F1_OPERATOR_CAPTURE.md` (the product owner does NOT need to be the
captured person), a persisted consent grant with the `reconstruct` scope, and
a capture session covering the 8-step protocol. Runs:

1. **R1 — happy path**: complete 8-step session → reconstruct → assert the
   TwinVersion carries F1 provenance (manifest hashes match the session's
   content-addressed assets; consent grant id matches; provider/model match
   the resolved seam; per-region confidences present for observed regions).
2. **R2 — degradation honesty**: deliberately incomplete session (e.g. skip
   turn-around/walking) → assert missing/partial steps are disclosed in
   `protocolCoverage` + `overall.disclosure`, and unobserved regions have
   `null` confidence.
3. **R3 — checkpoint refusals on real bytes**: corrupt/truncated/empty
   uploads → typed refusals recorded in `failures`, never analyzed.
4. **R4 — review gate**: human review of the reconstruction report against
   the actual person (descriptor accuracy verdicts) — the only quality
   measurement that closes F1's reconstruction stage.
5. **R5 — deletion/export**: subject deletion/export request → evidence bytes
   and derivatives handled per the persisted deletion policy.

Scoring: R1–R3 are automatable assertions; R4 is human-verdict based
(correct/incorrect/uncertain per descriptor family, mirroring the feedback
verdicts already defined for twin-review); R5 asserts the deletion/export
chain. F1 closes only when all five run on REAL evidence.

## Current state (labeled honestly, 2026-10-04)

- **Pipeline code + contract tests: DONE and green.** The pure half
  (`lab/f1-recon.ts`) is unit-verified in `tests/contract/f1-recon.test.mjs`
  with mock deps: consent-gated entry (typed refusal, no byte loads),
  liveness/quality refusal taxonomy, declared-vs-observed aggregation,
  TwinVersion provenance linkage, failure disclosure, determinism.
- **Hosted vision path: contract-mock-proven only.** The recon seam
  (openrouter `vlm-recon-or-1`) was verified end-to-end against a local
  OpenRouter mock in P6.C1 (`recon-openrouter.test.mjs`); this sandbox has no
  provider egress/keys, so no live-hosted reconstruction has ever run here.
  The local z-ai path is the sandbox default.
- **NO real capture evidence exists in this environment yet.** The F1
  operator capture flow (Worker A/B3, Studio side) is in flight in another
  session. Therefore R1–R5 have **not run**: F1 is NOT closed, and this
  document does not claim otherwise.
- **Video/audio evidence**: byte-level checkpoints run, but no vision adapter
  is wired for non-image evidence in wave-1 — declared-only coverage,
  disclosed by design. Steps 7 (walking) and 8 (speech) can therefore never
  show as machine-observed in wave-1; this is a pipeline limitation, disclosed
  in every report that hits it, not a benchmark gap to paper over.
