// @you/sdk-js end-to-end smoke (Worker A lane, A8) — run with bun against a
// booted apps/web server:
//   BASE=http://127.0.0.1:3210/api/v1 bun run packages/sdk-js/smoke.ts
// Exercises the extracted typed client incl. the NEW verification-sessions
// surface (create → evidence → evaluate → 409 re-evaluate) and templates
// (create → idempotent replay → analyze job) over the real HTTP contract.
// NOT part of the node --test suite (the SDK is TypeScript; bun runs it natively).
import { YouClient, YouApiError, uid } from './src/index';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3210/api/v1';
let cookie: string | null = null;

const fetchWithCookie: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  if (cookie) headers.set('cookie', cookie);
  const res = await fetch(input, { ...init, headers, credentials: 'same-origin' });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return res;
};

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function pollJob(client: YouClient, jobId: string) {
  for (let i = 0; i < 120; i += 1) {
    const job = await client.jobs.get(jobId);
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`job ${jobId} did not finish`);
}

async function main() {
  const you = new YouClient({ baseUrl: BASE, fetchImpl: fetchWithCookie });

  // session bootstrap (cookie captured by the fetch shim)
  const session = await you.session.create();
  if (session.tenant.slug !== 'demo') throw new Error('unexpected tenant');
  console.log('sdk session.create →', session.user.email, '/', session.tenant.slug);

  const overview = await you.overview();
  console.log('sdk overview → twins:', overview.twins, 'captures:', overview.captures);

  // verification flow through the SDK (the NEW surface)
  const stamp = uid('sdk').slice(0, 40);
  const twin = await you.twins.create({ displayName: `SDK Twin ${stamp}`, personName: 'SDK Person' });
  console.log('sdk twins.create →', twin.id, twin.status);

  await you.consent.grant({ subjectId: twin.subjectId, purpose: 'sdk smoke', scopes: ['capture'], ttlHours: 2 });
  const cap = await you.captures.start(twin.id);
  const asset = await you.captures.upload(cap.id, new Blob([png], { type: 'image/png' }), [
    'face.front', 'face.profile', 'face.hairline', 'teeth', 'hands', 'silhouette.front', 'silhouette.side',
  ]);
  console.log('sdk captures.upload →', asset.id, asset.regions.length, 'regions, hash', asset.contentHash.slice(0, 12) + '…');

  const vs = await you.verificationSessions.create({ subjectId: twin.subjectId, purpose: 'sdk smoke liveness' });
  console.log('sdk verificationSessions.create →', vs.id, 'challenge', vs.challenge?.variant);

  try {
    await you.verificationSessions.evaluate(vs.id);
    throw new Error('evaluate on pending must throw');
  } catch (err) {
    if (!(err instanceof YouApiError) || err.status !== 409 || err.code !== 'conflict') throw err;
    console.log('sdk evaluate on pending → 409', JSON.stringify(err.code));
  }

  const inReview = await you.verificationSessions.submitEvidence(vs.id, [asset.id]);
  console.log('sdk verificationSessions.submitEvidence →', inReview.status);

  const evaluated = await you.verificationSessions.evaluate(vs.id);
  const r = evaluated.result!;
  console.log('sdk verificationSessions.evaluate →', evaluated.status, r.outcome, 'identityMatch:', r.identityMatch, 'visualSimilarity:', r.visualSimilarity, 'ownership:', r.ownershipConfidence);
  if (r.identityMatch !== null || r.visualSimilarity !== null) throw new Error('SDK surface must never claim identity/visual similarity');

  try {
    await you.verificationSessions.evaluate(vs.id);
    throw new Error('re-evaluate must throw');
  } catch (err) {
    if (!(err instanceof YouApiError) || err.status !== 409) throw err;
    console.log('sdk re-evaluate → 409 (immutable result)');
  }

  const persisted = await you.verificationSessions.get(vs.id);
  if (persisted.status !== 'evaluated' || !persisted.result) throw new Error('SDK read-back failed');
  console.log('sdk verificationSessions.get → persisted', persisted.status);

  // templates through the SDK (idempotency + analyze job)
  const idem = uid('sdk-tpl');
  const body = {
    name: `SDK Template ${stamp}`,
    captureChecklist: [{ item: 'Front', capability: 'face', region: 'face.front' as const }],
    scenes: [{ name: 'studio', parameters: { light: 'even' } }],
  };
  const t1 = await you.templates.create(body, idem);
  const t2 = await you.templates.create(body, idem); // replay
  if (t1.id !== t2.id) throw new Error('idempotent replay must return the same template');
  console.log('sdk templates.create →', t1.id, 'replay same id:', t2.id === t1.id);

  const { jobId } = await you.templates.analyze(t1.id, uid('sdk-ana'));
  const job = await pollJob(you, jobId);
  if (job.status !== 'succeeded') throw new Error(`analyze job ${job.status}: ${job.error}`);
  const analyzed = await you.templates.get(t1.id);
  console.log('sdk templates.analyze → job', job.status, 'analysis gaps:', analyzed.analysis?.evidenceGaps.length);

  console.log('\nSDK SMOKE COMPLETE — @you/sdk-js end-to-end OK');
}

main().catch((err) => {
  console.error('SDK SMOKE FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
