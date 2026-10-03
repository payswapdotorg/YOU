// ═══════════════════════════════════════════════════════════════════════════
// YOU P6.A6 resilience — pure unit tests (Worker A lane) — node:test.
//
// Imports the import-free core modules directly (Node ≥ 24 type stripping):
//   apps/web/src/lib/you/core/retry.ts    — bounded retries
//   apps/web/src/lib/you/core/breaker.ts  — provider circuit breaker
//   apps/web/src/lib/you/core/metrics.ts  — counters
//
// Everything deterministic: injected sleep recorder, injected jitter and
// injectable clock — no real timers, no network, no DB. The wired end-to-end
// behavior (routes, jobs, webhooks, providers) is proven by the standalone
// suite tests/contract/resilience.test.mjs (own server + mocked provider).
// ═══════════════════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { retry, RetryExhaustedError } from '../../apps/web/src/lib/you/core/retry.ts';
import {
  CircuitBreaker,
  ProviderUnavailableError,
  providerBreaker,
  providerBreakersSnapshot,
  resetProviderBreaker,
  breakerEnvConfig,
} from '../../apps/web/src/lib/you/core/breaker.ts';
import { incrCounter, countersSnapshot, resetCounters } from '../../apps/web/src/lib/you/core/metrics.ts';

const HERE = fileURLToPath(import.meta.url);

// ─── shared deterministic helpers ────────────────────────────────────────────

/** Sleep recorder: no real waiting, just the planned delays. */
function recorder() {
  const delays = [];
  return {
    delays,
    sleep: async (ms) => {
      delays.push(ms);
    },
  };
}

/** Fixed jitter (identity) so backoff math is exact. */
const identityJitter = (delay) => delay;

// ─── retry: the bounded loop ─────────────────────────────────────────────────

test('retry: success on the first attempt — one call, value returned, counter ok', async () => {
  const rec = recorder();
  let calls = 0;
  const attempts = [];
  const value = await retry(
    async () => {
      calls += 1;
      return 'ok';
    },
    'unit.success',
    {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      retryOn: () => true,
      sleep: rec.sleep,
      jitter: identityJitter,
      onAttempt: (info) => attempts.push(info),
    },
  );
  assert.equal(value, 'ok');
  assert.equal(calls, 1);
  assert.deepEqual(rec.delays, []);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].attempt, 1);
  assert.equal(attempts[0].ok, true);
  assert.equal(attempts[0].willRetry, false);
});

test('retry: always-failing retryable error STOPS at maxAttempts — never infinite', async () => {
  const rec = recorder();
  let calls = 0;
  const err = new Error('transient 503');
  await assert.rejects(
    retry(
      async () => {
        calls += 1;
        throw err;
      },
      'unit.stop',
      { maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 100, retryOn: () => true, sleep: rec.sleep, jitter: identityJitter },
    ),
    (e) => {
      assert.ok(e instanceof RetryExhaustedError, `expected RetryExhaustedError, got ${e?.constructor?.name}`);
      assert.equal(e.attempts, 4);
      assert.equal(e.stoppedBy, 'attempts');
      assert.equal(e.lastError, err);
      assert.match(e.message, /unit\.stop/);
      assert.match(e.message, /transient 503/);
      return true;
    },
  );
  assert.equal(calls, 4, 'exactly maxAttempts calls — the loop STOPS');
  assert.deepEqual(rec.delays, [10, 20, 40], 'exponential backoff between the four attempts');
});

test('retry: non-retryable error propagates UNTOUCHED after exactly one call', async () => {
  const rec = recorder();
  let calls = 0;
  const permanent = new Error('validation_failed: nope');
  await assert.rejects(
    retry(
      async () => {
        calls += 1;
        throw permanent;
      },
      'unit.permanent',
      { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100, retryOn: () => false, sleep: rec.sleep, jitter: identityJitter },
    ),
    (e) => e === permanent,
  );
  assert.equal(calls, 1);
  assert.deepEqual(rec.delays, []);
});

test('retry: backoff math — base × factor^n, capped by maxDelayMs', async () => {
  const rec = recorder();
  let calls = 0;
  await assert.rejects(
    retry(
      async () => {
        calls += 1;
        throw new Error('timeout');
      },
      'unit.math',
      { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 350, factor: 2, retryOn: () => true, sleep: rec.sleep, jitter: identityJitter },
    ),
    () => true,
  );
  assert.deepEqual(rec.delays, [100, 200, 350, 350], '100,200,400→capped 350, capped 350');
});

test('retry: default full jitter keeps the delay inside [0, raw]', async () => {
  const rec = recorder();
  await assert.rejects(
    retry(
      async () => {
        throw new Error('timeout');
      },
      'unit.jitter',
      { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 1000, retryOn: () => true, sleep: rec.sleep },
    ),
    () => true,
  );
  assert.equal(rec.delays.length, 2);
  for (const d of rec.delays) {
    assert.ok(d >= 0 && d <= 1000, `full jitter delay ${d} outside [0, 1000]`);
  }
});

