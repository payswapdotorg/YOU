// ═══════════════════════════════════════════════════════════════════════════
// Technology Registry seed catalog (Worker C lane, task 2-c).
//
// Honesty rules baked into this data (docs/PROVIDER_ADAPTERS.md):
// - code license, model-weight license, dataset license and provider terms are
//   SEPARATE records; a permissive repo license never implies weight freedom;
// - uncertain licensing is marked with an explicit "verify" note — never
//   invented;
// - open research pool entries stay status 'research' (registry
//   characterization only — no adapters wired in wave-1);
// - closed pool entries are 'closed-characterized' via public docs only;
// - YOU fixture adapters are honestly 'candidate': they work in this sandbox
//   but are not validated/canaried/production.
// Survey base: docs/RESEARCH_TECHNOLOGY_SURVEY.md (checked 2026-10-01).
// ═══════════════════════════════════════════════════════════════════════════
import type { TechnologyStatus } from '../contracts';

export interface CatalogVersionEntry {
  version: string;
  adapterVersion: string;
  capabilities: string[];
  resources: Record<string, unknown>;
  latencyP50Ms?: number;
  costUsdPerUnit?: number;
  failureClasses: string[];
  provenance: Record<string, unknown>;
}

export interface CatalogEntry {
  techId: string;
  name: string;
  family: string;
  vendor: string | null;
  source: 'open' | 'closed' | 'fixture';
  license: { code: string; weights: string; data: string; providerTerms: string };
  runtime: string;
  patentNotes: string;
  status: TechnologyStatus;
  meta: Record<string, unknown>;
  versions: CatalogVersionEntry[];
}

const OPEN_RUNTIME_GPU = 'Linux, CUDA GPU (8–24 GB VRAM typical; varies by model)';
const CLOSED_TERMS =
  'commercial provider terms — verify current ToS, pricing tiers, data-retention and training clauses before any integration';

function openEntry(e: Omit<CatalogEntry, 'source' | 'status'>): CatalogEntry {
  return { ...e, source: 'open', status: 'research' };
}

function closedEntry(e: Omit<CatalogEntry, 'source' | 'status' | 'license'>): CatalogEntry {
  return {
    ...e,
    source: 'closed',
    status: 'closed-characterized',
    license: {
      code: 'proprietary — closed provider, no source access',
      weights: 'proprietary — closed provider',
      data: 'proprietary — closed provider',
      providerTerms: CLOSED_TERMS,
    },
  };
}

