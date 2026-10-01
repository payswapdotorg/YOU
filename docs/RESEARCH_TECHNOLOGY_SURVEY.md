# Technology Survey — Baseline for Lab

Checked 2026-10-01. This is a research map, not a dependency list. Candidates must be rechecked for version, weights, dataset and terms before promotion.

## Open-source/research pool
COLMAP: camera calibration/photogrammetry — https://github.com/colmap/colmap
AliceVision/Meshroom: node-based photogrammetry — https://github.com/alicevision/Meshroom
SAM 2: segmentation/video object tracking — https://github.com/facebookresearch/sam2
SMPL-X: expressive body/hand/face model — https://smpl-x.is.tue.mpg.de/
PIFu/PIFuHD: clothed-human reconstruction — https://github.com/facebookresearch/pifuhd
ICON/ECON: clothed-human reconstruction research — https://github.com/yuliangxiu/icon and https://github.com/YuliangXiu/ECON
HUGS: human Gaussian avatar reconstruction — https://github.com/apple/ml-hugs
GaussianAvatar: single-video animatable Gaussian human — https://github.com/aipixel/GaussianAvatar
GoMAvatar: Gaussians-on-Mesh human avatar — https://github.com/wenj/GoMAvatar
HAHA: highly articulated Gaussian human with textured mesh prior — https://github.com/david-svitov/HAHA
LivePortrait: portrait animation — https://github.com/KlingAIResearch/LivePortrait
Hunyuan3D-2.1: image-to-3D/PBR asset generation — https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1
HunyuanVideo-Avatar: audio-driven human animation — https://github.com/Tencent-Hunyuan/HunyuanVideo-Avatar

The GoMAvatar repo also points to newer research such as LIFe-GoM and NoPo-Avatar; these should be added by Worker C during the technology scan.

## Closed/commercial/provider pool
Google Vertex AI Virtual Try-On — https://cloud.google.com/vertex-ai/generative-ai/docs/image/generate-virtual-try-on
HeyGen Avatar IV API — https://www.heygen.com/blog/announcing-the-avatar-iv-api
Tavus — https://www.tavus.io/
D-ID — https://docs.d-id.com/
Synthesia API — https://docs.synthesia.io/
NVIDIA ACE — https://www.nvidia.com/en-us/ai-data-science/ai-agents/
MetaHuman — https://www.unrealengine.com/en-US/metahuman
Autodesk Flow Studio — https://www.autodesk.com/products/flow-studio/overview
Rokoko — https://www.rokoko.com/products/vision

## Important current observations
Gaussian human research supports the chosen hybrid mesh/neural direction. HAHA explicitly combines Gaussian splatting with a textured mesh and SMPL-X control, while GoMAvatar studies Gaussians-on-Mesh. The current Hunyuan3D repository includes production-oriented API/server material and PBR texture synthesis.

HeyGen's Avatar IV API demonstrates programmatic photo+script -> talking video with expressive facial motion and gestures. Autodesk's April 2026 Flow Studio update adds AI rigging and a neural layer, reinforcing the convergence of asset generation, rigging and neural finishing.

## Lab rule
YOU must compare capabilities rather than copy vendors. Closed systems may be benchmarked through public documentation, observable public outputs and authorized APIs. Never bypass authentication, rate limits, encryption, paywalls, licensing or technical access controls.

## License rule
Record source-code license, model-weight license, dataset license and provider terms separately. A permissive repository license does not imply commercial freedom for its weights/dependencies.