test('retry: Retry-After is honored — the wait is never shorter than the server demand', async () => {
  const rec = recorder();
  await assert.rejects(
    retry(
      async () => {
        throw Object.assign(new Error('HTTP 429'), { status: 429, retryAfterMs: 5000 });
      },
      'unit.retry-after',
      {
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        retryOn: () => ({ retry: true, retryAfterMs: 5000 }),
        sleep: rec.sleep,
        jitter: identityJitter,
      },
    ),
    () => true,
  );
  assert.deepEqual(rec.delays, [5000, 5000], 'server floor beats both backoff and maxDelayMs');
});

test('retry: wall-clock budget STOPS the loop (stoppedBy: budget)', async () => {
  const rec = recorder();
  let calls = 0;
  let clock = 10_000;
  const advancePerAttempt = 600;
  await assert.rejects(
    retry(
      async () => {
        calls += 1;
        clock += advancePerAttempt; // simulated work time
        throw new Error('timeout');
      },
      'unit.budget',
      {
        maxAttempts: 10,
        baseDelayMs: 10,
        maxDelayMs: 10,
        budgetMs: 1000,
        retryOn: () => true,
        sleep: async (ms) => {
          rec.delays.push(ms);
          clock += ms;
        },
        jitter: identityJitter,
        now: () => clock,
      },
    ),
    (e) => {
      assert.ok(e instanceof RetryExhaustedError);
      assert.equal(e.stoppedBy, 'budget');
      assert.ok(e.attempts < 10, 'budget stopped well before the attempt cap');
      return true;
    },
  );
  assert.ok(calls >= 1 && calls < 10);
});

test('retry: per-call attempt counters — onAttempt observes every attempt and the final retry count', async () => {
  const rec = recorder();
  const seen = [];
  let calls = 0;
  await assert.rejects(
    retry(
      async () => {
        calls += 1;
        throw new Error('econn reset');
      },
      'unit.counters',
      {
        maxAttempts: 3,
        baseDelayMs: 5,
        maxDelayMs: 5,
        retryOn: () => true,
        sleep: rec.sleep,
        jitter: identityJitter,
        onAttempt: (info) => seen.push(info),
      },
    ),
    () => true,
  );
  assert.equal(calls, 3);
  assert.equal(seen.length, 3);
  assert.deepEqual(seen.map((s) => s.attempt), [1, 2, 3]);
  assert.deepEqual(seen.map((s) => s.ok), [false, false, false]);
  assert.deepEqual(seen.map((s) => s.willRetry), [true, true, false]);
  assert.deepEqual(seen.map((s) => s.nextDelayMs), [5, 5, null]);
});

test('retry: second attempt succeeds — value returned, two calls, one delay', async () => {
  const rec = recorder();
  let calls = 0;
  const value = await retry(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error('HTTP 503');
      return 'recovered';
    },
    'unit.recover',
    { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, retryOn: () => true, sleep: rec.sleep, jitter: identityJitter },
  );
  assert.equal(value, 'recovered');
  assert.equal(calls, 2);
  assert.deepEqual(rec.delays, [10]);
});

// ─── breaker: closed → open → half-open → closed/re-open ─────────────────────

function makeBreaker(overrides = {}) {
  let clock = 1_000_000;
  return {
    clock: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    breaker: new CircuitBreaker(
      'unit',
      { failureThreshold: 3, windowMs: 60_000, cooldownMs: 10_000, ...overrides },
      () => clock,
    ),
  };
}

test('breaker: trips open exactly at the threshold inside the window', () => {
  const { breaker, advance } = makeBreaker();
  assert.equal(breaker.canExecute().state, 'closed');
  breaker.recordFailure();
  breaker.recordFailure();
  assert.deepEqual(breaker.canExecute(), { allowed: true, state: 'closed', retryAfterMs: null });
  breaker.recordFailure(); // third inside the window → open
  const verdict = breaker.canExecute();
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.state, 'open');
  assert.ok(verdict.retryAfterMs > 0 && verdict.retryAfterMs <= 10_000);
  assert.equal(breaker.snapshot().failuresInWindow, 3);
});

test('breaker: rolling window — failures older than windowMs stop counting', () => {
  const { breaker, advance } = makeBreaker();
  breaker.recordFailure();
  breaker.recordFailure();
  advance(61_000); // both failures expire
  breaker.recordFailure(); // only ONE live failure now
  assert.equal(breaker.canExecute().state, 'closed', 'one live failure cannot trip a threshold of 3');
  assert.equal(breaker.snapshot().failuresInWindow, 1);
});

test('breaker: success clears the window and closes', () => {
  const { breaker } = makeBreaker();
  breaker.recordFailure();
  breaker.recordFailure();
  breaker.recordSuccess();
  assert.equal(breaker.snapshot().failuresInWindow, 0);
  assert.equal(breaker.canExecute().state, 'closed');
});

