// ═══════════════════════════════════════════════════════════════════════════
// Compute-broker tests (P6.C3 — Worker C lane) — node:test.
//
// PURE UNIT TESTS — no server boot, no network, no real keys, no database.
// Covers the broker's pure half (lab/compute-routing.ts) composed with the
// REAL A6-FULL resilience helpers (core/retry.ts, core/deadletter.ts,
// core/circuit-breaker.ts):
//
//   1. routing selection — enable-list order, adapter compatibility,
//      privacy narrowing, failover when the hosted breaker is open,
//      fail-closed refusals with EVERY skip reason disclosed;
//   2. cost-guard fail-closed — ceiling semantics in rounded cents, the
//      distinct unverifiable-accounting refusal, safe parse fallbacks;
//   3. malformed-config tolerance — YOU_COMPUTE_PROVIDERS parsing never
//      throws, unknown/duplicate tokens skipped with reasons, garbage falls
//      back to the SAFE default (local-executor only);
//   4. honest cost labels — the shared modeled tables (zero-deterministic vs
//      modeled, with the must-be-replaced-with-measured notes);
//   5. dead-letter path — a broker-submitted workload whose provider exhausts
//      its bounded retries composes into the dead-letter record WITH its
//      embedded quote (exactly what GET /api/v1/maintenance/dead-jobs serves).
//
// Imported STATICALLY by tests/index.mjs — runs in the aggregated
// `node --test tests/` gate. The 'dashscope' breaker box is reset around the
// real-breaker test so sibling suites in the same process are unaffected.
// ═══════════════════════════════════════════════════════════════════════════
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  BROKER_WORKLOADS,
  COMPUTE_PROVIDER_TABLE,
  DEFAULT_COMPUTE_PROVIDERS,
  DEFAULT_TENANT_COST_CEILING_USD,
  MODELED_COST_USD,
  QUOTA_WINDOW_HOURS,
  computeProviderDescriptor,
  costFor,
  embedComputeRouting,
  embeddedComputeOf,
  isBrokerWorkload,
  parseComputeProviderList,
  parseEmbeddedCompute,
  parseTenantCostCeiling,
  quotaDecision,
  renderProviderForRouting,
  resolveAdapter,
  routeCompute,
} from '../../apps/web/src/lib/you/lab/compute-routing.ts';
import { withRetries, isRetryableError } from '../../apps/web/src/lib/you/core/retry.ts';
import {
  buildDeadLetterPayload,
  isDeadLetterOutcome,
  parseDeadLetterError,
} from '../../apps/web/src/lib/you/core/deadletter.ts';
import {
  ProviderUnavailableError,
  assertProviderAvailable,
  resetBreaker,
  tripBreaker,
} from '../../apps/web/src/lib/you/core/circuit-breaker.ts';

// ─── fixtures ────────────────────────────────────────────────────────────────

const BOTH_AVAILABLE = [
  { id: 'local-executor', available: true, hasKey: true },
  { id: 'dashscope-render', available: true, hasKey: true },
];

beforeEach(() => {
  resetBreaker('dashscope');
});

afterEach(() => {
  resetBreaker('dashscope');
});

// ─── 1. routing selection ────────────────────────────────────────────────────

test('routing: the safe default enable list is local-executor ONLY (a bad config can never route hosted by accident)', () => {
  assert.deepEqual(parseComputeProviderList(undefined).enabled, ['local-executor']);
  assert.deepEqual(DEFAULT_COMPUTE_PROVIDERS, ['local-executor']);
});

test('routing: hosted-first list routes the ai-image-1 render to dashscope-render', () => {
  const decision = routeCompute({
    workload: 'render.image',
    adapter: 'ai-image-1',
    enabled: ['dashscope-render', 'local-executor'],
    states: BOTH_AVAILABLE,
  });
  assert.equal(decision.providerId, 'dashscope-render');
  assert.equal(decision.failover, false);
  assert.equal(decision.refusalReason, null);
});

test('routing: local-first wins even when the hosted provider is enabled (first match = routing order)', () => {
  const decision = routeCompute({
    workload: 'render.image',
    adapter: 'ai-image-1',
    enabled: ['local-executor', 'dashscope-render'],
    states: BOTH_AVAILABLE,
  });
  assert.equal(decision.providerId, 'local-executor');
  assert.equal(decision.failover, false);
});

