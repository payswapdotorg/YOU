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

  // ─── P6.A8 surfaces: apiKeys (incl. rotate/revoke), webhooks, usage,
  // subjects.export, maintenance.gcStorage ─────────────────────────────────
  const created = await you.apiKeys.create({ name: `sdk-key ${stamp}`, scopes: ['read', 'write'] });
  if (!created.secret.startsWith('you_sk_')) throw new Error('apiKeys.create must return the one-time secret');
  console.log('sdk apiKeys.create →', created.key.id, 'secret one-time');

  const rotated = await you.apiKeys.rotate(created.key.id);
  if (rotated.key.id !== created.key.id) throw new Error('rotate must keep the key id');
  if (rotated.secret === created.secret) throw new Error('rotate must change the secret');
  console.log('sdk apiKeys.rotate → same id, new one-time secret');

  // the OLD secret must be dead: build a client with it and expect 401
  // (plain fetch — NO session cookie: cookie auth would mask the dead key)
  const stale = new YouClient({ baseUrl: BASE, apiKey: created.secret });
  let staleWorked = true;
  try { await stale.overview(); } catch (e) { staleWorked = !(e instanceof YouApiError && e.status === 401); }
  if (staleWorked) throw new Error('the old secret must 401 after rotation');
  console.log('sdk rotated-out secret → 401 (no overlap window)');

  // the NEW secret works (Bearer over the API-key surface)
  const fresh = new YouClient({ baseUrl: BASE, apiKey: rotated.secret });
  const twinsViaKey = await fresh.twins.list();
  console.log('sdk api-key auth → twins.list', twinsViaKey.length, 'readable');

  // api keys cannot trigger maintenance (operator-only) — the honest 403
  let got403 = false;
  try { await fresh.maintenance.gcStorage(); } catch (e) { got403 = e instanceof YouApiError && e.status === 403; }
  if (!got403) throw new Error('maintenance via api key must 403');
  console.log('sdk maintenance.gcStorage via api key → 403 (operator-only)');

  const revoked = await you.apiKeys.revoke(rotated.key.id);
  if (!revoked.revokedAt) throw new Error('revoke must set revokedAt');
  console.log('sdk apiKeys.revoke → terminal at', revoked.revokedAt);

  const hooks = await you.webhooks.list();
  void hooks;
  console.log('sdk webhooks.list →', hooks.length, 'endpoints');

  const usage = await you.usage();
  console.log('sdk usage → period', usage.period ?? 'n/a', '| entries:', (usage.events ?? []).length ?? 0);

  const twinForExport = await you.twins.create({ displayName: `SDK Export ${stamp}` });
  const exported = await you.subjects.export(twinForExport.subjectId);
  if (exported.subjectId !== twinForExport.subjectId) throw new Error('export subject mismatch');
  console.log('sdk subjects.export →', exported.twins.length, 'twin(s),', exported.evidenceAssets.length, 'asset(s)');

  console.log('\nSDK SMOKE COMPLETE — @you/sdk-js end-to-end OK (P6.A8 surfaces covered)');
}

main().catch((err) => {
  console.error('SDK SMOKE FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
