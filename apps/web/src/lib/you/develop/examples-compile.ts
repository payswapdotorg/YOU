// ═══════════════════════════════════════════════════════════════════════════
// YOU Develop — official example flows: THE COMPILE CHECK (P6.B9).
//
// This module compiles the exact `client.…` calls shown in the official
// example snippets (src/lib/you/develop/examples.ts) against the REAL
// @you/sdk-js types, in the apps/web tsc gate. It is a TYPE-CHECK artifact:
// it is never executed, imported by nothing at runtime, and exists so the
// snippets users copy can never drift from the SDK's real surface.
//
// tests/contract/b9-docs-playground.test.mjs enforces the mirror: every
// `client.<group>.<method>(` token appearing in the snippet strings must
// appear here (this file's source is read and compared token-for-token).
//
// The SDK is imported from the monorepo package source (relative path —
// apps/web does not depend on @you/sdk-js at runtime; the in-app client
// remains the TL-owned one).
// ═══════════════════════════════════════════════════════════════════════════
import { YouClient } from '../../../../../../packages/sdk-js/src/index';

const client = new YouClient();

/** Flow: bootstrap-session (GET/POST /session). */
export async function compileExampleBootstrapSession(): Promise<void> {
  const session = await client.session.get().catch(() => null);
  const boot = session ?? await client.session.create();
  void boot.tenant.name;
  void boot.user.name;
}

/** Flow: create-twin (POST /twins, GET /twins/{id}). */
export async function compileExampleCreateTwin(): Promise<void> {
  const twin = await client.twins.create(
    { displayName: 'Ada', personName: 'Ada Lovelace' },
    'idem-1',
  );
  void twin.id;
  void twin.status;
  void twin.subjectId;
  const detail = await client.twins.get(twin.id);
  void detail.versions.length;
  void detail.captures.length;
}

/** Flow: capture (start / upload / complete / poll job / signed URL). */
export async function compileExampleCapture(): Promise<void> {
  const twin = await client.twins.create({ displayName: 'Ada' }, 'idem-2');
  const capture = await client.captures.start(twin.id, {}, 'idem-3');
  const bytes = new Blob(['…'], { type: 'image/jpeg' });
  const file = new File([bytes], 'front.jpg', { type: 'image/jpeg' });
  const asset = await client.captures.upload(capture.id, file, ['face.front']);
  void asset.contentHash;
  void asset.bytes;
  const { jobId } = await client.captures.complete(capture.id, 'idem-4');
  const job = await client.jobs.get(jobId);
  void job.status;
  void job.progress;
  const signed = await client.captures.signEvidence(asset.id);
  void signed.url;
  void signed.expiresAt;
}

/** Flow: compile (POST /twins/{id}/compile → poll → GET /twins/{id}/versions). */
export async function compileExampleCompile(): Promise<void> {
  const twin = await client.twins.create({ displayName: 'Ada' }, 'idem-5');
  const capture = await client.captures.start(twin.id, {}, 'idem-6');
  const { jobId } = await client.twins.compile(
    twin.id,
    { captureSessionId: capture.id, style: 'photorealistic' },
    'idem-7',
  );
  let job = await client.jobs.get(jobId);
  while (job.status === 'queued' || job.status === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 0));
    job = await client.jobs.get(jobId);
  }
  if (job.status !== 'succeeded') throw new Error(job.error ?? 'compile failed');
  const versions = await client.twins.versions(twin.id);
  const version = versions[versions.length - 1];
  void version?.version;
  void version?.status;
}

/** Flow: render (GET /twins/{id}/versions → POST /renders → poll). */
export async function compileExampleRender(): Promise<void> {
  const twin = await client.twins.create({ displayName: 'Ada' }, 'idem-8');
  const versions = await client.twins.versions(twin.id);
  const version = versions[versions.length - 1];
  if (!version) throw new Error('no published version to render');
  const { jobId } = await client.renders.create(
    {
      twinId: twin.id,
      twinVersionId: version.id,
      kind: 'image',
      style: 'stylized-portrait',
      adapter: 'svg-portrait-1',
    },
    'idem-9',
  );
  const renderJob = await client.jobs.get(jobId);
  void renderJob.status;
  void renderJob.kind;
}

/** Flow: artifact (GET /artifacts/{id} → POST /feedback). */
export async function compileExampleArtifact(): Promise<void> {
  const artifactId = 'sol_example';
  const artifact = await client.artifacts.get(artifactId);
  void artifact.title;
  void artifact.manifest.type;
  void artifact.manifest.consent.grantIds;
  const twinVersionId = artifact.manifest.twinVersion?.id;
  if (!twinVersionId) throw new Error('artifact has no twin version to review');
  await client.artifacts.feedback(
    {
      solutionArtifactId: artifact.id,
      twinVersionId,
      verdict: 'missing-detail',
      region: 'face.profile',
      note: 'ears unclear in the 3/4 view',
    },
    'idem-10',
  );
}

/** Flow: evidence-request (POST /evidence-requests → fulfill). */
export async function compileExampleEvidenceRequest(): Promise<void> {
  const twinVersionId = 'twv_example';
  const request = await client.artifacts.requestEvidence(
    {
      twinVersionId,
      reason: 'profile unclear after the first capture',
      capability: 'face.profile',
      instructions: '90° side photo, even lighting',
      expectedSignal: 'ear silhouette + jawline',
    },
    'idem-11',
  );
  void request.id;
  void request.status;
  const twin = await client.twins.create({ displayName: 'Ada' }, 'idem-12');
  const { captureSession } = await client.artifacts.fulfillEvidenceRequest(
    request.id,
    twin.id,
    'idem-13',
  );
  void captureSession.id;
  void captureSession.status;
}

// The compiled symbols are intentionally unreferenced (this file is a type
// check). Keep a denormalized export so no bundler ever tree-shakes the
// functions out of type-checking consideration.
export const EXAMPLE_COMPILE_CHECK_EXPORTS = [
  compileExampleBootstrapSession,
  compileExampleCreateTwin,
  compileExampleCapture,
  compileExampleCompile,
  compileExampleRender,
  compileExampleArtifact,
  compileExampleEvidenceRequest,
] as const;