test('breaker: half-open admits exactly one probe; success closes, failure re-opens', () => {
  const { breaker, advance } = makeBreaker();
  for (let i = 0; i < 3; i += 1) breaker.recordFailure();
  assert.equal(breaker.canExecute().state, 'open');
  advance(10_001); // cooldown elapsed
  const probe = breaker.canExecute();
  assert.equal(probe.state, 'half-open');
  assert.equal(probe.allowed, true);
  // concurrent caller while the probe is live: refused
  const second = breaker.canExecute();
  assert.equal(second.allowed, false);
  assert.equal(second.state, 'half-open');
  // the probe FAILS → open again with a fresh cooldown
  breaker.recordFailure();
  const reopened = breaker.canExecute();
  assert.equal(reopened.state, 'open');
  assert.ok(reopened.retryAfterMs > 0);
});

test('breaker: half-open probe success closes and clears', () => {
  const { breaker, advance } = makeBreaker();
  for (let i = 0; i < 3; i += 1) breaker.recordFailure();
  advance(10_001);
  assert.equal(breaker.canExecute().state, 'half-open');
  breaker.recordSuccess();
  assert.deepEqual(breaker.canExecute(), { allowed: true, state: 'closed', retryAfterMs: null });
});

test('breaker: peek() is read-only — it never consumes the half-open probe', () => {
  const { breaker, advance } = makeBreaker();
  for (let i = 0; i < 3; i += 1) breaker.recordFailure();
  advance(10_001);
  assert.equal(breaker.peek().state, 'half-open');
  assert.equal(breaker.peek().allowed, true);
  assert.equal(breaker.peek().allowed, true, 'peek repeatedly — still allowed');
  // the probe is still there for a real call to take
  const real = breaker.canExecute();
  assert.equal(real.allowed, true);
  assert.equal(breaker.peek().allowed, false, 'now the live probe blocks others');
});

test('breaker: reset() is the manual operator path', () => {
  const { breaker } = makeBreaker();
  for (let i = 0; i < 3; i += 1) breaker.recordFailure();
  assert.equal(breaker.canExecute().state, 'open');
  breaker.reset();
  assert.deepEqual(breaker.canExecute(), { allowed: true, state: 'closed', retryAfterMs: null });
  assert.equal(breaker.snapshot().failuresInWindow, 0);
});

test('breaker: ProviderUnavailableError is typed, with provider + guidance', () => {
  const err = new ProviderUnavailableError('openrouter', 'open', 30_000);
  assert.equal(err.name, 'ProviderUnavailableError');
  assert.equal(err.kind, 'provider-unavailable');
  assert.equal(err.provider, 'openrouter');
  assert.equal(err.state, 'open');
  assert.equal(err.retryAfterMs, 30_000);
  assert.match(err.message, /openrouter/);
  assert.match(err.message, /30s/);
});

test('breaker: env config — invalid/negative values fall back to safe defaults', () => {
  const before = { ...process.env };
  try {
    process.env.YOU_PROVIDER_BREAKER_FAILURES = '-2';
    process.env.YOU_PROVIDER_BREAKER_WINDOW_MS = 'not-a-number';
    process.env.YOU_PROVIDER_BREAKER_COOLDOWN_MS = '';
    const cfg = breakerEnvConfig('zai');
    assert.equal(cfg.failureThreshold, 5);
    assert.equal(cfg.windowMs, 60_000);
    assert.equal(cfg.cooldownMs, 30_000);
    // per-provider override wins
    process.env.YOU_BREAKER_OPENROUTER_FAILURES = '7';
    assert.equal(breakerEnvConfig('openrouter').failureThreshold, 7);
  } finally {
    process.env.YOU_PROVIDER_BREAKER_FAILURES = before.YOU_PROVIDER_BREAKER_FAILURES;
    process.env.YOU_PROVIDER_BREAKER_WINDOW_MS = before.YOU_PROVIDER_BREAKER_WINDOW_MS;
    process.env.YOU_PROVIDER_BREAKER_COOLDOWN_MS = before.YOU_PROVIDER_BREAKER_COOLDOWN_MS;
    process.env.YOU_BREAKER_OPENROUTER_FAILURES = before.YOU_BREAKER_OPENROUTER_FAILURES;
  }
});

test('breaker: registry — resetProviderBreaker refuses unknown providers', () => {
  assert.throws(
    () => resetProviderBreaker('not-a-provider'),
    (e) => e instanceof Error && /unknown provider/.test(e.message),
  );
  const snap = resetProviderBreaker('zai');
  assert.equal(snap.provider, 'zai');
  assert.equal(snap.state, 'closed');
  assert.ok(providerBreakersSnapshot().zai, 'registry snapshot exposes the breaker');
});

// ─── metrics counters ────────────────────────────────────────────────────────

test('metrics: counters accumulate, snapshot, and reset (test seam)', () => {
  resetCounters();
  incrCounter('retries');
  incrCounter('retries');
  incrCounter('jobs.dead');
  incrCounter('ratelimit.hits.session-bootstrap', 3);
  incrCounter(''); // invalid name is a no-op, never throws
  const snap = countersSnapshot();
  assert.equal(snap['retries'], 2);
  assert.equal(snap['jobs.dead'], 1);
  assert.equal(snap['ratelimit.hits.session-bootstrap'], 3);
  resetCounters();
  assert.deepEqual(countersSnapshot(), {});
});

// keep import.meta.url referenced so tooling sees this file's provenance
void HERE;
