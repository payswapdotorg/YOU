// ═══════════════════════════════════════════════════════════════════════════
// YOU client UX-states unit tests (P6.B8, Worker B lane) — node:test.
//
// Covers the two zero-runtime-import client modules DIRECTLY (Node >= 23.6
// type stripping, same pattern as the W1-b resilience suite):
//   client/degraded.ts       — 503/Retry-After envelope parsing, degraded
//                              descriptor derivation, countdown math, terminal
//                              job-status model, dead-job explanation
//   client/error-taxonomy.ts — honest classification (rate-limited /
//                              provider-down / validation / … / unknown) +
//                              actionable one-line descriptions
//
// NO network, NO React, NO database, NO real keys: plain duck-typed error
// envelopes (the YouApiError class itself uses constructor parameter
// properties — not erasable TS — so client/api.ts is deliberately NOT
// node:test-importable; its retry-window derivation is a 1:1 inline mirror of
// degraded.ts retryAfterMsFromEnvelope, which IS unit-tested here. Route-level
// behavior for the maintenance/metrics surfaces lives in the standalone
// resilience-routes suite; the Studio components here are thin over both).
//
// Imported STATICALLY (last) by tests/index.mjs — runs in the aggregated
// `node --test tests/` gate.
// ═══════════════════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEGRADED_CODES,
  TERMINAL_JOB_STATUSES,
  isTerminalJobStatus,
  jobEndKind,
  retryAfterMsFromEnvelope,
  degradedFromApiError,
  countdownSecondsFrom,
  formatRetrySeconds,
  deadJobExplanation,
  DEAD_LETTER_MAINTENANCE_POINTER,
} from '../../apps/web/src/lib/you/client/degraded.ts';
import {
  classifyApiError,
  describeApiError,
} from '../../apps/web/src/lib/you/client/error-taxonomy.ts';

// ─── retry-window derivation (the parse both YouApiError and the UI use) ─────

test('ux: retryAfterMsFromEnvelope — typed details.retryAfterSeconds wins over the Retry-After header', () => {
  assert.equal(retryAfterMsFromEnvelope({ retryAfterSeconds: 7 }, '30'), 7000);
  assert.equal(retryAfterMsFromEnvelope({ retryAfterSeconds: 1.5 }, '30'), 1500);
});

test('ux: retryAfterMsFromEnvelope — Retry-After header (seconds) is the fallback', () => {
  assert.equal(retryAfterMsFromEnvelope(undefined, '12'), 12000);
  assert.equal(retryAfterMsFromEnvelope({}, '12'), 12000);
  assert.equal(retryAfterMsFromEnvelope({ other: true }, '5'), 5000);
});

test('ux: retryAfterMsFromEnvelope — absent or insane hints stay undefined (never fabricated)', () => {
  assert.equal(retryAfterMsFromEnvelope(undefined, undefined), undefined);
  assert.equal(retryAfterMsFromEnvelope(undefined, null), undefined);
  assert.equal(retryAfterMsFromEnvelope({}, ''), undefined);
  assert.equal(retryAfterMsFromEnvelope({}, 'garbage'), undefined);
  assert.equal(retryAfterMsFromEnvelope({}, '0'), undefined);
  assert.equal(retryAfterMsFromEnvelope({}, '-5'), undefined);
});

test('ux: retryAfterMsFromEnvelope — an invalid typed hint is treated as absent (header still applies)', () => {
  // the backend said SOMETHING via the header — using it is honest; only a
  // world with NO valid hint anywhere yields undefined
  for (const bad of [0, -1, Number.NaN, '7']) {
    assert.equal(retryAfterMsFromEnvelope({ retryAfterSeconds: bad }, '8'), 8000, `retryAfterSeconds=${String(bad)}`);
  }
  assert.equal(retryAfterMsFromEnvelope(['array'], '8'), 8000);
  assert.equal(retryAfterMsFromEnvelope(null, '8'), 8000);
});

