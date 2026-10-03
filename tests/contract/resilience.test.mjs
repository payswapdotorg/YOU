// ═══════════════════════════════════════════════════════════════════════════
// YOU resilience unit tests (P6.A6-FULL, Worker A lane) — node:test.
//
// Covers the four zero-runtime-import core modules DIRECTLY (Node >= 23.6
// type stripping, same pattern as the W1-a ai-registry suite):
//   core/retry.ts           — bounded retry engine (backoff+jitter, budgets,
//                             retry-after, fail-closed classification)
//   core/circuit-breaker.ts — per-provider breaker state machine
//   core/metrics.ts         — counter registry
//   core/deadletter.ts      — dead-letter payload build/parse + retention
//
// NO network, NO real providers, NO database: sleeps are injected, clocks are
// injected, env is snapshotted/restored per test. Route-level behavior
// (503 degraded path, metrics/dead-jobs/breaker admin routes, dead-letter
// end-to-end) lives in the STANDALONE suite resilience-routes.test.mjs.
//
// Imported STATICALLY (last) by tests/index.mjs — runs in the aggregated
// `node --test tests/` gate.
// ═══════════════════════════════════════════════════════════════════════════
import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  withRetries,
  isRetryableError,
  retryAfterFromError,
  retryDefaults,
  defaultRetryOptions,
} from '../../apps/web/src/lib/you/core/retry.ts';
import {
  callWithBreaker,
  assertProviderAvailable,
  breakerSnapshot,
  breakerConfig,
  resetBreaker,
  tripBreaker,
  ProviderUnavailableError,
} from '../../apps/web/src/lib/you/core/circuit-breaker.ts';
import {
  bumpCounter,
  counterKey,
  counterSnapshot,
  resetMetricsForTests,
} from '../../apps/web/src/lib/you/core/metrics.ts';
import {
  buildDeadLetterPayload,
  parseDeadLetterError,
  isDeadLetterOutcome,
  deadJobRetentionDays,
  deadJobCutoff,
  DEAD_LETTER_CODE,
  DEFAULT_DEAD_JOB_RETENTION_DAYS,
} from '../../apps/web/src/lib/you/core/deadletter.ts';

// ─── env isolation (the modules read knobs per call) ─────────────────────────
const RESILIENCE_ENV_KEYS = [
  'YOU_RETRY_MAX_ATTEMPTS', 'YOU_RETRY_BASE_DELAY_MS', 'YOU_RETRY_MAX_DELAY_MS', 'YOU_RETRY_BUDGET_MS',
  'YOU_JOB_MAX_ATTEMPTS', 'YOU_JOB_RETRY_BASE_DELAY_MS', 'YOU_JOB_RETRY_BUDGET_MS',
  'YOU_WEBHOOK_RETRY_MAX_ATTEMPTS',
  'YOU_BREAKER_ENABLED', 'YOU_BREAKER_FAILURE_THRESHOLD', 'YOU_BREAKER_WINDOW_MS', 'YOU_BREAKER_COOLDOWN_MS',
  'YOU_DEAD_JOB_RETENTION_DAYS',
];
let envBackup = {};

