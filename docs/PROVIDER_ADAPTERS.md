# Technology and Provider Adapter Registry

Every candidate has:
technologyId/version
adapterVersion
task/capabilities
input/output contracts
resource requirements
latency/cost observations
provenance
license/terms
benchmark profile
failure classes
status

## Technology families
Capture, calibration, segmentation, pose, body reconstruction, face/hand reconstruction, clothed-human reconstruction, Gaussian/neural appearance, motion capture, facial animation, lip sync, image/video generation, virtual try-on, 3D asset generation, rendering, simulation, LLM/VLM, embeddings, safety/moderation and provenance.

## Open ecosystem
Initial research pool:
COLMAP, AliceVision/Meshroom, SAM 2, MMPose, MediaPipe, SMPL-X, PIFu/PIFuHD, ICON, ECON, HUGS, GaussianAvatar, GoMAvatar, HAHA, DreamWaltz-G, Hunyuan3D, HunyuanVideo/Avatar, LivePortrait and related projects.

## Closed/provider pool
Investigate via authorized/public interfaces:
Google Vertex AI Virtual Try-On, OpenAI, Anthropic, xAI/Grok, HeyGen, Tavus, D-ID, Synthesia, NVIDIA ACE, MetaHuman, Autodesk Flow Studio, Rokoko and relevant regional providers.

## Licensing rule
Code license, model-weight license, dataset license and provider terms are separate records. A permissive code license does not automatically permit commercial model-weight usage. Research-only candidates remain in Lab but cannot pass production gates.

## Selection
Runtime selects by capability + policy + objective + evidence + cost/latency + availability. There is no universal best provider.