test('routing: svg-portrait-1 NEVER routes hosted — hosted-only refuses with the adapter reason', () => {
  const decision = routeCompute({
    workload: 'render.image',
    adapter: 'svg-portrait-1',
    enabled: ['dashscope-render'],
    states: BOTH_AVAILABLE,
  });
  assert.equal(decision.providerId, null);
  assert.match(decision.refusalReason, /adapter "svg-portrait-1" not served/);
  assert.match(decision.refusalReason, /deterministic in-process renderer/);
});

test('routing: svg-portrait-1 with both providers enabled routes local (deterministic renderer runs in-process)', () => {
  const decision = routeCompute({
    workload: 'render.image',
    adapter: 'svg-portrait-1',
    enabled: ['dashscope-render', 'local-executor'],
    states: BOTH_AVAILABLE,
  });
  assert.equal(decision.providerId, 'local-executor');
  assert.equal(decision.failover, false); // not a failover: adapter incompatibility, not availability
});

test('routing: twin.compile never routes hosted (the C1 recon seam is local-executor only)', () => {
  const hostedOnly = routeCompute({
    workload: 'twin.compile',
    enabled: ['dashscope-render'],
    states: BOTH_AVAILABLE,
  });
  assert.equal(hostedOnly.providerId, null);
  assert.match(hostedOnly.refusalReason, /does not serve workload "twin.compile"/);

  const withLocal = routeCompute({
    workload: 'twin.compile',
    enabled: ['dashscope-render', 'local-executor'],
    states: BOTH_AVAILABLE,
  });
  assert.equal(withLocal.providerId, 'local-executor');
});

test('routing: privacy "local-only" never routes hosted — the local provider serves instead (privacy only narrows)', () => {
  const decision = routeCompute({
    workload: 'render.image',
    adapter: 'ai-image-1',
    privacy: 'local-only',
    enabled: ['dashscope-render', 'local-executor'],
    states: BOTH_AVAILABLE,
  });
  assert.equal(decision.providerId, 'local-executor');
  assert.equal(decision.failover, false); // privacy skip is not an availability failover
  assert.ok(decision.skipped.some((s) => s.providerId === 'dashscope-render' && /privacy/.test(s.reason)));
});

test('routing: privacy "no-provider-egress" + hosted-only → fail-closed refusal that names the privacy law', () => {
  const decision = routeCompute({
    workload: 'render.video',
    adapter: 'ai-video-1',
    privacy: 'no-provider-egress',
    enabled: ['dashscope-render'],
    states: BOTH_AVAILABLE,
  });
  assert.equal(decision.providerId, null);
  assert.match(decision.refusalReason, /privacy "no-provider-egress" forbids provider egress/);
});

test('routing: hosted breaker OPEN + local enabled → failover to local (privacy narrowed, disclosed)', () => {
  const decision = routeCompute({
    workload: 'render.image',
    adapter: 'ai-image-1',
    enabled: ['dashscope-render', 'local-executor'],
    states: [
      { id: 'local-executor', available: true, hasKey: true },
      { id: 'dashscope-render', available: false, hasKey: true, skipReason: 'provider "dashscope" is unavailable (circuit breaker open)' },
    ],
  });
  assert.equal(decision.providerId, 'local-executor');
  assert.equal(decision.failover, true);
  assert.ok(decision.skipped.some((s) => s.providerId === 'dashscope-render' && /circuit breaker open/.test(s.reason)));
});

test('routing: hosted-only + breaker OPEN → fail-closed refusal carrying the breaker detail (no silent fallback)', () => {
  const decision = routeCompute({
    workload: 'render.image',
    adapter: 'ai-image-1',
    enabled: ['dashscope-render'],
    states: [{ id: 'dashscope-render', available: false, hasKey: true, skipReason: 'provider "dashscope" is unavailable (circuit breaker open) — cooldown has not elapsed' }],
  });
  assert.equal(decision.providerId, null);
  assert.equal(decision.failover, false);
  assert.match(decision.refusalReason, /circuit breaker open/);
});

test('routing: missing DASHSCOPE_API_KEY skips the hosted provider fail-closed (credentials are never guessed)', () => {
  const decision = routeCompute({
    workload: 'render.image',
    adapter: 'ai-image-1',
    enabled: ['dashscope-render', 'local-executor'],
    states: [
      { id: 'local-executor', available: true, hasKey: true },
      { id: 'dashscope-render', available: true, hasKey: false },
    ],
  });
  assert.equal(decision.providerId, 'local-executor');
  assert.equal(decision.failover, false); // credential skip is not an availability failover
  assert.ok(
    decision.skipped.some((s) => s.providerId === 'dashscope-render' && /DASHSCOPE_API_KEY is not configured/.test(s.reason)),
  );
});