// ─── degraded descriptor derivation ──────────────────────────────────────────

test('ux: degradedFromApiError — a typed 503 envelope becomes a full descriptor', () => {
  // shape mirrors YouApiError (client/api.ts): details verbatim + guidance /
  // retryAfterMs lifted to the top level by the client class
  const d = degradedFromApiError({
    code: 'service_unavailable',
    message: 'provider "zai" is temporarily unavailable (circuit breaker open)',
    status: 503,
    details: { provider: 'zai', breakerState: 'open', retryAfterSeconds: 30, guidance: 'retry after the delay' },
    retryAfterMs: 30000,
    guidance: 'retry after the delay',
  }, 'Twin reconstruction');
  assert.equal(d?.path, 'Twin reconstruction');
  assert.equal(d?.code, 'service_unavailable');
  assert.equal(d?.provider, 'zai');
  assert.equal(d?.breakerState, 'open');
  assert.equal(d?.retryAfterMs, 30000);
  assert.equal(d?.guidance, 'retry after the delay');
  assert.match(String(d?.reason), /circuit breaker open/);
});

test('ux: degradedFromApiError — provider-unavailable CODE counts even without status', () => {
  const d = degradedFromApiError({ code: 'provider_unavailable', message: 'cooling down', status: 0 }, 'Render');
  assert.equal(d?.code, 'provider_unavailable');
  assert.equal(d?.reason, 'cooling down');
  assert.equal(d?.provider, undefined); // no fabricated provider
});

test('ux: degradedFromApiError — non-degraded errors are NOT dressed up (null, never a guess)', () => {
  assert.equal(degradedFromApiError({ code: 'rate_limited', message: 'slow down', status: 429 }, 'X'), null);
  assert.equal(degradedFromApiError({ code: 'validation_failed', message: 'bad', status: 400 }, 'X'), null);
  assert.equal(degradedFromApiError(new Error('plain'), 'X'), null);
  assert.equal(degradedFromApiError('string error', 'X'), null);
  assert.equal(degradedFromApiError(null, 'X'), null);
});

test('ux: degradedFromApiError — 503 with no payload still yields honest defaults', () => {
  const d = degradedFromApiError({ status: 503 }, 'X');
  assert.equal(d?.code, 'service_unavailable');
  assert.equal(d?.reason, 'the backend reported a degraded state');
  assert.equal(d?.retryAfterMs, undefined);
  assert.equal('provider' in (d ?? {}), false);
});

test('ux: DEGRADED_CODES covers exactly the service/provider unavailability codes', () => {
  assert.deepEqual([...DEGRADED_CODES].sort(), ['provider_unavailable', 'service_unavailable']);
});

// ─── countdown math ───────────────────────────────────────────────────────────

test('ux: countdownSecondsFrom — ceil of the remaining window, anchored at receipt time', () => {
  const receivedAt = 1_000_000;
  assert.equal(countdownSecondsFrom(30_000, receivedAt, receivedAt + 0), 30);
  assert.equal(countdownSecondsFrom(30_000, receivedAt, receivedAt + 29_001), 1);
  assert.equal(countdownSecondsFrom(30_000, receivedAt, receivedAt + 29_000), 1);
  assert.equal(countdownSecondsFrom(30_000, receivedAt, receivedAt + 30_000), 0);
});

test('ux: countdownSecondsFrom — expired or insane windows clamp to 0 (never negative)', () => {
  assert.equal(countdownSecondsFrom(30_000, 1_000, 2_000_000), 0);
  assert.equal(countdownSecondsFrom(-5_000, 1_000, 1_001), 0);
  assert.equal(countdownSecondsFrom(Number.NaN, 1_000, 1_001), 0);
  assert.equal(countdownSecondsFrom(30_000, Number.NaN, 1_001), 0);
});