beforeEach(() => {
  envBackup = {};
  for (const k of RESILIENCE_ENV_KEYS) {
    envBackup[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of RESILIENCE_ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
  resetMetricsForTests();
});

// fake sleep that RECORDS delays instead of waiting
function recorderSleep(log) {
  return async (ms) => { log.push(ms); };
}
const retryable = () => Object.assign(new Error('transient'), { status: 503 });
const nonRetryable = () => Object.assign(new Error('bad request'), { status: 400 });
const errText = (e) => (e instanceof Error ? e.message : String(e));

// ═══════════════════════════════════════════════════════════════════════════
// core/retry.ts
// ═══════════════════════════════════════════════════════════════════════════

test('retry: succeeds on the first attempt — one call, no sleeps, attempts=1', async () => {
  const sleeps = [];
  let calls = 0;
  const out = await withRetries(async (attempt) => { calls += 1; assert.equal(attempt, calls); return 'ok'; },
    { sleep: recorderSleep(sleeps), baseDelayMs: 100 });
  assert.equal(out.ok, true);
  assert.equal(out.value, 'ok');
  assert.equal(out.attempts, 1);
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, [], 'no sleep on first-try success');
});

test('retry: non-retryable error fails immediately — verbatim error, no sleeps', async () => {
  const sleeps = [];
  let calls = 0;
  const out = await withRetries(async () => { calls += 1; throw nonRetryable(); },
    { sleep: recorderSleep(sleeps), baseDelayMs: 100, maxAttempts: 5 });
  assert.equal(out.ok, false);
  assert.equal(out.stoppedBy, 'non-retryable');
  assert.equal(out.attempts, 1);
  assert.equal(calls, 1, 'the failing call ran exactly once');
  assert.deepEqual(sleeps, []);
  assert.match(errText(out.error), /bad request/, 'error surfaces verbatim');
});

test('retry: retryable error then success — attempt counters, exact backoff at jitter=0', async () => {
  const sleeps = [];
  const seenAttempts = [];
  const out = await withRetries(async (attempt) => {
    seenAttempts.push(attempt);
    if (attempt === 1) throw retryable();
    return 42;
  }, { sleep: recorderSleep(sleeps), baseDelayMs: 200, jitter: 0, maxAttempts: 3 });
  assert.equal(out.ok, true);
  assert.equal(out.value, 42);
  assert.equal(out.attempts, 2);
  assert.deepEqual(seenAttempts, [1, 2], 'per-call attempt counter is 1-based and sequential');
  assert.deepEqual(sleeps, [200], 'exponential backoff: first retry delay = base');
});

test('retry: exhaustion stops at maxAttempts — never infinite', async () => {
  const sleeps = [];
  let calls = 0;
  const out = await withRetries(async () => { calls += 1; throw retryable(); },
    { sleep: recorderSleep(sleeps), baseDelayMs: 10, maxAttempts: 3, jitter: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.stoppedBy, 'exhausted-attempts');
  assert.equal(out.attempts, 3);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [10, 20], 'backoff doubles (factor 2, jitter 0)');
});

test('retry: wall-clock budget STOPS the loop before sleeping past it', async () => {
  const sleeps = [];
  let calls = 0;
  const out = await withRetries(async () => { calls += 1; throw retryable(); },
    { sleep: recorderSleep(sleeps), baseDelayMs: 5000, budgetMs: 100, maxAttempts: 10, jitter: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.stoppedBy, 'budget');
  assert.equal(out.attempts, 1, 'stops after the first failure — next delay exceeds budget');
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, [], 'never slept past the budget');
});

test('retry: Retry-After is honored verbatim when the server sends one', async () => {
  const sleeps = [];
  const out = await withRetries(async (a) => {
    if (a === 1) throw Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 2500 });
    return 'ok';
  }, { sleep: recorderSleep(sleeps), baseDelayMs: 100, maxDelayMs: 8000, jitter: 1 });
  assert.equal(out.ok, true);
  assert.deepEqual(sleeps, [2500], 'server-requested delay replaces the backoff');
});

test('retry: Retry-After is CAPPED by maxDelayMs (bounded law beats a greedy server)', async () => {
  const sleeps = [];
  const out = await withRetries(async (a) => {
    if (a === 1) throw Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 999_999 });
    return 'ok';
  }, { sleep: recorderSleep(sleeps), baseDelayMs: 100, maxDelayMs: 3000, jitter: 0 });
  assert.equal(out.ok, true);
  assert.deepEqual(sleeps, [3000]);
});

test('retry: full jitter bounds — delay in [0, backoff]', async () => {
  for (let i = 0; i < 20; i += 1) {
    const sleeps = [];
    const out = await withRetries(async (a) => { if (a === 1) throw retryable(); return 'ok'; },
      { sleep: recorderSleep(sleeps), baseDelayMs: 100, maxAttempts: 2, jitter: 1 });
    assert.equal(out.ok, true);
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0] >= 0 && sleeps[0] <= 100, `jittered delay ${sleeps[0]} within [0,100]`);
  }
});