test('routing: a refusal discloses EVERY skip reason, joined and per-provider', () => {
  const decision = routeCompute({
    workload: 'render.video',
    adapter: 'ai-video-1',
    enabled: ['dashscope-render', 'nope-provider', 'local-executor'],
    states: [
      { id: 'dashscope-render', available: true, hasKey: false },
      { id: 'local-executor', available: false, skipReason: 'job runner unavailable (test fixture)' },
    ],
  });
  assert.equal(decision.providerId, null);
  assert.match(decision.refusalReason, /DASHSCOPE_API_KEY is not configured/);
  assert.match(decision.refusalReason, /unknown provider id/);
  assert.match(decision.refusalReason, /job runner unavailable/);
  assert.equal(decision.skipped.length, 3);
});

test('routing: non-broker workloads fail closed with the routed-workload list', () => {
  const decision = routeCompute({ workload: 'lab.benchmark', enabled: ['local-executor'], states: BOTH_AVAILABLE });
  assert.equal(decision.providerId, null);
  assert.match(decision.refusalReason, /not broker-routed/);
  assert.ok(isBrokerWorkload('render.image') && isBrokerWorkload('render.video') && isBrokerWorkload('twin.compile'));
  assert.equal(isBrokerWorkload('lab.benchmark'), false);
});

test('routing (real breaker composition): a tripped dashscope breaker produces the unavailable state that fails routing over', () => {
  tripBreaker('dashscope', 'tripped by the P6.C3 unit suite');
  // the broker derives the state exactly this way (compute.ts providerRuntimeStates)
  let unavailable = null;
  try {
    assertProviderAvailable('dashscope');
  } catch (err) {
    unavailable = err;
  }
  assert.ok(unavailable instanceof ProviderUnavailableError, 'the open breaker refuses admission');
  assert.ok(unavailable.retryAfterMs > 0, 'the refusal carries retry guidance');
  const decision = routeCompute({
    workload: 'render.image',
    adapter: 'ai-image-1',
    enabled: ['dashscope-render', 'local-executor'],
    states: [
      { id: 'local-executor', available: true, hasKey: true },
      { id: 'dashscope-render', available: false, hasKey: true, skipReason: unavailable.message },
    ],
  });
  assert.equal(decision.providerId, 'local-executor');
  assert.equal(decision.failover, true);
  assert.match(decision.skipped[0].reason, /circuit breaker open/);
  assert.match(decision.skipped[0].reason, /reasonable to retry in ~\d+s/, 'the routed skip reason carries the breaker retry guidance');
});

// ─── 2. cost-guard fail-closed ───────────────────────────────────────────────

test('quota: under the ceiling the submit is allowed (no refusal)', () => {
  const decision = quotaDecision({ ceilingUsd: 50, windowSpendUsd: 10, quotedUsd: 0.04, workload: 'render.image' });
  assert.equal(decision.allowed, true);
  assert.equal(decision.refusal, null);
  assert.equal(decision.windowHours, QUOTA_WINDOW_HOURS);
});

test('quota: over the ceiling → refused with the typed code and full details (the 402 envelope payload)', () => {
  const decision = quotaDecision({ ceilingUsd: 0.05, windowSpendUsd: 0.04, quotedUsd: 0.04, workload: 'render.image', providerId: 'dashscope-render' });
  assert.equal(decision.allowed, false);
  assert.equal(decision.refusal.code, 'compute_quota_exceeded');
  assert.match(decision.refusal.message, /window spend \$0\.04 .* new quote \$0\.04 .* ceiling \$0\.05/);
  assert.match(decision.refusal.message, /rolling 24h, modeled-basis/);
  assert.equal(decision.refusal.details.ceilingUsd, 0.05);
  assert.equal(decision.refusal.details.windowSpendUsd, 0.04);
  assert.equal(decision.refusal.details.quotedUsd, 0.04);
  assert.equal(decision.refusal.details.windowHours, 24);
});

test('quota: the comparison is ROUNDED IN CENTS — 0.04 + 0.01 vs a 0.05 ceiling never flips on float artifacts', () => {
  const atEdge = quotaDecision({ ceilingUsd: 0.05, windowSpendUsd: 0.04, quotedUsd: 0.01, workload: 'render.image' });
  assert.equal(atEdge.allowed, true, '0.04 + 0.01 = 0.05 <= 0.05 (binary float 0.05000000000000001 must not refuse)');
});