test('ux: formatRetrySeconds — honest human labels (0 = now, no decimals)', () => {
  assert.equal(formatRetrySeconds(0), 'now');
  assert.equal(formatRetrySeconds(-3), 'now'); // defensive floor
  assert.equal(formatRetrySeconds(1), '1s');
  assert.equal(formatRetrySeconds(59), '59s');
  assert.equal(formatRetrySeconds(60), '1m');
  assert.equal(formatRetrySeconds(61), '1m 1s');
  assert.equal(formatRetrySeconds(3599), '59m 59s');
  assert.equal(formatRetrySeconds(3600), '1h');
  assert.equal(formatRetrySeconds(3660), '1h 1m');
  assert.equal(formatRetrySeconds(86_400), '24h');
});

// ─── terminal job-status model (JobState `dead` is terminal) ─────────────────

test('ux: terminal job statuses — dead is terminal alongside the classics; queued/running are not', () => {
  assert.deepEqual(
    [...TERMINAL_JOB_STATUSES].sort(),
    ['cancelled', 'dead', 'failed', 'succeeded', 'unavailable'],
  );
  for (const s of ['succeeded', 'failed', 'cancelled', 'unavailable', 'dead']) {
    assert.equal(isTerminalJobStatus(s), true, s);
  }
  for (const s of ['queued', 'provisioning', 'running', 'collecting', '']) {
    assert.equal(isTerminalJobStatus(s), false, s);
  }
  assert.equal(jobEndKind('dead'), 'dead');
  assert.equal(jobEndKind('queued'), null); // no fabricated outcome while live
});

// ─── dead-job explanation ─────────────────────────────────────────────────────

test('ux: deadJobExplanation — structured truth, honest pluralization, verbatim last error', () => {
  const e1 = deadJobExplanation({
    code: 'dead_letter', attempts: 1, stoppedBy: 'exhausted-attempts',
    firstAttemptAt: '', lastErrorAt: '', lastError: 'HTTP 503 from provider',
  }, 'Twin reconstruction');
  assert.match(e1.title, /Twin reconstruction is dead/);
  assert.match(e1.summary, /retried 1 time\b/);
  assert.equal(e1.lastError, 'HTTP 503 from provider');
  assert.equal(e1.maintenance, DEAD_LETTER_MAINTENANCE_POINTER);

  const e3 = deadJobExplanation({
    code: 'dead_letter', attempts: 3, stoppedBy: 'budget',
    firstAttemptAt: '', lastErrorAt: '', lastError: 'timeout',
  }, 'Lab benchmark');
  assert.match(e3.summary, /retried 3 times/);
  assert.match(e3.summary, /stopped by "budget"/);
  assert.match(e3.summary, /Nothing is still running/);
});

test('ux: deadJobExplanation — degenerate payloads degrade honestly, never crash', () => {
  const e = deadJobExplanation({
    code: 'dead_letter', attempts: 0, stoppedBy: '',
    firstAttemptAt: '', lastErrorAt: '', lastError: '',
  }, 'Render');
  assert.match(e.summary, /retried 0 times/);
  assert.match(e.summary, /stopped by "unknown"/);
  assert.equal(e.lastError, 'the backend recorded no last error');
});

// ─── error taxonomy ───────────────────────────────────────────────────────────

test('ux: taxonomy — rate-limited (429 / rate_limited) is actionable with its window', () => {
  const c = classifyApiError({ code: 'rate_limited', message: 'rate limit exceeded for captures', status: 429, retryAfterMs: 9000 });
  assert.equal(c.kind, 'rate-limited');
  assert.match(c.title, /Rate-limited/);
  assert.match(c.title, /backoff active/);
  assert.equal(c.retryAfterMs, 9000);
  assert.equal(c.detail, 'rate limit exceeded for captures');
  // code alone (no status) also classifies
  assert.equal(classifyApiError({ code: 'rate_limited', message: 'x' }).kind, 'rate-limited');
});