test('retry: maxDelayMs caps exponential growth', async () => {
  const sleeps = [];
  const out = await withRetries(async () => { throw retryable(); },
    { sleep: recorderSleep(sleeps), baseDelayMs: 1000, factor: 10, maxDelayMs: 1500, maxAttempts: 4, jitter: 0 });
  assert.equal(out.ok, false);
  assert.deepEqual(sleeps, [1000, 1500, 1500], 'delays never exceed the ceiling');
});

test('retry: onRetry hook observes each retry (attempt, error, delayMs)', async () => {
  const notices = [];
  const out = await withRetries(async (a) => { if (a < 3) throw retryable(); return 'ok'; },
    { sleep: recorderSleep([]), baseDelayMs: 50, maxAttempts: 3, jitter: 0, onRetry: (n) => notices.push(n) });
  assert.equal(out.ok, true);
  assert.equal(notices.length, 2);
  assert.equal(notices[0].attempt, 1);
  assert.equal(notices[0].delayMs, 50);
  assert.match(errText(notices[0].error), /transient/);
  assert.equal(notices[1].attempt, 2);
  assert.equal(notices[1].delayMs, 100);
});

test('retry: an onRetry hook that throws never breaks the retry loop', async () => {
  const out = await withRetries(async (a) => { if (a === 1) throw retryable(); return 'ok'; },
    { sleep: async () => {}, baseDelayMs: 1, onRetry: () => { throw new Error('observer bug'); } });
  assert.equal(out.ok, true);
  assert.equal(out.value, 'ok');
});