test('quota: exactly at the ceiling is allowed (<=)', () => {
  const decision = quotaDecision({ ceilingUsd: 1, windowSpendUsd: 0.96, quotedUsd: 0.04, workload: 'render.video' });
  assert.equal(decision.allowed, true);
});

test('quota: ceiling 0 is a VALID operator choice — paid work refused, zero-cost deterministic renders still pass', () => {
  const paid = quotaDecision({ ceilingUsd: 0, windowSpendUsd: 0, quotedUsd: 0.04, workload: 'render.image' });
  assert.equal(paid.allowed, false);
  assert.equal(paid.refusal.code, 'compute_quota_exceeded');

  const free = quotaDecision({ ceilingUsd: 0, windowSpendUsd: 0, quotedUsd: 0, workload: 'render.image' });
  assert.equal(free.allowed, true);
});

test('quota: NON-FINITE accounting REFUSES with the distinct unverifiable code — never a guess (fail-closed)', () => {
  const nanQuoted = quotaDecision({ ceilingUsd: 50, windowSpendUsd: 0, quotedUsd: Number.NaN, workload: 'render.image' });
  assert.equal(nanQuoted.allowed, false);
  assert.equal(nanQuoted.refusal.code, 'compute_quota_unverifiable');
  assert.match(nanQuoted.refusal.message, /unverifiable/);

  const negativeSpend = quotaDecision({ ceilingUsd: 50, windowSpendUsd: -1, quotedUsd: 0.04, workload: 'render.image' });
  assert.equal(negativeSpend.allowed, false);
  assert.equal(negativeSpend.refusal.code, 'compute_quota_unverifiable');
});

test('quota: ceiling parse — unset/empty/garbage/negative fall back to the default; "0" and decimals are honored', () => {
  assert.equal(parseTenantCostCeiling(undefined), DEFAULT_TENANT_COST_CEILING_USD);
  assert.equal(parseTenantCostCeiling(''), DEFAULT_TENANT_COST_CEILING_USD);
  assert.equal(parseTenantCostCeiling('   '), DEFAULT_TENANT_COST_CEILING_USD);
  assert.equal(parseTenantCostCeiling('not-a-number'), DEFAULT_TENANT_COST_CEILING_USD);
  assert.equal(parseTenantCostCeiling('-5'), DEFAULT_TENANT_COST_CEILING_USD);
  assert.equal(parseTenantCostCeiling('0'), 0, 'explicit 0 is a valid operator choice');
  assert.equal(parseTenantCostCeiling('12.5'), 12.5);
  assert.equal(DEFAULT_TENANT_COST_CEILING_USD, 50);
});

// ─── 3. malformed-config tolerance (boot never crashes) ─────────────────────

test('config: garbage YOU_COMPUTE_PROVIDERS tokens are skipped with documented reasons; valid tokens among garbage still apply', () => {
  const result = parseComputeProviderList('!!! , dashscope-render , ??? , local-executor');
  assert.deepEqual(result.enabled, ['dashscope-render', 'local-executor']);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /skipping token "!!!"/);
  assert.match(result.warnings[1], /skipping token "\?\?\?"/);
});

test('config: unset / empty / whitespace-only values fall back to the SAFE default (local-executor only)', () => {
  for (const raw of [undefined, '', '   ', '\t']) {
    const result = parseComputeProviderList(raw);
    assert.deepEqual(result.enabled, ['local-executor'], `raw=${JSON.stringify(raw)}`);
    assert.equal(result.warnings.length, 0);
  }
});

test('config: a fully-invalid list falls back to the default WITH a warning (never an empty enable list)', () => {
  const result = parseComputeProviderList('nope,also-nope');
  assert.deepEqual(result.enabled, ['local-executor']);
  assert.equal(result.warnings.length, 3); // two unknown tokens + the fallback warning
  assert.match(result.warnings[2], /falling back to the safe default/);
});

test('config: duplicate tokens keep the FIRST occurrence (routing order is deterministic) + a documented warning', () => {
  const result = parseComputeProviderList('dashscope-render, local-executor, dashscope');
  assert.deepEqual(result.enabled, ['dashscope-render', 'local-executor']);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /duplicate token "dashscope" .* first occurrence fixes the routing position/);
});

test('config: aliases and case/whitespace tolerance ("dashscope", "local", mixed case)', () => {
  const result = parseComputeProviderList(' DashScope , LOCAL ');
  assert.deepEqual(result.enabled, ['dashscope-render', 'local-executor']);
  assert.equal(result.warnings.length, 0);
});

