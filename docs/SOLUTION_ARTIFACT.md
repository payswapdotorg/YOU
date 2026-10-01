# Solution Artifact Specification

A Solution Artifact is an interactive, versioned review surface over canonical YOU data. It may be a generated static web application or a hosted route, but it never becomes the source of truth.

## Manifest
solution_id
version
type
inputs
twin_version
performance
pipeline
organization
artifacts
evidence
consent
provenance
feedback_schema
evidence_request_schema
export_targets

## UX
Overview | Compare | Evidence | Improve | Performance | Provenance | API

## Feedback
Users may mark regions/frames/states as:
correct
incorrect
uncertain
missing-detail
wrong-motion
wrong-identity
wrong-style

Feedback must reference an artifact/TwinVersion and create a new FeedbackRequest. It must not mutate immutable evidence.

## Targeted evidence
The system can request:
- additional face angle
- side/back capture
- hands
- hair
- teeth
- walking
- speech
- custom performance

A request contains reason, affected capability, capture instructions, expected signal and privacy/consent scope.

## Portability
The artifact manifest should allow a self-contained web bundle with a JSON manifest and asset references. Interactive 3D may use Three.js, WebGPU/WebGL or another adapter.