test('ux: taxonomy — provider-down (503 / service_unavailable / provider_unavailable)', () => {
  for (const shape of [
    { code: 'service_unavailable', message: 'breaker open', status: 503, retryAfterMs: 30_000 },
    { code: 'service_unavailable', message: 'breaker open' },
    { code: 'provider_unavailable', message: 'cooling down', status: 503 },
    { status: 503, message: 'degraded' },
  ]) {
    const c = classifyApiError(shape);
    assert.equal(c.kind, 'provider-down', JSON.stringify(shape));
    assert.match(c.title, /Provider cooling down/);
  }
  const withWindow = classifyApiError({ code: 'service_unavailable', message: 'm', status: 503, retryAfterMs: 12_000 });
  assert.equal(withWindow.retryAfterMs, 12_000);
});

test('ux: taxonomy — validation / consent / auth / not-found / conflict are precise', () => {
  assert.equal(classifyApiError({ code: 'validation_failed', message: 'field "x" is required', status: 400 }).kind, 'validation');
  assert.equal(classifyApiError({ code: 'consent_required', message: 'grant needed', status: 403 }).kind, 'consent');
  assert.equal(classifyApiError({ code: 'unauthenticated', message: 'no session', status: 401 }).kind, 'auth');
  assert.equal(classifyApiError({ code: 'forbidden', message: 'operator only', status: 403 }).kind, 'auth');
  assert.equal(classifyApiError({ code: 'not_found', message: 'no such twin', status: 404 }).kind, 'not-found');
  assert.equal(classifyApiError({ code: 'conflict', message: 'version changed', status: 409 }).kind, 'conflict');
});

test('ux: taxonomy — unknown stays honestly unknown (no misleading guesses)', () => {
  const c = classifyApiError({ code: 'internal_error', message: 'boom at step 3', status: 500 });
  assert.equal(c.kind, 'unknown');
  assert.match(c.title, /unknown/i);
  assert.equal(c.detail, 'boom at step 3'); // verbatim, not paraphrased into optimism

  const bare = classifyApiError(new Error('network fell over'));
  assert.equal(bare.kind, 'unknown');
  assert.equal(bare.detail, 'network fell over');

  assert.equal(classifyApiError(null).kind, 'unknown');
  assert.equal(classifyApiError('oops').kind, 'unknown');
  const noMessage = classifyApiError({ code: '', status: 0 });
  assert.match(noMessage.detail, /no cause is being guessed/);
});

test('ux: taxonomy — a rate_limited code never masquerades as provider-down (and vice versa)', () => {
  assert.notEqual(classifyApiError({ code: 'rate_limited', status: 429 }).kind, 'provider-down');
  assert.notEqual(classifyApiError({ code: 'service_unavailable', status: 503 }).kind, 'rate-limited');
});

// ─── toast descriptions ───────────────────────────────────────────────────────

test('ux: describeApiError — class-first one-liners with retry seconds', () => {
  assert.match(describeApiError({ code: 'rate_limited', message: 'slow down', status: 429, retryAfterMs: 3000 }), /^Rate-limited \(backoff active\) — retry in 3s — slow down$/);
  assert.match(describeApiError({ code: 'service_unavailable', message: 'breaker open', status: 503, retryAfterMs: 30_000 }), /^Provider cooling down — retry in 30s — breaker open$/);
  assert.match(describeApiError({ code: 'validation_failed', message: 'field "name" is required', status: 400 }), /^Invalid input — field "name" is required$/);
  assert.match(describeApiError({ code: 'consent_required', message: 'grant the scope', status: 403 }), /^Consent required — grant the scope$/);
  assert.match(describeApiError(new Error('weird failure')), /^Unknown failure — weird failure$/);
  // sub-second windows round UP to a whole honest second (never "retry in 0s")
  assert.match(describeApiError({ code: 'rate_limited', message: 'm', status: 429, retryAfterMs: 1 }), /retry in 1s/);
});