test('config: parsing never throws on absurd input shapes', () => {
  for (const raw of [',,,', '::: ::', '3', 'local:exec', '🚀,dashscope', 'a'.repeat(500)]) {
    const result = parseComputeProviderList(raw);
    assert.ok(Array.isArray(result.enabled) && result.enabled.length > 0, `never empty for ${JSON.stringify(raw.slice(0, 20))}`);
    assert.ok(result.enabled.every((id) => id === 'local-executor' || id === 'dashscope-render'));
  }
});

// ─── 4. honest cost labels (the SHARED table — one source for both providers) ─

test('cost: svg-portrait-1 is zero-deterministic — an observable fact, not an estimate', () => {
  const cost = costFor('render.image', 'svg-portrait-1');
  assert.equal(cost.usd, 0);
  assert.equal(cost.basis, 'zero-deterministic');
  assert.match(cost.note, /no provider involved, marginal cost is genuinely 0 USD \(observable fact, not an estimate\)/);
});

test('cost: provider adapters are MODELED with the must-be-replaced honesty note (image/video/recon)', () => {
  const image = costFor('render.image', 'ai-image-1');
  assert.equal(image.usd, 0.04);
  assert.equal(image.basis, 'modeled');
  assert.match(image.note, /MUST be replaced with a measured cost before any promotion gate/);

  assert.equal(costFor('render.video', 'ai-video-1').usd, 0.1);
  assert.equal(costFor('twin.compile', 'vlm-recon-1').usd, 0.02);
});

test('cost: ONE shared table backs BOTH providers (the "same honest-cost semantics" law)', () => {
  assert.equal(MODELED_COST_USD['render.image:ai-image-1'], 0.04);
  assert.equal(MODELED_COST_USD['render.video:ai-video-1'], 0.1);
  assert.equal(MODELED_COST_USD['twin.compile:vlm-recon-1'], 0.02);
  assert.equal(MODELED_COST_USD['render.image:svg-portrait-1'], 0);
  // the provider table exists for exactly the two routable providers
  assert.deepEqual(COMPUTE_PROVIDER_TABLE.map((p) => p.id), ['local-executor', 'dashscope-render']);
  assert.equal(computeProviderDescriptor('dashscope-render')?.breakerKey, 'dashscope');
  assert.equal(computeProviderDescriptor('dashscope-render')?.requiredEnvKey, 'DASHSCOPE_API_KEY');
  assert.equal(computeProviderDescriptor('local-executor')?.breakerKey, null);
  // default adapter resolution mirrors the executor defaults
  assert.equal(resolveAdapter('render.image', undefined), 'svg-portrait-1');
  assert.equal(resolveAdapter('render.video', undefined), 'ai-video-1');
  assert.deepEqual([...BROKER_WORKLOADS], ['render.image', 'render.video', 'twin.compile']);
});

// ─── 5. dead-letter path for exhausted provider retries (real A6 helpers) ────

test('dead-letter: an always-503 provider call exhausts the bounded retries and classifies DEAD (real retry engine)', async () => {
  const calls = [];
  const outcome = await withRetries(
    async (attempt) => {
      calls.push(attempt);
      throw new Error('HTTP 503 upstream unavailable');
    },
    { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, budgetMs: 10_000, sleep: async () => {} },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.stoppedBy, 'exhausted-attempts');
  assert.equal(outcome.attempts, 3);
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(isRetryableError(outcome.error), true, 'a 503 is retryable');
  assert.equal(isDeadLetterOutcome(outcome), true, 'retried + exhausted → dead');
  const payload = buildDeadLetterPayload(outcome);
  const parsed = parseDeadLetterError(JSON.stringify(payload));
  assert.equal(parsed.code, 'dead_letter');
  assert.equal(parsed.attempts, 3);
  assert.equal(parsed.stoppedBy, 'exhausted-attempts');
  assert.match(parsed.lastError, /HTTP 503 upstream unavailable/);
});

test('dead-letter: a single NON-retryable failure stays a plain failure (never dead)', async () => {
  const outcome = await withRetries(
    async () => {
      throw new Error('validation_failed: consent required');
    },
    { maxAttempts: 3, baseDelayMs: 1, budgetMs: 10_000, sleep: async () => {} },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.stoppedBy, 'non-retryable');
  assert.equal(outcome.attempts, 1);
  assert.equal(isDeadLetterOutcome(outcome), false, 'non-retryable single failures stay "failed"');
});