// ─── Open ecosystem research pool (status: research) ─────────────────────────
export const TECHNOLOGY_CATALOG: CatalogEntry[] = [
  openEntry({
    techId: 'colmap',
    name: 'COLMAP',
    family: 'calibration',
    vendor: null,
    license: {
      code: 'BSD-3-Clause',
      weights: 'n/a — classical SfM/MVS algorithms, no learned weights in core',
      data: 'n/a — operates on user-supplied captures',
      providerTerms: 'n/a — self-hosted open-source software',
    },
    runtime: 'C++/CUDA, GPU optional (dense MVS benefits from GPU)',
    patentNotes:
      'SfM/MVS foundations are long-published academic work; the project asserts no known blocking patents — verify independently before commercial reliance',
    meta: { role: 'multi-view camera calibration and dense geometry baseline for the Lab' },
    versions: [
      {
        version: '3.10',
        adapterVersion: '0 (registry characterization only — no adapter wired in wave-1)',
        capabilities: ['camera-calibration', 'sparse-reconstruction', 'dense-reconstruction'],
        resources: { cpu: 'multi-core', gpu: 'optional', ram: '>= 16 GB' },
        failureClasses: ['textureless-regions', 'motion-blur', 'rolling-shutter-drift'],
        provenance: { repoUrl: 'https://github.com/colmap/colmap' },
      },
    ],
  }),
  openEntry({
    techId: 'meshroom',
    name: 'AliceVision / Meshroom',
    family: 'calibration',
    vendor: 'AliceVision Association',
    license: {
      code: 'MPL-2.0 (AliceVision engine); Meshroom pipeline/UI license: verify — historically shipped proprietary free-to-use terms',
      weights: 'n/a — classical photogrammetry (some optional learned filters vary)',
      data: 'n/a — operates on user-supplied captures',
      providerTerms: 'n/a — self-hosted; verify Meshroom commercial-use terms',
    },
    runtime: OPEN_RUNTIME_GPU,
    patentNotes: 'photogrammetry fundamentals as COLMAP; no known assertions by the project',
    meta: { role: 'node-based photogrammetry alternative for capture research' },
    versions: [
      {
        version: '2023.2 (AliceVision)',
        adapterVersion: '0 (registry characterization only)',
        capabilities: ['camera-calibration', 'dense-reconstruction', 'meshing', 'texturing'],
        resources: { gpu: 'required for dense stages', ram: '>= 16 GB' },
        failureClasses: ['node-pipeline-fragility', 'textureless-regions'],
        provenance: { repoUrl: 'https://github.com/alicevision/Meshroom' },
      },
    ],
  }),
  openEntry({
    techId: 'sam2',
    name: 'SAM 2',
    family: 'segmentation',
    vendor: 'Meta AI Research',
    license: {
      code: 'Apache-2.0',
      weights: 'verify — SAM 2 checkpoints were released under permissive terms; re-check exact checkpoint license before commercial use',
      data: 'SA-V dataset license is a separate record — verify',
      providerTerms: 'n/a — self-hosted weights',
    },
    runtime: 'Python, CUDA GPU (~8 GB VRAM)',
    patentNotes: 'none asserted by the project at survey time — verify',
    meta: { role: 'segmentation / video object tracking stage for person and garment masks' },
    versions: [
      {
        version: '2.1',
        adapterVersion: '0 (registry characterization only)',
        capabilities: ['segmentation', 'video-object-tracking', 'promptable-masks'],
        resources: { gpu: 'required', vramGb: 8 },
        failureClasses: ['occlusion-id-switching', 'fine-structure-boundaries'],
        provenance: { repoUrl: 'https://github.com/facebookresearch/sam2' },
      },
    ],
  }),
  openEntry({
    techId: 'mediapipe',
    name: 'MediaPipe',
    family: 'pose',
    vendor: 'Google',
    license: {
      code: 'Apache-2.0',
      weights: 'Apache-2.0 model cards for first-party solutions; third-party re-exported checkpoints vary — verify per model',
      data: 'training datasets not distributed — verify per model card',
      providerTerms: 'n/a — self-hosted / on-device',
    },
    runtime: 'C++/Python/WASM, CPU real-time',
    patentNotes: 'none asserted at survey time — verify',
    meta: { role: 'lightweight real-time landmarks (pose/face/hands) for capture coaching' },
    versions: [
      {
        version: '0.10',
        adapterVersion: '0 (registry characterization only)',
        capabilities: ['pose-estimation', 'face-landmarks', 'hand-landmarks', 'realtime'],
        resources: { cpu: 'sufficient', gpu: 'optional' },
        failureClasses: ['fast-motion-drift', 'profile-view-degradation'],
        provenance: { repoUrl: 'https://github.com/google-ai-edge/mediapipe' },
      },
    ],
  }),
  openEntry({
    techId: 'mmpose',
    name: 'MMPose',
    family: 'pose',
    vendor: 'OpenMMLab',
    license: {
      code: 'Apache-2.0',
      weights: 'varies per model-zoo checkpoint — many are Apache-2.0, some inherit third-party restrictions; verify per checkpoint',
      data: 'training datasets (COCO et al.) have their own licenses — verify',
      providerTerms: 'n/a — self-hosted',
    },
    runtime: OPEN_RUNTIME_GPU,
    patentNotes: 'none asserted at survey time — verify',
    meta: { role: 'state-of-the-art pose estimation model zoo for benchmark comparisons' },
    versions: [
      {
        version: '1.3',
        adapterVersion: '0 (registry characterization only)',
        capabilities: ['pose-estimation', 'whole-body-keypoints', 'model-zoo'],
        resources: { gpu: 'required for training-grade models', vramGb: 8 },
        failureClasses: ['checkpoint-license-mismatch', 'occlusion-missing-joints'],
        provenance: { repoUrl: 'https://github.com/open-mmlab/mmpose' },
      },
    ],
  }),
  openEntry({
    techId: 'smpl-x',
    name: 'SMPL-X',
    family: 'body-reconstruction',
    vendor: 'Max Planck Institute for Intelligent Systems',
    license: {
      code: 'research-only — registration and license acceptance required (verify current terms)',
      weights: 'RESEARCH-ONLY, non-commercial — model files distributed under MPI research license',
      data: 'research-only',
      providerTerms: 'n/a — weights behind registration; commercial licensing historically via Body Labs/Unity lineage — verify',
    },
    runtime: 'Python, CPU for fitting; GPU recommended',
    patentNotes:
      'the SMPL family is patent-encumbered (MPI / Body Labs lineage) — a commercial license path must be verified before any production use; research-only in the Lab',
    meta: { role: 'expressive body+hands+face parametric model referenced by most clothed-human recon research' },
    versions: [
      {
        version: '1.0',
        adapterVersion: '0 (registry characterization only)',
        capabilities: ['parametric-body-model', 'body-hands-face-embedding', 'fitting'],
        resources: { cpu: 'sufficient for inference' },
        failureClasses: ['license-blocks-production', 'loose-garment-underfitting'],
        provenance: { docsUrl: 'https://smpl-x.is.tue.mpg.de/' },
      },
    ],
  }),
  openEntry({
    techId: 'pifuhd',
    name: 'PIFu / PIFuHD',
    family: 'clothed-human-reconstruction',
    vendor: 'Meta AI Research (Facebook Research)',
    license: {
      code: 'MIT',
      weights: 'verify — pretrained models released for non-commercial research per README',
      data: 'training data not distributed; derived benchmarks have own terms',
      providerTerms: 'n/a — self-hosted',
    },
    runtime: OPEN_RUNTIME_GPU,
    patentNotes: 'none asserted by the project at survey time — verify',
    meta: { role: 'single-image clothed-human reconstruction baseline' },
    versions: [
      {
        version: 'PIFuHD (2020)',
        adapterVersion: '0 (registry characterization only)',
        capabilities: ['single-image-clothed-recon', 'high-resolution-normals'],
        resources: { gpu: 'required', vramGb: 12 },
        failureClasses: ['hands-merge-into-torso', 'back-side-hallucination', 'loose-clothing-geometry'],
        provenance: { repoUrl: 'https://github.com/facebookresearch/pifuhd' },
      },
    ],
  }),
  openEntry({
    techId: 'icon',
    name: 'ICON',
    family: 'clothed-human-reconstruction',
    vendor: null,
    license: {
      code: 'verify — repository carries its own license; historically non-commercial research',
      weights: 'research checkpoints — verify before any use beyond Lab research',
      data: 'verify — dependent datasets have separate terms',
      providerTerms: 'n/a — self-hosted',
    },
    runtime: OPEN_RUNTIME_GPU,
    patentNotes: 'builds on SMPL family — same SMPL patent/license considerations apply',
    meta: { role: 'implicit CANonical correspondence clothed recon' },
    versions: [
      {
        version: '1.0',
        adapterVersion: '0 (registry characterization only)',
        capabilities: ['clothed-human-recon', 'normal-integration', 'smpl-guided'],
        resources: { gpu: 'required', vramGb: 12 },
        failureClasses: ['smpl-dependency-license', 'fine-garment-detail-loss'],
        provenance: { repoUrl: 'https://github.com/yuliangxiu/icon' },
      },
    ],
  }),
  openEntry({
    techId: 'econ',
    name: 'ECON',
    family: 'clothed-human-reconstruction',
    vendor: null,
    license: {
      code: 'verify — repository license must be rechecked; research release',
      weights: 'research checkpoints — verify',
      data: 'verify — dependent datasets have separate terms',
      providerTerms: 'n/a — self-hosted',
    },
    runtime: OPEN_RUNTIME_GPU,
    patentNotes: 'SMPL-family dependency — same considerations as smpl-x',
    meta: { role: 'drape-any-garment (explicit clothed surface) recon research' },
    versions: [
      {
        version: '1.0',
        adapterVersion: '0 (registry characterization only)',
        capabilities: ['clothed-human-recon', 'garment-surface', 'smpl-guided'],
        resources: { gpu: 'required', vramGb: 16 },
        failureClasses: ['smpl-dependency-license', 'hands-detail-loss'],
        provenance: { repoUrl: 'https://github.com/YuliangXiu/ECON' },
      },
    ],
  }),
  openEntry({
    techId: 'hugs',
    name: 'HUGS',
    family: 'gaussian-neural-appearance',
    vendor: 'Apple',
    license: {
      code: 'verify — Apple ml-* sample-code style licenses can carry usage restrictions; recheck before use',
      weights: 'research-only',
      data: 'verify',
      providerTerms: 'n/a — self-hosted',
    },
    runtime: OPEN_RUNTIME_GPU,
    patentNotes: 'verify — Gaussian-splatting core (Kerbl et al.) has a patented commercial path via INRIA/TRENCH — affects splatting-based pipelines',
    meta: { role: 'human+scene Gaussian reconstruction from monocular video' },
    versions: [
      {
        version: '1.0',
        adapterVersion: '0 (registry characterization only)',
        capabilities: ['gaussian-human-recon', 'monocular-video', 'novel-view-synthesis'],
        resources: { gpu: 'required', vramGb: 16 },
        failureClasses: ['gaussian-splatting-patent-risk', 'fast-motion-artifacts'],
        provenance: { repoUrl: 'https://github.com/apple/ml-hugs' },
      },
    ],
  }),
  openEntry({
    techId: 'gaussianavatar',
    name: 'GaussianAvatar',
    family: 'gaussian-neural-appearance',
    vendor: null,
    license: {
      code: 'verify — repository license must be rechecked',
      weights: 'research-only',
      data: 'verify',
      providerTerms: 'n/a — self-hosted',
    },
    runtime: OPEN_RUNTIME_GPU,
    patentNotes: 'Gaussian-splatting patent considerations as hugs',
    meta: { role: 'animatable Gaussian human from single video' },
    versions: [
      {
        version: '1.0',
        adapterVersion: '0 (registry characterization only)',
        capabilities: ['gaussian-avatar', 'single-video-recon', 'animation'],
        resources: { gpu: 'required', vramGb: 16 },
        failureClasses: ['gaussian-splatting-patent-risk', 'identity-drift-on-pose-change'],
        provenance: { repoUrl: 'https://github.com/aipixel/GaussianAvatar' },
      },
    ],
  }),
  openEntry({
    techId: 'gomavatar',
    name: 'GoMAvatar',
    family: 'gaussian-neural-appearance',
    vendor: null,
    license: {
      code: 'verify — repository license must be rechecked',
      weights: 'research-only',
      data: 'verify',
      providerTerms: 'n/a — self-hosted',
    },
    runtime: OPEN_RUNTIME_GPU,
    patentNotes: 'Gaussian-splatting patent considerations as hugs',
    meta: {
      role: 'Gaussians-on-Mesh avatar — efficient render, relevant to the hybrid mesh/neural direction',
      followUp: 'repo points to newer research (LIFe-GoM, NoPo-Avatar) to add in the next technology scan',
    },
    versions: [
      {
        version: '1.0',
        adapterVersion: '0 (registry characterization only)',
        capabilities: ['gaussians-on-mesh', 'avatar-recon', 'efficient-rendering'],
        resources: { gpu: 'required', vramGb: 12 },
        failureClasses: ['gaussian-splatting-patent-risk', 'garment-boundary-artifacts'],
        provenance: { repoUrl: 'https://github.com/wenj/GoMAvatar' },
      },
    ],
  }),
  openEntry({
    techId: 'haha',
    name: 'HAHA',
    family: 'gaussian-neural-appearance',
    vendor: null,
    license: {
      code: 'verify — repository license must be rechecked',
      weights: 'research-only',
      data: 'verify',
      providerTerms: 'n/a — self-hosted',
    },
    runtime: OPEN_RUNTIME_GPU,
    patentNotes: 'Gaussian-splatting patent considerations as hugs; SMPL-X dependency — its research-only weights license applies',
    meta: { role: 'highly articulated Gaussian human with textured mesh prior — directly supports hybrid mesh/neural direction' },
    versions: [
      {
        version: '1.0',
        adapterVersion: '0 (registry characterization only)',
        capabilities: ['articulated-gaussian-human', 'textured-mesh-prior', 'smplx-control'],
        resources: { gpu: 'required', vramGb: 16 },
        failureClasses: ['smpl-dependency-license', 'extreme-pose-failure'],
        provenance: { repoUrl: 'https://github.com/david-svitov/HAHA' },
      },
    ],
  }),
  openEntry({
    techId: 'dreamwaltz-g',
    name: 'DreamWaltz-G',
    family: 'generative-avatar',
    vendor: null,
    license: {
      code: 'verify — research release; license must be rechecked',
      weights: 'research-only (diffusion-prior based)',
      data: 'verify',
      providerTerms: 'n/a — self-hosted',
    },
    runtime: OPEN_RUNTIME_GPU,
    patentNotes: 'verify — generative avatar methods increasingly patent-dense',
    meta: { role: 'expressive Gaussian avatar generation from text/sparse input' },
    versions: [
      {
        version: '1.0',
        adapterVersion: '0 (registry characterization only)',
        capabilities: ['avatar-generation', 'gaussian-appearance', 'expression-control'],
        resources: { gpu: 'required', vramGb: 24 },
        failureClasses: ['slow-optimization', 'identity-inconsistency-across-poses'],
        provenance: { repoUrl: 'https://github.com/IDEA-Research/DreamWaltz-G' },
      },
    ],
  }),
  openEntry({
    techId: 'hunyuan3d',
    name: 'Hunyuan3D 2.1',
    family: '3d-asset-generation',
    vendor: 'Tencent',
    license: {
      code: 'Tencent Hunyuan Community License — verify: includes usage restrictions (entity scale thresholds, regional restrictions historically incl. EU/UK/Spain)',
      weights: 'same community license — verify',
      data: 'training data licensing not fully mirrored — verify',
      providerTerms: 'self-hosted under community terms; a hosted API also exists with separate terms',
    },
    runtime: OPEN_RUNTIME_GPU,
    patentNotes: 'none known at survey time — verify',
    meta: { role: 'image-to-3D + PBR texture generation for asset/props direction' },
    versions: [
      {
        version: '2.1',
        adapterVersion: '0 (registry characterization only)',
        capabilities: ['image-to-3d', 'pbr-texture-synthesis', 'mesh-generation'],
        resources: { gpu: 'required', vramGb: 16 },
        failureClasses: ['human-anatomy-artifacts', 'texture-seams'],
        provenance: { repoUrl: 'https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1' },
      },
    ],
  }),
  openEntry({
    techId: 'hunyuanvideo',
    name: 'HunyuanVideo / HunyuanVideo-Avatar',
    family: 'image-video-generation',
    vendor: 'Tencent',
    license: {
      code: 'Tencent Hunyuan Community License — verify (same restriction caveats as hunyuan3d)',
      weights: 'verify — community license terms',
      data: 'verify',
      providerTerms: 'self-hosted under community terms',
    },
    runtime: 'Linux, high-VRAM GPU (24 GB+ recommended; Avatar variant heavier)',
    patentNotes: 'none known at survey time — verify',
    meta: { role: 'open video generation / audio-driven avatar animation reference for the render plane' },
    versions: [
      {
        version: 'Avatar (2025)',
        adapterVersion: '0 (registry characterization only)',
        capabilities: ['video-generation', 'audio-driven-avatar-animation'],
        resources: { gpu: 'required', vramGb: 24 },
        failureClasses: ['temporal-flicker', 'identity-drift', 'slow-inference'],
        provenance: { repoUrl: 'https://github.com/Tencent-Hunyuan/HunyuanVideo-Avatar' },
      },
    ],
  }),
  openEntry({
    techId: 'liveportrait',
    name: 'LivePortrait',
    family: 'facial-animation',
    vendor: 'Kling AI Research (Kuaishou)',
    license: {
      code: 'verify — repository license must be rechecked (historically MIT for code)',
      weights: 'verify — pretrained checkpoints; InsightFace-derived components historically non-commercial',
      data: 'verify',
      providerTerms: 'n/a — self-hosted',
    },
    runtime: OPEN_RUNTIME_GPU,
    patentNotes: 'none known at survey time — verify',
    meta: { role: 'efficient portrait animation (stitching + retargeting) for performance-driven rendering' },
    versions: [
      {
        version: '1.0',
        adapterVersion: '0 (registry characterization only)',
        capabilities: ['portrait-animation', 'expression-retargeting', 'stitching'],
        resources: { gpu: 'required', vramGb: 8 },
        failureClasses: ['occlusion-artifacts', 'identity-leak-on-extreme-poses'],
        provenance: { repoUrl: 'https://github.com/KlingAIResearch/LivePortrait' },
      },
    ],
  }),

  // ─── Closed/provider pool (status: closed-characterized; public docs only) ─
  closedEntry({
    techId: 'vertex-virtual-try-on',
    name: 'Google Vertex AI Virtual Try-On',
    family: 'virtual-try-on',
    vendor: 'Google Cloud',
    runtime: 'hosted API (Vertex AI)',
    patentNotes: 'provider-held IP; characterize via public documentation and authorized API usage only',
    meta: {
      characterization: 'public docs only; no unauthorized internal inspection',
      docsUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/image/generate-virtual-try-on',
      // P6.C8 — the adapter status note (kept consistent with what ships):
      // adapters/try-on.ts implements the provider-neutral try-on CONTRACT +
      // the hosted call mapped from public docs, fail-closed behind
      // YOU_TRYON_PROVIDER. Unverified in this sandbox (no authorized
      // credential) — the honest gap stays labeled.
      adapterNote:
        'tryon-adapter-1 (adapters/try-on.ts) behind YOU_TRYON_PROVIDER: hosted call implemented from public docs, UNVERIFIED without credentials; sandbox default is fail-closed unavailable',
    },
    versions: [
      {
        version: 'GA (verify current)',
        adapterVersion:
          '1 (tryon-adapter-1, P6.C8 — provider-neutral contract + fail-closed hosted path; visual-only claims enforced by contract, unverified without an authorized credential)',
        capabilities: ['virtual-try-on', 'garment-transfer', 'identity-preservation-report'],
        resources: {
          access: 'authorized GCP account + billing (YOU_TRYON_VERTEX_PROJECT/_LOCATION/_KEY)',
          costModel: 'per-image, provider-priced',
        },
        failureClasses: [
          'provider-terms-change',
          'garment-boundary-artifacts',
          'model-card-drift',
          'visual-vs-physical-fit-conflation', // the P6.C8 contract risk the disclaimer mitigates
        ],
        provenance: { docsUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/image/generate-virtual-try-on', source: 'closed' },
      },
    ],
  }),
  closedEntry({
    techId: 'heygen',
    name: 'HeyGen (Avatar IV API)',
    family: 'image-video-generation',
    vendor: 'HeyGen',
    runtime: 'hosted API',
    patentNotes: 'provider-held IP; characterize via public documentation and authorized API usage only',
    meta: { characterization: 'public docs only', observed: 'Avatar IV demonstrates programmatic photo+script → talking video with expressive facial motion and gestures', docsUrl: 'https://www.heygen.com/blog/announcing-the-avatar-iv-api' },
    versions: [
      {
        version: 'Avatar IV (verify current)',
        adapterVersion: '0 (characterization only)',
        capabilities: ['avatar-video', 'photo-plus-script-to-video', 'expressive-gestures'],
        resources: { access: 'commercial API subscription' },
        failureClasses: ['provider-terms-change', 'uncanny-mouth-artifacts'],
        provenance: { docsUrl: 'https://docs.heygen.com/', source: 'closed' },
      },
    ],
  }),
  closedEntry({
    techId: 'tavus',
    name: 'Tavus',
    family: 'image-video-generation',
    vendor: 'Tavus',
    runtime: 'hosted API',
    patentNotes: 'provider-held IP; public docs only',
    meta: { characterization: 'public docs only', docsUrl: 'https://www.tavus.io/' },
    versions: [
      {
        version: 'API (verify current)',
        adapterVersion: '0 (characterization only)',
        capabilities: ['conversational-video', 'talking-head-generation'],
        resources: { access: 'commercial API subscription' },
        failureClasses: ['provider-terms-change', 'latency-under-load'],
        provenance: { docsUrl: 'https://www.tavus.io/', source: 'closed' },
      },
    ],
  }),
  closedEntry({
    techId: 'did',
    name: 'D-ID',
    family: 'image-video-generation',
    vendor: 'D-ID',
    runtime: 'hosted API',
    patentNotes: 'provider-held IP; public docs only',
    meta: { characterization: 'public docs only', docsUrl: 'https://docs.d-id.com/' },
    versions: [
      {
        version: 'API (verify current)',
        adapterVersion: '0 (characterization only)',
        capabilities: ['talking-avatar', 'photo-animation', 'streams-api'],
        resources: { access: 'commercial API subscription' },
        failureClasses: ['provider-terms-change', 'face-identity-leak-concerns'],
        provenance: { docsUrl: 'https://docs.d-id.com/', source: 'closed' },
      },
    ],
  }),
  closedEntry({
    techId: 'synthesia',
    name: 'Synthesia',
    family: 'image-video-generation',
    vendor: 'Synthesia',
    runtime: 'hosted API',
    patentNotes: 'provider-held IP; public docs only',
    meta: { characterization: 'public docs only', docsUrl: 'https://docs.synthesia.io/' },
    versions: [
      {
        version: 'API v2 (verify current)',
        adapterVersion: '0 (characterization only)',
        capabilities: ['avatar-video-from-script', 'enterprise-governance'],
        resources: { access: 'commercial API subscription' },
        failureClasses: ['provider-terms-change', 'limited-likeness-fidelity'],
        provenance: { docsUrl: 'https://docs.synthesia.io/', source: 'closed' },
      },
    ],
  }),
  closedEntry({
    techId: 'nvidia-ace',
    name: 'NVIDIA ACE',
    family: 'agent-embodiment',
    vendor: 'NVIDIA',
    runtime: 'hosted + on-prem components (NIM microservices)',
    patentNotes: 'provider-held IP; public docs only',
    meta: { characterization: 'public docs only', docsUrl: 'https://www.nvidia.com/en-us/ai-data-science/ai-agents/' },
    versions: [
      {
        version: 'ACE NIM (verify current)',
        adapterVersion: '0 (characterization only)',
        capabilities: ['autonomous-game-characters', 'speech-to-animation', 'on-prem-deployment'],
        resources: { access: 'NVIDIA developer program / licensing' },
        failureClasses: ['provider-terms-change', 'gpu-hardware-coupling'],
        provenance: { docsUrl: 'https://www.nvidia.com/en-us/ai-data-science/ai-agents/', source: 'closed' },
      },
    ],
  }),
  closedEntry({
    techId: 'metahuman',
    name: 'MetaHuman',
    family: 'rendering',
    vendor: 'Epic Games',
    runtime: 'Unreal Engine editor + MetaHuman framework',
    patentNotes: 'provider-held IP; usage governed by Epic’s MetaHuman framework terms',
    meta: { characterization: 'public docs only', docsUrl: 'https://www.unrealengine.com/en-US/metahuman' },
    versions: [
      {
        version: 'MetaHuman framework (verify current)',
        adapterVersion: '0 (characterization only)',
        capabilities: ['high-fidelity-human-rig', 'realtime-render', 'engine-integration'],
        resources: { access: 'Unreal Engine / Epic account' },
        failureClasses: ['engine-lock-in', 'terms-change'],
        provenance: { docsUrl: 'https://www.unrealengine.com/en-US/metahuman', source: 'closed' },
      },
    ],
  }),
  closedEntry({
    techId: 'rokoko',
    name: 'Rokoko',
    family: 'motion-capture',
    vendor: 'Rokoko',
    runtime: 'suit/vision capture + hosted streaming',
    patentNotes: 'provider-held IP; public docs only',
    meta: { characterization: 'public docs only', docsUrl: 'https://www.rokoko.com/products/vision' },
    versions: [
      {
        version: 'Vision (verify current)',
        adapterVersion: '0 (characterization only)',
        capabilities: ['markerless-motion-capture', 'video-to-animation'],
        resources: { access: 'commercial subscription' },
        failureClasses: ['provider-terms-change', 'hands-tracking-limits'],
        provenance: { docsUrl: 'https://www.rokoko.com/products/vision', source: 'closed' },
      },
    ],
  }),

  // ─── YOU fixture adapters (status: candidate — honest, not validated) ──────
  {
    techId: 'vlm-recon-1',
    name: 'YOU VLM Reconstruction Analyzer',
    family: 'reconstruction-analysis',
    vendor: 'YOU local environment',
    source: 'fixture',
    license: {
      code: 'YOU fixture adapter — runs inside this sandbox only',
      weights: 'none owned — inference via the zai provider adapter (vision models); no training performed',
      data: 'no dataset usage — inference-only analysis of consented evidence assets',
      providerTerms: 'z-ai-web-dev-sdk sandbox terms — backend-only usage; raw evidence never leaves object storage except as inference input',
    },
    runtime: 'Node.js server job (backend-only); provider inference over base64 image inputs',
    patentNotes: 'analysis heuristics are YOU-authored; no third-party method claims',
    status: 'candidate',
    meta: {
      honestStatus: 'works in this sandbox; NOT validated, canaried or production-hardened',
      inferenceOnly: true,
      trainingOnBiometrics: false,
      privacy:
        'raw biometric evidence stays in object storage; the VLM receives image bytes as transient inference input; no persistence on provider side is assumed — verify provider terms before production',
      observedLatencyMs: { visionCall: 10959, note: 'single-observation sandbox measurement (2026-10-01), not a p50 distribution' },
    },
    versions: [
      {
        version: '1',
        adapterVersion: '1.0.0',
        capabilities: ['evidence-quality', 'appearance-analysis', 'morphology-estimation', 'region-coverage'],
        resources: { provider: 'zai vision (glm-5v-turbo binding observed)', callsPerAsset: 1 },
        failureClasses: ['json-parse-retry', 'provider-latency-spike', 'descriptor-hallucination-risk'],
        provenance: { adapterPath: 'src/lib/you/adapters/vlm-recon.ts', owner: 'Worker C lane' },
      },
    ],
  },
  {
    techId: 'svg-portrait-1',
    name: 'YOU SVG Portrait Renderer',
    family: 'rendering',
    vendor: 'YOU local environment',
    source: 'fixture',
    license: {
      code: 'YOU fixture adapter — deterministic in-process code, no AI',
      weights: 'none — pure algorithmic rendering',
      data: 'no dataset usage — renders from HTIR fields only',
      providerTerms: 'n/a — no external provider',
    },
    runtime: 'Node.js in-process (deterministic, seeded PRNG mulberry32)',
    patentNotes: 'none — original code',
    status: 'candidate',
    meta: {
      honestStatus: 'works in this sandbox; NOT validated/canaried/production',
      deterministic: true,
      determinismGuarantee: 'same HTIR content + same seed → byte-identical SVG',
      zeroCost: true,
    },
    versions: [
      {
        version: '1',
        adapterVersion: '1.0.0',
        capabilities: ['htir-to-svg-portrait', 'style-variants', 'palette-rendering'],
        resources: { cpu: 'negligible' },
        latencyP50Ms: 10,
        costUsdPerUnit: 0,
        failureClasses: ['unstyled-region-fallback'],
        provenance: { adapterPath: 'src/lib/you/adapters/svg-portrait.ts', owner: 'Worker C lane' },
      },
    ],
  },
  {
    techId: 'ai-image-1',
    name: 'YOU Provider Image Generation Adapter',
    family: 'image-video-generation',
    vendor: 'YOU local environment',
    source: 'fixture',
    license: {
      code: 'YOU fixture adapter — wraps the zai provider SDK',
      weights: 'provider-side models; no local weights',
      data: 'no training; prompts derived from consented HTIR descriptors',
      providerTerms: 'z-ai-web-dev-sdk sandbox terms — backend-only',
    },
    runtime: 'Node.js server job → provider image API → object storage',
    patentNotes: 'provider-side model IP; adapter code is YOU-authored',
    status: 'candidate',
    meta: {
      honestStatus: 'works in this sandbox; NOT validated/canaried/production',
      promptPolicy: 'prompts explicitly request a stylized avatar portrait and never claim real-identity likeness',
      costUsd: 'unknown — provider pricing not exposed to this sandbox; any recorded cost is a modeled estimate (costUsdModeled: true)',
    },
    versions: [
      {
        version: '1',
        adapterVersion: '1.0.0',
        capabilities: ['text-to-image', 'style-directed-portrait'],
        resources: { provider: 'zai images.generations', size: '768x1344' },
        failureClasses: ['provider-error', 'content-policy-rejection'],
        provenance: { adapterPath: 'src/lib/you/adapters/ai-image.ts', owner: 'Worker C lane' },
      },
    ],
  },
  {
    techId: 'ai-video-1',
    name: 'YOU Provider Video Generation Adapter',
    family: 'image-video-generation',
    vendor: 'YOU local environment',
    source: 'fixture',
    license: {
      code: 'YOU fixture adapter — wraps the zai provider SDK (async task API)',
      weights: 'provider-side models; no local weights',
      data: 'no training; image base (when used) is a derived render artifact',
      providerTerms: 'z-ai-web-dev-sdk sandbox terms — backend-only',
    },
    runtime: 'Node.js server job → provider video task API (poll ≤10 min) → object storage',
    patentNotes: 'provider-side model IP; adapter code is YOU-authored',
    status: 'candidate',
    meta: {
      honestStatus: 'works in this sandbox; NOT validated/canaried/production',
      costUsd: 'unknown — provider pricing not exposed; modeled estimates only (costUsdModeled: true)',
      timeoutPolicy: 'poll every 5s, hard bound 10 min, timeout = honest job failure',
    },
    versions: [
      {
        version: '1',
        adapterVersion: '1.0.0',
        capabilities: ['image-or-text-to-video', 'async-task-polling'],
        resources: { provider: 'zai video.generations + async.result.query', quality: 'speed', duration: 5, fps: 30 },
        failureClasses: ['provider-timeout', 'result-download-failure', 'provider-error'],
        provenance: { adapterPath: 'src/lib/you/adapters/ai-video.ts', owner: 'Worker C lane' },
      },
    ],
  },
  {
    techId: 'lab-segment-1',
    name: 'YOU Lab Region Segmenter (deterministic stage)',
    family: 'segmentation',
    vendor: 'YOU local environment',
    source: 'fixture',
    license: {
      code: 'YOU fixture adapter — deterministic Lab simulation stage',
      weights: 'none — seeded heuristic, no AI',
      data: 'no dataset usage — operates on Lab world ground truth',
      providerTerms: 'n/a — no external provider',
    },
    runtime: 'Node.js in-process (Lab benchmark simulation only)',
    patentNotes: 'none — original code',
    status: 'candidate',
    meta: {
      honestStatus: 'Lab-simulation stage; models a segmentation stage deterministically — NOT a real segmentation model',
      simulated: true,
      deterministic: true,
    },
    versions: [
      {
        version: '1',
        adapterVersion: '1.0.0',
        capabilities: ['region-segmentation (simulated)'],
        resources: { cpu: 'negligible' },
        latencyP50Ms: 120,
        costUsdPerUnit: 0,
        failureClasses: ['simulated-stage-fidelity-gap'],
        provenance: { adapterPath: 'src/lib/you/lab/benchmark.ts', owner: 'Worker C lane' },
      },
    ],
  },
  {
    techId: 'lab-merge-1',
    name: 'YOU Lab Evidence Merger (deterministic stage)',
    family: 'reconstruction-analysis',
    vendor: 'YOU local environment',
    source: 'fixture',
    license: {
      code: 'YOU fixture adapter — deterministic Lab simulation stage',
      weights: 'none — seeded heuristic, no AI',
      data: 'no dataset usage — operates on Lab world ground truth',
      providerTerms: 'n/a — no external provider',
    },
    runtime: 'Node.js in-process (Lab benchmark simulation only)',
    patentNotes: 'none — original code',
    status: 'candidate',
    meta: {
      honestStatus: 'Lab-simulation stage; models evidence merging deterministically — NOT a real fusion model',
      simulated: true,
      deterministic: true,
    },
    versions: [
      {
        version: '1',
        adapterVersion: '1.0.0',
        capabilities: ['evidence-merge (simulated)'],
        resources: { cpu: 'negligible' },
        latencyP50Ms: 60,
        costUsdPerUnit: 0,
        failureClasses: ['simulated-stage-fidelity-gap'],
        provenance: { adapterPath: 'src/lib/you/lab/benchmark.ts', owner: 'Worker C lane' },
      },
    ],
  },
  {
    techId: 'lab-qa-1',
    name: 'YOU Lab QA Gate (deterministic stage)',
    family: 'safety-moderation',
    vendor: 'YOU local environment',
    source: 'fixture',
    license: {
      code: 'YOU fixture adapter — deterministic Lab simulation stage',
      weights: 'none — seeded heuristic, no AI',
      data: 'no dataset usage — operates on Lab world ground truth',
      providerTerms: 'n/a — no external provider',
    },
    runtime: 'Node.js in-process (Lab benchmark simulation only)',
    patentNotes: 'none — original code',
    status: 'candidate',
    meta: {
      honestStatus: 'Lab-simulation stage; models a QA/verification gate deterministically — NOT a real QA model',
      simulated: true,
      deterministic: true,
    },
    versions: [
      {
        version: '1',
        adapterVersion: '1.0.0',
        capabilities: ['qa-gating (simulated)', 'deficiency-detection (simulated)'],
        resources: { cpu: 'negligible' },
        latencyP50Ms: 90,
        costUsdPerUnit: 0,
        failureClasses: ['simulated-stage-fidelity-gap'],
        provenance: { adapterPath: 'src/lib/you/lab/benchmark.ts', owner: 'Worker C lane' },
      },
    ],
  },
  {
    techId: 'soul-runtime-1',
    name: 'YOU Soul Binding Runtime',
    family: 'llm-vlm',
    vendor: 'YOU local environment',
    source: 'fixture',
    license: {
      code: 'YOU fixture adapter — implements the ADR-0002 Body/Soul seam over the zai provider',
      weights: 'provider-side models; no local weights',
      data: 'no training; conversation content is session-scoped per body memory policy',
      providerTerms: 'z-ai-web-dev-sdk sandbox terms — backend-only',
    },
    runtime: 'Node.js server (API route synchronous turn); real latency measured per call',
    patentNotes: 'none — YOU-authored runtime',
    status: 'candidate',
    meta: {
      honestStatus: 'works in this sandbox; NOT validated/canaried/production',
      embodimentRules: 'concise ≤120 words; never claims to be a real human or to possess the person’s identity',
      observedLatencyMs: { chatCall: 342, note: 'single-observation sandbox measurement (2026-10-01), not a p50 distribution' },
    },
    versions: [
      {
        version: '1',
        adapterVersion: '1.0.0',
        capabilities: ['agent-turn', 'chat', 'performance-event-emission'],
        resources: { provider: 'zai chat.completions' },
        failureClasses: ['provider-error', 'empty-completion'],
        provenance: { adapterPath: 'src/lib/you/lab/agent-turn.ts', owner: 'Worker C lane' },
      },
    ],
  },
];
