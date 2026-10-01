# YOU Data Model

Core tables/entities:

Tenant
User
Application
ApiKey
VerificationSession
ConsentGrant
AuditEvent

CaptureSession
EvidenceAsset
EvidenceManifest
EvidenceQuality
Twin
TwinVersion
Representation
RepresentationComponent
Anthropometry
AppearanceProfile
Performance
PerformanceTrack
Template
SceneRecipe
RenderJob
LiveSession
OutputArtifact
SolutionArtifact
FeedbackRequest
EvidenceRequest

TechnologyCandidate
TechnologyVersion
TechnologyAdapter
Benchmark
BenchmarkRun
EvaluationReport
PipelineCandidate
PipelineComponent
FailureCase
PromotionRecord

AgentBody
AgentSoul
AgentInstance
AgentOrganization
OrganizationNode
OrganizationEdge
AgentMemory
Skill
SkillVersion
LabObjective
LabWorld
WorldSeed
Experiment
ExperimentRun
ComputeRequest
ComputeQuote
ComputeProvider
ComputeJob
ModelBinding

## Invariants
- IDs are opaque.
- immutable evidence and published TwinVersions are content-addressed.
- all derived artifacts reference input versions.
- tenant/application authorization is enforced server-side.
- consent scopes identity, purpose, actor, operations, outputs and expiry.
- clinical extensions are separate capability domains with stricter policy gates.
- historical provenance is never deleted merely because a representation is superseded.
