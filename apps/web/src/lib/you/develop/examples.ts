// ═══════════════════════════════════════════════════════════════════════════
// YOU Develop — official example flows (P6.B9, Worker B lane).
//
// Canonical SDK snippets for the primary platform flows, derived from the
// REAL routes only:
//  - every `operations` entry must exist in the frozen OpenAPI inventory
//    (tests/contract/b9-docs-playground.test.mjs asserts this);
//  - every `client.…` call must exist on the real @you/sdk-js YouClient
//    (structural test) AND must appear verbatim in
//    src/lib/you/develop/examples-compile.ts, which compiles the same calls
//    against the SDK's real types in the tsc gate — the snippets cannot
//    drift from the SDK or invent endpoints.
//
// Zero imports (pure data module — the node:test law).
// ═══════════════════════════════════════════════════════════════════════════

export interface ExampleFlow {
  id: string;
  title: string;
  description: string;
  /** Frozen-inventory operations ("METHOD /spec/path") this flow exercises. */
  operations: readonly string[];
  /** TypeScript SDK snippet (compiles against @you/sdk-js — see compile check). */
  code: string;
}

export const EXAMPLE_FLOWS: readonly ExampleFlow[] = [
  {
    id: 'bootstrap-session',
    title: 'Bootstrap a session',
    description: 'Establish who is calling: reuse the browser session (cookie auth) or create one — then every later call rides the same auth.',
    operations: ['GET /session', 'POST /session'],
    code: [
      "import { YouClient } from '@you/sdk-js';",
      '',
      '// Same-origin (Studio pattern) — the session cookie authenticates:',
      'const client = new YouClient();',
      '',
      '// Server-side / cross-origin: point at your origin and use an API key',
      '// (the secret is returned exactly once when you create it):',
      "// const client = new YouClient({",
      "//   baseUrl: 'https://api.you.example/v1',",
      "//   apiKey: 'you_sk_…',",
      '// });',
      '',
      '// Reuse the current session, or create one (dev demo bootstrap).',
      'const session = await client.session.get().catch(() => null);',
      'const boot = session ?? await client.session.create();',
      'console.log(boot.tenant.name, boot.user.name);',
    ].join('\n'),
  },
  {
    id: 'create-twin',
    title: 'Create a twin',
    description: 'The subject everything else builds on. Pass an idempotency key so retries are safe — creation chains into the consent gate in the UI.',
    operations: ['POST /twins', 'GET /twins/{id}'],
    code: [
      "const twin = await client.twins.create(",
      "  { displayName: 'Ada', personName: 'Ada Lovelace' },",
      '  crypto.randomUUID(), // x-idempotency-key — safe retries',
      ');',
      'console.log(twin.id, twin.status, twin.subjectId); // twin_… draft subj_…',
      '',
      '// Read it back with versions and capture sessions:',
      'const detail = await client.twins.get(twin.id);',
      'console.log(detail.versions.length, detail.captures.length);',
    ].join('\n'),
  },
  {
    id: 'capture',
    title: 'Capture evidence',
    description: 'Start a capture session, upload immutable region-tagged evidence, complete it — quality analysis runs as a durable job you poll.',
    operations: [
      'POST /twins/{id}/capture-sessions',
      'POST /captures/{id}/assets',
      'POST /captures/{id}/complete',
      'GET /jobs/{id}',
      'GET /evidence/{id}/url',
    ],
    code: [
      '// 1 · Start a capture session on the twin',
      'const capture = await client.captures.start(twin.id, {}, crypto.randomUUID());',
      '',
      '// 2 · Upload immutable evidence (region-tagged; consent-gated server-side)',
      "const bytes = new Blob(['…'], { type: 'image/jpeg' });",
      "const file = new File([bytes], 'front.jpg', { type: 'image/jpeg' });",
      "const asset = await client.captures.upload(capture.id, file, ['face.front']);",
      'console.log(asset.contentHash, asset.bytes);',
      '',
      '// 3 · Complete — quality analysis runs as a durable job',
      'const { jobId } = await client.captures.complete(capture.id, crypto.randomUUID());',
      'const job = await client.jobs.get(jobId); // poll until a terminal status',
      'console.log(job.status, job.progress);',
      '',
      '// A signed, expiring URL for one asset (evidence never travels unsigned):',
      'const signed = await client.captures.signEvidence(asset.id);',
      'console.log(signed.url, signed.expiresAt);',
    ].join('\n'),
  },
  {
    id: 'compile',
    title: 'Compile a TwinVersion',
    description: 'Compile captured evidence into an immutable HTIR TwinVersion — a durable job with real progress; the poll loop is the honest way to wait.',
    operations: [
      'POST /twins/{id}/compile',
      'GET /jobs/{id}',
      'GET /twins/{id}/versions',
    ],
    code: [
      'const { jobId } = await client.twins.compile(',
      '  twin.id,',
      "  { captureSessionId: capture.id, style: 'photorealistic' },",
      '  crypto.randomUUID(),',
      ');',
      '',
      'let job = await client.jobs.get(jobId);',
      "while (job.status === 'queued' || job.status === 'running') {",
      '  await new Promise((resolve) => setTimeout(resolve, 500));',
      '  job = await client.jobs.get(jobId);',
      '}',
      "if (job.status !== 'succeeded') throw new Error(job.error ?? 'compile failed');",
      '',
      '// The versions, newest last:',
      'const versions = await client.twins.versions(twin.id);',
      'const version = versions[versions.length - 1];',
      'console.log(version?.version, version?.status);',
    ].join('\n'),
  },
  {
    id: 'render',
    title: 'Render',
    description: 'Turn a published TwinVersion into an image or video artifact through the render adapters — every render is a job you can watch.',
    operations: ['GET /twins/{id}/versions', 'POST /renders', 'GET /jobs/{id}'],
    code: [
      'const versions = await client.twins.versions(twin.id);',
      'const version = versions[versions.length - 1];',
      "if (!version) throw new Error('no published version to render');",
      '',
      'const { jobId } = await client.renders.create(',
      '  {',
      '    twinId: twin.id,',
      '    twinVersionId: version.id,',
      "    kind: 'image',",
      "    style: 'stylized-portrait',",
      "    adapter: 'svg-portrait-1', // deterministic first-party renderer",
      '  },',
      '  crypto.randomUUID(),',
      ');',
      'const renderJob = await client.jobs.get(jobId); // poll until terminal',
      'console.log(renderJob.status, renderJob.kind);',
    ].join('\n'),
  },
  {
    id: 'artifact',
    title: 'Review the Solution Artifact',
    description: 'The portable review surface over canonical data — read the manifest, then send structured feedback (review requests; immutable versions never change in place).',
    operations: ['GET /artifacts/{id}', 'POST /feedback'],
    code: [
      "const artifactId = 'sol_…'; // from the Studio or a webhook payload",
      'const artifact = await client.artifacts.get(artifactId);',
      'console.log(artifact.title, artifact.manifest.type);',
      'console.log(artifact.manifest.consent.grantIds);',
      '',
      'const twinVersionId = artifact.manifest.twinVersion?.id;',
      "if (!twinVersionId) throw new Error('artifact has no twin version to review');",
      '',
      '// Structured feedback creates a review request — canonical data changes',
      '// only through new versions compiled from new evidence:',
      'await client.artifacts.feedback(',
      '  {',
      '    solutionArtifactId: artifact.id,',
      '    twinVersionId,',
      "    verdict: 'missing-detail',",
      "    region: 'face.profile',",
      "    note: 'ears unclear in the 3/4 view',",
      '  },',
      '  crypto.randomUUID(),',
      ');',
    ].join('\n'),
  },
  {
    id: 'evidence-request',
    title: 'Close the loop: request evidence',
    description: 'Ask for targeted evidence against a capability gap, then fulfill it with a guided consent-gated capture — the request links to the capture and flips to fulfilled on completion.',
    operations: ['POST /evidence-requests', 'POST /evidence-requests/{id}/fulfill'],
    code: [
      'const request = await client.artifacts.requestEvidence(',
      '  {',
      '    twinVersionId,',
      "    reason: 'profile unclear after the first capture',",
      "    capability: 'face.profile',",
      "    instructions: '90° side photo, even lighting',",
      "    expectedSignal: 'ear silhouette + jawline',",
      '  },',
      '  crypto.randomUUID(),',
      ');',
      'console.log(request.id, request.status); // evreq_… open',
      '',
      '// Fulfill with a guided capture on the twin (consent-gated server-side):',
      'const { captureSession } = await client.artifacts.fulfillEvidenceRequest(',
      '  request.id,',
      '  twin.id,',
      '  crypto.randomUUID(),',
      ');',
      'console.log(captureSession.id, captureSession.status);',
    ].join('\n'),
  },
];