test('dead-letter: a broker-submitted workload whose provider exhausts retries lands dead WITH its quote (the C3 composition)', async () => {
  // 1. the broker embeds the routing record + quote exactly this way (compute.ts submitComputeRouted)
  const quote = {
    providerId: 'dashscope-render',
    workload: 'render.image',
    acceptable: true,
    cost: { usd: 0.04, basis: 'modeled', note: 'modeled estimate — the provider does not expose pricing to this sandbox' },
    latency: { p50EstimateMs: 45_000, basis: 'modeled', observedRuns: 0, scope: 'none', note: 'modeled default' },
    privacy: { mode: 'tenant-data-egress-hosted', note: 'consent-gated' },
    queueDepth: 0,
    quotedAt: '2026-10-03T00:00:00.000Z',
  };
  const jobInput = embedComputeRouting(
    { renderJobId: 'rj_1', style: 'anime', adapter: 'ai-image-1' },
    { broker: 'compute-broker/p6c3', providerId: 'dashscope-render', routedVia: 'compute-broker/p6c3 routing (enabled: dashscope-render > local-executor; selected dashscope-render)', quotePhase: 'submit-time', quote },
  );
  const inputJson = JSON.stringify(jobInput);

  // 2. the provider keeps failing retryably → the job runner's bounded retries exhaust → dead
  const outcome = await withRetries(
    async () => {
      throw new Error('HTTP 503 dashscope unavailable');
    },
    { maxAttempts: 3, baseDelayMs: 1, budgetMs: 10_000, sleep: async () => {} },
  );
  assert.equal(isDeadLetterOutcome(outcome), true);

  // 3. the dead-letter list (GET /api/v1/maintenance/dead-jobs) serves BOTH records:
  //    the structured dead-letter payload from Job.error AND the embedded quote from Job.input
  const deadLetter = parseDeadLetterError(JSON.stringify(buildDeadLetterPayload(outcome)));
  const compute = parseEmbeddedCompute(inputJson);
  assert.equal(deadLetter.attempts, 3);
  assert.equal(compute.providerId, 'dashscope-render');
  assert.equal(compute.quotePhase, 'submit-time');
  assert.equal(compute.quote.cost.usd, 0.04);
  assert.equal(compute.quote.cost.basis, 'modeled');
  assert.match(String(compute.routedVia), /selected dashscope-render/);
});

// ─── embedded-record helpers (structure is never fabricated) ─────────────────

test('embedded record: build → parse round-trip preserves every routing field', () => {
  const record = { broker: 'compute-broker/p6c3', providerId: 'local-executor', routedVia: 'test route', quotePhase: 'submit-time', quote: { cost: { usd: 0 } } };
  const round = parseEmbeddedCompute(JSON.stringify(embedComputeRouting({ a: 1 }, record)));
  assert.deepEqual(round, record);
  // the object-input variant (executors) agrees with the JSON variant (routes)
  assert.deepEqual(embeddedComputeOf(embedComputeRouting({ a: 1 }, record)), record);
});

test('embedded record: absent / garbage / non-record inputs parse to null — never fabricated', () => {
  assert.equal(parseEmbeddedCompute(null), null);
  assert.equal(parseEmbeddedCompute(undefined), null);
  assert.equal(parseEmbeddedCompute(''), null);
  assert.equal(parseEmbeddedCompute('not json at all'), null);
  assert.equal(parseEmbeddedCompute('{"renderJobId":"rj_1"}'), null, 'a plain route-submitted job stays plain');
  assert.equal(parseEmbeddedCompute('{"__compute":{"noProviderIdHere":true}}'), null);
  assert.equal(embeddedComputeOf({}), null);
  assert.equal(embeddedComputeOf({ __compute: 'garbage-string' }), null);
});

// ─── broker routing → render seam mapping ────────────────────────────────────

test('seam mapping: dashscope-render maps to the dashscope override; everything else defers to the env seam', () => {
  assert.equal(renderProviderForRouting('dashscope-render'), 'dashscope');
  assert.equal(renderProviderForRouting('local-executor'), undefined, 'local routing keeps the YOU_RENDER_PROVIDER env law (C2 deployments unchanged)');
  assert.equal(renderProviderForRouting(null), undefined);
  assert.equal(renderProviderForRouting(undefined), undefined);
  assert.equal(renderProviderForRouting('garbage-provider'), undefined, 'unknown ids never fabricate a provider override');
});
