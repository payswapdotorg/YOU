# Technology Survey — Baseline for Lab

Checked 2026-10-01. This is a research map, not a dependency list.

## Open source / research
COLMAP and AliceVision/Meshroom cover camera calibration and photogrammetry. SAM 2, MMPose and related libraries address segmentation/pose. SMPL-X provides a unified expressive body/hand/face parameterization. PIFu/PIFuHD, ICON and ECON demonstrate clothed-human reconstruction. HUGS, GaussianAvatar, GoMAvatar and HAHA explore animatable Gaussian/mesh human avatars. LivePortrait addresses portrait animation. Tencent Hunyuan repositories cover 3D generation and audio-driven human animation/video. Open ecosystems on Hugging Face and GitHub should feed the Technology Registry.

Commercial/model-provider examples
Google Virtual Try-On / Vertex AI, HeyGen Avatar IV, Tavus, D-ID, Synthesia, NVIDIA ACE, MetaHuman and Autodesk Flow Studio demonstrate portions of the commercial digital-human stack.

Relevant cases
- Google's VTO validates API-level personalized commerce.
- HeyGen demonstrates programmatic image+script -> talking avatar video.
- NVIDIA ACE decomposes digital humans into voice, animation and intelligence modules.
- Autodesk Flow Studio shows convergence of generation, rigging and neural finishing.
- Sporta demonstrates a technology-neutral adapter/benchmark/compute/Lab architecture and a strict three-worker ownership/integration pattern.

## Research rule
The Lab may characterize any publicly documented or authorized system, but must not circumvent authentication, rate limits, encryption, paywalls, or access controls. For competitors, reproduce observable behavior and published claims rather than protected internals.