test('retry: isRetryableError — fail-closed classification', () => {
  const mk = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
  assert.equal(isRetryableError(mk(429)), true, '429 retryable');
  assert.equal(isRetryableError(mk(500)), true, '500 retryable');
  assert.equal(isRetryableError(mk(502)), true, '502 retryable');
  assert.equal(isRetryableError(mk(503)), true, '503 retryable');
  assert.equal(isRetryableError(mk(504)), true, '504 retryable');
  assert.equal(isRetryableError(mk(400)), false, '400 never retried');
  assert.equal(isRetryableError(mk(401)), false, '401 never retried');
  assert.equal(isRetryableError(mk(403)), false, '403 never retried');
  assert.equal(isRetryableError(mk(404)), false, '404 never retried');
  assert.equal(isRetryableError(mk(409)), false, '409 never retried');
  assert.equal(isRetryableError(Object.assign(new Error('x'), { code: 'provider_unavailable' })), false,
    'breaker fail-fast is NOT retryable (the breaker owns recovery)');
  const abort = new Error('The operation was aborted');
  abort.name = 'AbortError';
  assert.equal(isRetryableError(abort), true, 'timeout/abort retryable');
  assert.equal(isRetryableError(Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') })), true,
    'transport TypeError with cause retryable');
  assert.equal(isRetryableError(Object.assign(new Error('db gone'), { code: 'P1001' })), true, 'prisma unreachable retryable');
  assert.equal(isRetryableError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true, 'errno retryable');
  assert.equal(isRetryableError(new Error('429 too many requests')), true, 'provider string heuristic (SDK precedent)');
  assert.equal(isRetryableError(new Error('socket hang up')), true, 'network string heuristic');
  assert.equal(isRetryableError(new Error('a totally unknown bug')), false, 'unknown errors are never retried');
  assert.equal(isRetryableError(undefined), false, 'no error object');
  assert.equal(isRetryableError(Object.assign(new Error('hint'), { retryable: true })), true, 'explicit hint honored');
});

test('retry: retryAfterFromError duck-typing', () => {
  assert.equal(retryAfterFromError(Object.assign(new Error('x'), { retryAfterMs: 1200 })), 1200);
  assert.equal(retryAfterFromError(new Error('plain')), null);
  assert.equal(retryAfterFromError(Object.assign(new Error('x'), { retryAfterMs: -5 })), null);
  assert.equal(retryAfterFromError(Object.assign(new Error('x'), { retryAfterMs: 'soon' })), null);
});

test('retry: env knobs — honored when valid, defaults when missing or garbage', () => {
  assert.deepEqual(retryDefaults(), { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8000, budgetMs: 30000 });
  process.env.YOU_RETRY_MAX_ATTEMPTS = '5';
  process.env.YOU_RETRY_BASE_DELAY_MS = '250';
  process.env.YOU_RETRY_MAX_DELAY_MS = '4000';
  process.env.YOU_RETRY_BUDGET_MS = '10000';
  assert.deepEqual(retryDefaults(), { maxAttempts: 5, baseDelayMs: 250, maxDelayMs: 4000, budgetMs: 10000 });
  process.env.YOU_RETRY_MAX_ATTEMPTS = 'garbage';
  assert.equal(retryDefaults().maxAttempts, 3, 'garbage falls back (fail-closed)');
  process.env.YOU_RETRY_MAX_ATTEMPTS = '-2';
  assert.equal(retryDefaults().maxAttempts, 3, 'negative falls back');
  delete process.env.YOU_RETRY_MAX_ATTEMPTS;
  assert.equal(retryDefaults().maxAttempts, 3, 'delete restores default');
  // defaultRetryOptions carries the fail-closed classifier
  const opts = defaultRetryOptions();
  assert.equal(opts.retryOn(nonRetryable()), false);
  assert.equal(opts.retryOn(retryable()), true);
});

test('retry: env knob actually bounds a live sequence', async () => {
  process.env.YOU_RETRY_MAX_ATTEMPTS = '2';
  let calls = 0;
  const out = await withRetries(async () => { calls += 1; throw retryable(); },
    { sleep: async () => {}, baseDelayMs: 1, jitter: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.attempts, 2);
  assert.equal(calls, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// core/circuit-breaker.ts
// ═══════════════════════════════════════════════════════════════════════════

test('breaker: closed state passes calls through and records success', async () => {
  resetBreaker('p1');
  const v = await callWithBreaker('p1', async () => 'fine');
  assert.equal(v, 'fine');
  assert.equal(breakerSnapshot().p1.state, 'closed');
  assert.equal(breakerSnapshot().p1.successCount, 1);
});

test('breaker: threshold failures within the window OPEN it; further calls fail fast without invoking fn', async () => {
  resetBreaker('p2');
  process.env.YOU_BREAKER_FAILURE_THRESHOLD = '2';
  process.env.YOU_BREAKER_WINDOW_MS = '60000';
  process.env.YOU_BREAKER_COOLDOWN_MS = '30000';
  for (let i = 0; i < 2; i += 1) {
    await assert.rejects(() => callWithBreaker('p2', async () => { throw retryable(); }), /transient/);
  }
  const snap = breakerSnapshot().p2;
  assert.equal(snap.state, 'open', 'opened at threshold');
  assert.equal(snap.openedReason, '2 failures within the 60000ms window');
  // open refusal: typed error, fn NOT called, honest retryAfter
  let invoked = 0;
  await assert.rejects(
    () => callWithBreaker('p2', async () => { invoked += 1; return 'x'; }),
    (err) => {
      assert.ok(err instanceof ProviderUnavailableError);
      assert.equal(err.code, 'provider_unavailable');
      assert.equal(err.provider, 'p2');
      assert.equal(err.breakerState, 'open');
      assert.ok(err.retryAfterMs > 0 && err.retryAfterMs <= 30000);
      return true;
    },
  );
  assert.equal(invoked, 0, 'the provider function was never called while open');
});

test('breaker: read-only assertProviderAvailable refuses while cooling but never mutates state', async () => {
  resetBreaker('p3');
  process.env.YOU_BREAKER_FAILURE_THRESHOLD = '1';
  process.env.YOU_BREAKER_COOLDOWN_MS = '30000';
  await assert.rejects(() => callWithBreaker('p3', async () => { throw retryable(); }));
  assert.equal(breakerSnapshot().p3.state, 'open');
  // the route-level read-only check
  assert.throws(() => assertProviderAvailable('p3'), (err) => {
    assert.ok(err instanceof ProviderUnavailableError);
    assert.ok(err.retryAfterMs > 0);
    return true;
  });
  // read-only: state unchanged (still open, still refusing; no probe consumed)
  const snapAfter = breakerSnapshot().p3;
  assert.equal(snapAfter.state, 'open');
  await assert.rejects(
    () => callWithBreaker('p3', async () => 'late'),
    (err) => err instanceof ProviderUnavailableError,
    'still refusing — the route check did not silently half-open the breaker',
  );
});

test('breaker: cooldown elapses → half-open probe → success closes + clears the window', async () => {
  resetBreaker('p4');
  process.env.YOU_BREAKER_FAILURE_THRESHOLD = '1';
  process.env.YOU_BREAKER_WINDOW_MS = '60000';
  process.env.YOU_BREAKER_COOLDOWN_MS = '1000';
  let t = 1000000;
  const clock = () => t;
  await assert.rejects(() => callWithBreaker('p4', async () => { throw retryable(); }, clock));
  assert.equal(breakerSnapshot().p4.state, 'open');
  t += 1500; // cooldown (1000ms) elapsed
  const v = await callWithBreaker('p4', async () => 'recovered', clock);
  assert.equal(v, 'recovered');
  const snap = breakerSnapshot().p4;
  assert.equal(snap.state, 'closed', 'successful probe closes the breaker');
  assert.equal(snap.failuresInWindow, 0, 'window cleared on recovery');
  assert.equal(snap.openedAt, null);
});

test('breaker: failed half-open probe RE-OPENS with a fresh cooldown', async () => {
  resetBreaker('p5');
  process.env.YOU_BREAKER_FAILURE_THRESHOLD = '1';
  process.env.YOU_BREAKER_WINDOW_MS = '60000';
  process.env.YOU_BREAKER_COOLDOWN_MS = '1000';
  let t = 2000000;
  const clock = () => t;
  await assert.rejects(() => callWithBreaker('p5', async () => { throw retryable(); }, clock));
  t += 1000; // eligible for probe
  await assert.rejects(() => callWithBreaker('p5', async () => { throw retryable(); }, clock));
  const snap = breakerSnapshot().p5;
  assert.equal(snap.state, 'open', 'probe failure reopens');
  assert.match(snap.openedReason, /half-open probe failed/);
  assert.equal(snap.failureCount, 2);
  // fresh cooldown: refusing again immediately
  await assert.rejects(
    () => callWithBreaker('p5', async () => 'x', clock),
    (err) => err instanceof ProviderUnavailableError,
  );
});

test('breaker: half-open is single-flight — concurrent calls refuse, not stampede', async () => {
  resetBreaker('p6');
  process.env.YOU_BREAKER_FAILURE_THRESHOLD = '1';
  process.env.YOU_BREAKER_WINDOW_MS = '60000';
  process.env.YOU_BREAKER_COOLDOWN_MS = '1000';
  let t = 3000000;
  const clock = () => t;
  await assert.rejects(() => callWithBreaker('p6', async () => { throw retryable(); }, clock));
  t += 1000; // probe eligible
  let releaseProbe;
  const gate = new Promise((r) => { releaseProbe = r; });
  const probe = callWithBreaker('p6', async () => {
    await gate; // hold the probe open
    return 'probed';
  }, clock);
  // while the probe is in flight, a concurrent call must refuse fast
  await assert.rejects(
    () => callWithBreaker('p6', async () => 'should-not-run', clock),
    (err) => {
      assert.ok(err instanceof ProviderUnavailableError);
      assert.equal(err.breakerState, 'half-open');
      return true;
    },
  );
  releaseProbe();
  assert.equal(await probe, 'probed');
  assert.equal(breakerSnapshot().p6.state, 'closed');
});

test('breaker: rolling window — failures age out and stop counting', async () => {
  resetBreaker('p7');
  process.env.YOU_BREAKER_FAILURE_THRESHOLD = '2';
  process.env.YOU_BREAKER_WINDOW_MS = '100';
  process.env.YOU_BREAKER_COOLDOWN_MS = '5000';
  let t = 4000000;
  const clock = () => t;
  await assert.rejects(() => callWithBreaker('p7', async () => { throw retryable(); }, clock));
  t += 200; // first failure aged out of the 100ms window
  await assert.rejects(() => callWithBreaker('p7', async () => { throw retryable(); }, clock));
  assert.equal(breakerSnapshot().p7.state, 'closed', 'one failure in-window does not meet the threshold of 2');
  t += 1; // still inside window for the second failure
  await assert.rejects(() => callWithBreaker('p7', async () => { throw retryable(); }, clock));
  assert.equal(breakerSnapshot().p7.state, 'open', 'two failures within the window open it');
});

test('breaker: manual reset closes; manual trip opens with the stated reason', () => {
  resetBreaker('p8');
  tripBreaker('p8', 'draining for maintenance');
  const tripped = breakerSnapshot().p8;
  assert.equal(tripped.state, 'open');
  assert.equal(tripped.openedReason, 'draining for maintenance');
  assert.ok(tripped.retryAfterMs > 0);
  assert.throws(() => assertProviderAvailable('p8'), /provider "p8" is unavailable/);
  resetBreaker('p8');
  const fresh = breakerSnapshot().p8;
  assert.equal(fresh.state, 'closed', 'reset installs a fresh closed box (provider stays visible)');
  assert.equal(fresh.failuresInWindow, 0);
  assert.equal(fresh.openedAt, null);
  assert.equal(fresh.openedReason, null);
  assert.equal(fresh.successCount, 0);
  assert.equal(fresh.failureCount, 0, 'lifetime counters cleared by reset');
  assert.doesNotThrow(() => assertProviderAvailable('p8'));
});

test('breaker: YOU_BREAKER_ENABLED=0 — pure passthrough, failures never open it', async () => {
  resetBreaker('p9');
  process.env.YOU_BREAKER_ENABLED = '0';
  process.env.YOU_BREAKER_FAILURE_THRESHOLD = '1';
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(() => callWithBreaker('p9', async () => { throw retryable(); }));
  }
  // the fresh box resetBreaker installed stays PRISTINE — the disabled breaker
  // recorded nothing on the way through
  const snap = breakerSnapshot().p9;
  assert.equal(snap.state, 'closed', 'disabled breaker records no failures');
  assert.equal(snap.failuresInWindow, 0);
  assert.equal(snap.failureCount, 0);
  assert.equal(snap.successCount, 0);
  assert.equal(await callWithBreaker('p9', async () => 'through'), 'through');
});

test('breaker: env parsing with fail-safe defaults', () => {
  assert.deepEqual(
    { ...breakerConfig() },
    { enabled: true, failureThreshold: 5, windowMs: 60000, cooldownMs: 30000 },
  );
  process.env.YOU_BREAKER_FAILURE_THRESHOLD = '3';
  process.env.YOU_BREAKER_WINDOW_MS = '12345';
  process.env.YOU_BREAKER_COOLDOWN_MS = '777';
  assert.deepEqual(
    { ...breakerConfig() },
    { enabled: true, failureThreshold: 3, windowMs: 12345, cooldownMs: 777 },
  );
  process.env.YOU_BREAKER_FAILURE_THRESHOLD = 'garbage';
  assert.equal(breakerConfig().failureThreshold, 5, 'garbage falls back');
  process.env.YOU_BREAKER_ENABLED = '0';
  assert.equal(breakerConfig().enabled, false, 'explicit off');
  delete process.env.YOU_BREAKER_ENABLED;
  assert.equal(breakerConfig().enabled, true, 'default on (fail-safe)');
});

// ═══════════════════════════════════════════════════════════════════════════
// core/metrics.ts
// ═══════════════════════════════════════════════════════════════════════════

test('metrics: labeled counters bump and snapshot with canonical keys', () => {
  resetMetricsForTests();
  assert.deepEqual(counterSnapshot(), {});
  bumpCounter('provider_retries', { provider: 'zai', operation: 'chat' });
  bumpCounter('provider_retries', { operation: 'chat', provider: 'zai' }); // label order irrelevant
  bumpCounter('provider_retries', { provider: 'openrouter', operation: 'vision' });
  bumpCounter('dead_jobs', { kind: 'capture.quality' });
  bumpCounter('rate_limit_hits', { bucket: 'session-bootstrap' }, 2);
  const snap = counterSnapshot();
  assert.equal(snap['provider_retries{operation=chat,provider=zai}'], 2, 'labels sorted canonically');
  assert.equal(snap['provider_retries{operation=vision,provider=openrouter}'], 1);
  assert.equal(snap['dead_jobs{kind=capture.quality}'], 1);
  assert.equal(snap['rate_limit_hits{bucket=session-bootstrap}'], 2);
  assert.equal(counterKey('x', { b: 1, a: 'z' }), 'x{a=z,b=1}');
  assert.equal(counterKey('x'), 'x');
  resetMetricsForTests();
  assert.deepEqual(counterSnapshot(), {});
});

// ═══════════════════════════════════════════════════════════════════════════
// core/deadletter.ts
// ═══════════════════════════════════════════════════════════════════════════

test('deadletter: payload build → parse round-trip preserves the structured truth', () => {
  const outcome = {
    ok: false,
    error: retryable(),
    attempts: 3,
    firstAttemptAt: Date.parse('2026-10-03T00:00:00Z'),
    finishedAt: Date.parse('2026-10-03T00:00:05Z'),
    stoppedBy: 'exhausted-attempts',
  };
  const payload = buildDeadLetterPayload(outcome);
  assert.equal(payload.code, DEAD_LETTER_CODE);
  assert.equal(payload.attempts, 3);
  assert.equal(payload.lastError, 'transient');
  assert.match(payload.firstAttemptAt, /^2026-10-03T00:00:00/);
  const encoded = JSON.stringify(payload);
  const parsed = parseDeadLetterError(encoded);
  assert.deepEqual(parsed, payload);
  // the job view keeps the raw string — parse never fabricates structure
  assert.equal(parseDeadLetterError('not json at all'), null);
  assert.equal(parseDeadLetterError(null), null);
  assert.equal(parseDeadLetterError(JSON.stringify({ code: 'other', attempts: 2 })), null);
  assert.equal(parseDeadLetterError(JSON.stringify({ code: DEAD_LETTER_CODE })), null, 'missing required fields → null');
});

test('deadletter: dead vs failed classification', () => {
  const mk = (attempts, stoppedBy) => ({
    ok: false, error: new Error('x'), attempts, firstAttemptAt: 0, finishedAt: 1, stoppedBy,
  });
  assert.equal(isDeadLetterOutcome(mk(1, 'non-retryable')), false, 'single non-retryable failure stays failed');
  assert.equal(isDeadLetterOutcome(mk(3, 'exhausted-attempts')), true, 'retried + exhausted → dead');
  assert.equal(isDeadLetterOutcome(mk(2, 'budget')), true, 'retried + budget stop → dead');
  assert.equal(isDeadLetterOutcome(mk(1, 'exhausted-attempts')), true, 'retryable failure with a 1-attempt budget → dead');
});

test('deadletter: retention knobs and cutoff math', () => {
  assert.equal(deadJobRetentionDays(), DEFAULT_DEAD_JOB_RETENTION_DAYS);
  assert.equal(DEFAULT_DEAD_JOB_RETENTION_DAYS, 30);
  process.env.YOU_DEAD_JOB_RETENTION_DAYS = '7';
  assert.equal(deadJobRetentionDays(), 7);
  const now = Date.parse('2026-10-03T12:00:00Z');
  assert.equal(deadJobCutoff(now, 30), now - 30 * 24 * 60 * 60 * 1000);
  assert.equal(deadJobCutoff(now, 0), now, 'retention 0 → everything purgeable');
  process.env.YOU_DEAD_JOB_RETENTION_DAYS = 'garbage';
  assert.equal(deadJobRetentionDays(), 30, 'garbage retention falls back to 30');
  process.env.YOU_DEAD_JOB_RETENTION_DAYS = '-5';
  assert.equal(deadJobRetentionDays(), 30, 'negative retention falls back (never purge the future)');
});
