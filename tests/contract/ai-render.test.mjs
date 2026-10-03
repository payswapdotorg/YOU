// ═══════════════════════════════════════════════════════════════════════════
// YOU render provider tests (P6.C2 — Worker C lane) — node:test.
//
// Covers the production render path against a LOCAL mock of the DashScope
// (Alibaba Bailian) HTTP APIs, following the recon-openrouter convention:
// NO network beyond 127.0.0.1, NO real keys (placeholders only), NO database,
// NO app boot. Sleeps and clocks are injected for deterministic polling.
//
// Covered:
//   - render seam (ai/render-provider.ts): fail-closed provider selection
//     (station default, local/zai aliases, dashscope, unknown → throw),
//     registry-backed model resolution with the documented precedence
//     (YOU_AI_PROVIDERS pin > seam-level YOU_DASHSCOPE_*_MODEL knob >
//     registry healthy default), DASHSCOPE_API_KEY fail-closed at resolution
//     time, honest droppedParams recording for station-only video knobs;
//   - DashScope adapter (ai/dashscope.ts): request shapes against the local
//     mock (Bearer auth, task endpoints, W*H size normalization, img_url
//     mapping), typed error classification (auth / quota / http / parse /
//     timeout / task), honest failure propagation (verbatim provider
//     messages, no fabricated artifacts);
//   - resilience composition (the A6-FULL / PR #17 law): breaker INSIDE the
//     retry loop — every attempt is breaker-admitted, a breaker that opens
//     mid-sequence short-circuits the retries with the VERBATIM
//     ProviderUnavailableError, breaker-open refusals never reach the wire,
//     Retry-After is respected and capped by the bounded law;
//   - bounded polling: deadline AND max-attempt caps, throttle tolerance,
//     3-strikes, read-only breaker admission (a poll never records breaker
//     successes/failures and never starts while the breaker is open).
//
// Imported STATICALLY (last) by tests/index.mjs — runs in the aggregated
// `node --test tests/` gate. Env vars are snapshotted/restored per test and
// the 'dashscope' breaker box is reset around every test so sibling suites
// in the same process are unaffected.
// ═══════════════════════════════════════════════════════════════════════════
import { after, before, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  DEFAULT_DASHSCOPE_IMAGE_MODEL,
  DEFAULT_DASHSCOPE_VIDEO_MODEL,
  DashScopeProviderError,
  dashScopeConfig,
  dashScopeCreateImageTask,
  dashScopeCreateVideoTask,
  dashScopeFetchImageAsBase64,
  dashScopeGenerateImage,
  dashScopePollTask,
  parseRetryAfterMs,
  toDashScopeSize,
} from '../../apps/web/src/lib/you/ai/dashscope.ts';
import {
  renderCreateVideoTask,
  renderGenerateImage,
  renderProvider,
} from '../../apps/web/src/lib/you/ai/render-provider.ts';
import {
  MODEL_REGISTRY,
  RegistryResolutionError,
  resolveModel,
} from '../../apps/web/src/lib/you/ai/registry.ts';
import {
  ProviderUnavailableError,
  breakerSnapshot,
  resetBreaker,
  tripBreaker,
} from '../../apps/web/src/lib/you/core/circuit-breaker.ts';
import { resetMetricsForTests } from '../../apps/web/src/lib/you/core/metrics.ts';

const PLACEHOLDER_KEY = 'test-placeholder-key-never-real';
const IMAGE_PATH = '/api/v1/services/aigc/text2image/image-synthesis';
const VIDEO_PATH = '/api/v1/services/aigc/video-generation/video-synthesis';

// ─── env isolation (the modules read knobs per call) ─────────────────────────
const RENDER_ENV_KEYS = [
  'YOU_RENDER_PROVIDER',
  'DASHSCOPE_API_KEY',
  'YOU_DASHSCOPE_BASE_URL',
  'YOU_DASHSCOPE_IMAGE_MODEL',
  'YOU_DASHSCOPE_VIDEO_MODEL',
  'YOU_DASHSCOPE_TIMEOUT_MS',
  'YOU_DASHSCOPE_POLL_INTERVAL_MS',
  'YOU_DASHSCOPE_IMAGE_MAX_WAIT_MS',
  'YOU_DASHSCOPE_VIDEO_MAX_WAIT_MS',
  'YOU_AI_PROVIDERS',
  'YOU_AI_VISION_MODEL',
  'YOU_RETRY_MAX_ATTEMPTS',
  'YOU_RETRY_BASE_DELAY_MS',
  'YOU_RETRY_MAX_DELAY_MS',
  'YOU_RETRY_BUDGET_MS',
  'YOU_BREAKER_ENABLED',
  'YOU_BREAKER_FAILURE_THRESHOLD',
  'YOU_BREAKER_WINDOW_MS',
  'YOU_BREAKER_COOLDOWN_MS',
];
let envBackup = {};

function setEnv(vars) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ─── the local DashScope mock (API + OSS result host on one port) ───────────
const mock = {
  calls: [], // { method, url, auth, contentType, body }
  submitScript: [], // consumed per task-creation request: {status, headers, body, raw}
  pollScript: [], // consumed per GET /tasks/:id: string task_status OR {status, headers, body}
  resultScript: [], // consumed per GET /result: {status, headers, bytes}
  resultBytes: Buffer.from('mock-png-bytes-for-p6c2'),
  hangMs: 0, // artificial submit delay (timeout classification)
};

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

let mockServer = null;
let mockBase = '';

function startMock() {
  return new Promise((resolve) => {
    mockServer = http.createServer(async (req, res) => {
      const raw = await readBody(req);
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        /* non-JSON body kept as null (raw still recorded) */
      }
      mock.calls.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization || '',
        contentType: req.headers['content-type'] || '',
        body,
        raw,
      });

      if (req.method === 'POST' && (req.url === IMAGE_PATH || req.url === VIDEO_PATH)) {
        const step = mock.submitScript.length > 0 ? mock.submitScript.shift() : null;
        const status = step?.status ?? 200;
        const headers = { 'content-type': 'application/json', ...(step?.headers ?? {}) };
        if (mock.hangMs > 0) {
          await new Promise((r) => setTimeout(r, mock.hangMs));
        }
        if (step?.raw !== undefined) {
          res.writeHead(status, { 'content-type': 'text/plain' });
          res.end(step.raw);
          return;
        }
        const payload =
          step?.body ?? { output: { task_id: req.url === IMAGE_PATH ? 'img-task-1' : 'vid-task-1', task_status: 'PENDING' }, request_id: 'req-1' };
        res.writeHead(status, headers);
        res.end(JSON.stringify(payload));
        return;
      }

      const taskMatch = /^\/api\/v1\/tasks\/([^/?]+)/.exec(req.url);
      if (req.method === 'GET' && taskMatch) {
        const step = mock.pollScript.length > 0 ? mock.pollScript.shift() : 'SUCCEEDED';
        if (typeof step === 'string') {
          const output = { task_status: step };
          if (step === 'SUCCEEDED') {
            output.results = [{ url: `${mockBase}/result` }];
            output.video_url = `${mockBase}/result`;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ output, request_id: 'req-1', task_id: taskMatch[1] }));
          return;
        }
        res.writeHead(step.status ?? 200, { 'content-type': 'application/json', ...(step.headers ?? {}) });
        res.end(JSON.stringify(step.body ?? {}));
        return;
      }

      if (req.method === 'GET' && req.url === '/result') {
        const step = mock.resultScript.length > 0 ? mock.resultScript.shift() : null;
        const status = step?.status ?? 200;
        const bytes = step?.bytes ?? mock.resultBytes;
        res.writeHead(status, { 'content-type': 'image/png', ...(step?.headers ?? {}) });
        res.end(bytes);
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'NotFound', message: `no mock route for ${req.method} ${req.url}` }));
    });
    mockServer.listen(0, '127.0.0.1', () => {
      mockBase = `http://127.0.0.1:${mockServer.address().port}`;
      resolve();
    });
  });
}

// ─── deterministic clock + sleep (drives poll pacing and retry backoff) ─────
function makeClock() {
  let t = 1_000_000; // deterministic epoch base
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    advance: (ms) => {
      t += ms;
    },
  };
}

before(async () => {
  await startMock();
});

beforeEach(() => {
  envBackup = {};
  for (const k of RENDER_ENV_KEYS) {
    envBackup[k] = process.env[k];
    delete process.env[k];
  }
  setEnv({
    DASHSCOPE_API_KEY: PLACEHOLDER_KEY,
    YOU_DASHSCOPE_BASE_URL: mockBase,
  });
  mock.calls.length = 0;
  mock.submitScript.length = 0;
  mock.pollScript.length = 0;
  mock.resultScript.length = 0;
  mock.hangMs = 0;
  resetBreaker('dashscope');
});

afterEach(() => {
  setEnv(envBackup);
  envBackup = {};
  resetBreaker('dashscope');
  resetMetricsForTests();
});

after(async () => {
  await new Promise((r) => mockServer.close(r));
});

const submitCalls = () => mock.calls.filter((c) => c.url === IMAGE_PATH || c.url === VIDEO_PATH);
const pollCalls = () => mock.calls.filter((c) => /^\/api\/v1\/tasks\//.test(c.url));

// ═══════════════════════════════════════════════════════════════════════════
// render seam — provider selection (fail-closed)
// ═══════════════════════════════════════════════════════════════════════════

test('render seam: default and alias provider selection, fail-closed on unknown', () => {
  assert.equal(renderProvider(), 'station', 'unset → station (local z-ai SDK, unchanged default)');
  setEnv({ YOU_RENDER_PROVIDER: '' });
  assert.equal(renderProvider(), 'station');
  for (const v of ['station', 'local', 'zai', 'STATION', 'DashScope']) {
    setEnv({ YOU_RENDER_PROVIDER: v });
    assert.equal(renderProvider(), v.toLowerCase() === 'dashscope' ? 'dashscope' : 'station', `"${v}" accepted`);
  }
  setEnv({ YOU_RENDER_PROVIDER: 'azure' });
  assert.throws(
    () => renderProvider(),
    (e) => e instanceof Error && /YOU_RENDER_PROVIDER must be "station"/.test(e.message) && /refusing to guess/.test(e.message),
  );
});

test('render seam: registry defaults equal the seam-level defaults (the documented invariant)', () => {
  const img = resolveModel('image-gen', { provider: 'dashscope' });
  const vid = resolveModel('video-gen', { provider: 'dashscope' });
  assert.equal(img.modelId, DEFAULT_DASHSCOPE_IMAGE_MODEL);
  assert.equal(vid.modelId, DEFAULT_DASHSCOPE_VIDEO_MODEL);
  assert.ok(MODEL_REGISTRY.some((e) => e.provider === 'dashscope' && e.modelId === DEFAULT_DASHSCOPE_IMAGE_MODEL && e.defaultFor.includes('image-gen')));
  assert.ok(MODEL_REGISTRY.some((e) => e.provider === 'dashscope' && e.modelId === DEFAULT_DASHSCOPE_VIDEO_MODEL && e.defaultFor.includes('video-gen')));
});

test('render seam: dashscope image generation end-to-end through the seam (mock)', async () => {
  setEnv({ YOU_RENDER_PROVIDER: 'dashscope' });
  const clock = makeClock();
  const out = await renderGenerateImage('a stylized avatar portrait', '768x1344', { ...clock });
  assert.equal(out.provider, 'dashscope');
  assert.equal(out.model, DEFAULT_DASHSCOPE_IMAGE_MODEL, 'registry healthy default resolved');
  assert.equal(out.taskId, 'img-task-1');
  assert.equal(out.base64, mock.resultBytes.toString('base64'), 'result bytes fetched and base64-encoded');

  const submit = submitCalls()[0];
  assert.equal(submit.method, 'POST');
  assert.equal(submit.url, IMAGE_PATH);
  assert.equal(submit.auth, `Bearer ${PLACEHOLDER_KEY}`);
  assert.equal(submit.contentType, 'application/json');
  assert.equal(submit.body.model, DEFAULT_DASHSCOPE_IMAGE_MODEL);
  assert.equal(submit.body.input.prompt, 'a stylized avatar portrait');
  assert.equal(submit.body.parameters.size, '768*1344', "station 'WxH' normalized to DashScope 'W*H'");
  assert.equal(submit.body.parameters.n, 1);
});

test('render seam: YOU_AI_PROVIDERS pin beats the seam-level model knob', async () => {
  setEnv({
    YOU_RENDER_PROVIDER: 'dashscope',
    YOU_DASHSCOPE_IMAGE_MODEL: 'wanx-legacy-knob-model',
    YOU_AI_PROVIDERS: 'dashscope:wanx2.1-t2i-turbo',
  });
  const clock = makeClock();
  const out = await renderGenerateImage('p', '1024x1024', { ...clock });
  assert.equal(out.model, 'wanx2.1-t2i-turbo');
  assert.equal(submitCalls()[0].body.model, 'wanx2.1-t2i-turbo', 'the pin reached the wire');
});

test('render seam: the seam-level knob beats the registry default (but not a pin)', async () => {
  setEnv({ YOU_RENDER_PROVIDER: 'dashscope', YOU_DASHSCOPE_IMAGE_MODEL: 'wanx-legacy-knob-model' });
  const clock = makeClock();
  const out = await renderGenerateImage('p', '1024x1024', { ...clock });
  assert.equal(out.model, 'wanx-legacy-knob-model');
  assert.equal(submitCalls()[0].body.model, 'wanx-legacy-knob-model');
});

test('render seam: missing DASHSCOPE_API_KEY fails closed at resolution time (no wire call)', async () => {
  setEnv({ YOU_RENDER_PROVIDER: 'dashscope', DASHSCOPE_API_KEY: undefined });
  await assert.rejects(
    () => renderGenerateImage('p', '1024x1024'),
    (e) => e instanceof RegistryResolutionError && /requires DASHSCOPE_API_KEY/.test(e.message),
  );
  assert.equal(submitCalls().length, 0, 'no provider request was made without credentials');
});

test('render seam: video task maps station params honestly and records dropped knobs', async () => {
  setEnv({ YOU_RENDER_PROVIDER: 'dashscope' });
  const task = await renderCreateVideoTask(
    { prompt: 'a turntable portrait', image_url: 'data:image/png;base64,AAAA', quality: 'speed', duration: 5, fps: 30, with_audio: false },
    {},
  );
  assert.equal(task.provider, 'dashscope');
  assert.equal(task.model, DEFAULT_DASHSCOPE_VIDEO_MODEL);
  assert.equal(task.taskId, 'vid-task-1');
  assert.equal(task.status, 'PENDING', 'provider status verbatim');
  assert.deepEqual(task.droppedParams, ['quality', 'fps', 'with_audio'], 'station-only knobs recorded, not silently dropped');

  const submit = submitCalls()[0];
  assert.equal(submit.url, VIDEO_PATH);
  assert.equal(submit.body.model, DEFAULT_DASHSCOPE_VIDEO_MODEL);
  assert.equal(submit.body.input.prompt, 'a turntable portrait');
  assert.equal(submit.body.input.img_url, 'data:image/png;base64,AAAA');
  assert.equal(submit.body.parameters.duration, 5);
  assert.equal(submit.body.parameters.quality, undefined, 'quality is NOT expressible on the hosted contract');
  assert.equal(submit.body.parameters.fps, undefined);
  assert.equal(submit.body.parameters.with_audio, undefined);
});

// ═══════════════════════════════════════════════════════════════════════════
// DashScope adapter — config, size normalization, Retry-After parsing
// ═══════════════════════════════════════════════════════════════════════════

test('dashscope config: fail-closed without a key, knobs parsed, base URL trimmed', () => {
  setEnv({ DASHSCOPE_API_KEY: undefined });
  assert.throws(
    () => dashScopeConfig(),
    (e) => e instanceof DashScopeProviderError && e.failureKind === 'config' && /DASHSCOPE_API_KEY is not configured/.test(e.message),
  );
  setEnv({
    DASHSCOPE_API_KEY: PLACEHOLDER_KEY,
    YOU_DASHSCOPE_BASE_URL: `${mockBase}////`,
    YOU_DASHSCOPE_TIMEOUT_MS: 'not-a-number',
    YOU_DASHSCOPE_POLL_INTERVAL_MS: '250',
  });
  const cfg = dashScopeConfig();
  assert.equal(cfg.baseUrl, mockBase, 'trailing slashes trimmed');
  assert.equal(cfg.timeoutMs, 30000, 'invalid numbers fall back to the safe default');
  assert.equal(cfg.pollIntervalMs, 250);
  assert.equal(cfg.imageModel, DEFAULT_DASHSCOPE_IMAGE_MODEL);
  assert.equal(cfg.videoModel, DEFAULT_DASHSCOPE_VIDEO_MODEL);
});

test('dashscope helpers: size normalization is idempotent; Retry-After parses seconds and HTTP-dates', () => {
  assert.equal(toDashScopeSize('768x1344'), '768*1344');
  assert.equal(toDashScopeSize('1024*1024'), '1024*1024', 'already-normalized sizes pass through');
  assert.equal(toDashScopeSize(' 720x1440 '), '720*1440');
  assert.equal(toDashScopeSize('weird'), 'weird', 'non-WxH strings pass through verbatim');
  assert.equal(parseRetryAfterMs('2'), 2000);
  assert.equal(parseRetryAfterMs(null), undefined);
  assert.equal(parseRetryAfterMs('garbage'), undefined);
  const httpDate = new Date(Date.now() + 60_000).toUTCString();
  const parsed = parseRetryAfterMs(httpDate);
  assert.ok(typeof parsed === 'number' && parsed > 30_000 && parsed <= 60_000, `HTTP-date parsed to ~60s (got ${parsed})`);
});

// ═══════════════════════════════════════════════════════════════════════════
// DashScope adapter — request shapes + typed error classification (mock)
// ═══════════════════════════════════════════════════════════════════════════

test('dashscope adapter: image task request shape and handle parsing', async () => {
  const handle = await dashScopeCreateImageTask({ prompt: 'p', negativePrompt: 'blur', size: '864x1152', n: 1 });
  assert.equal(handle.taskId, 'img-task-1');
  assert.equal(handle.status, 'PENDING');
  assert.equal(handle.requestId, 'req-1');
  const submit = submitCalls()[0];
  assert.equal(submit.body.input.negative_prompt, 'blur');
  assert.equal(submit.body.parameters.size, '864*1152');
});

test('dashscope adapter: a response without task_id is an honest parse error', async () => {
  mock.submitScript = [{ status: 200, body: { output: {}, request_id: 'req-1' } }];
  await assert.rejects(
    () => dashScopeCreateImageTask({ prompt: 'p' }),
    (e) => e instanceof DashScopeProviderError && e.failureKind === 'parse' && /no task_id/.test(e.message),
  );
});

test('dashscope adapter: an unparseable provider body is a parse error, not a crash', async () => {
  mock.submitScript = [{ status: 200, raw: '<html>gateway error page</html>' }];
  await assert.rejects(
    () => dashScopeCreateImageTask({ prompt: 'p' }),
    (e) => e instanceof DashScopeProviderError && e.failureKind === 'parse',
  );
});

test('dashscope adapter: 401 is auth-classified, non-retryable, verbatim provider message, no retries', async () => {
  mock.submitScript = [{ status: 401, body: { code: 'InvalidApiKey', message: 'Invalid API key (mock)' } }];
  const clock = makeClock();
  await assert.rejects(
    () => dashScopeCreateImageTask({ prompt: 'p' }, { ...clock }),
    (e) =>
      e instanceof DashScopeProviderError &&
      e.failureKind === 'auth' &&
      e.status === 401 &&
      e.providerCode === 'InvalidApiKey' &&
      /Invalid API key \(mock\)/.test(e.message) &&
      !/\(after \d+ attempts\)/.test(e.message),
  );
  assert.equal(submitCalls().length, 1, 'non-retryable: exactly one wire call');
  assert.deepEqual(clock.sleeps, [], 'no backoff sleeps');
});

test('dashscope adapter: 403 with arrears code is quota-classified (billing, not auth), retried then honestly reported', async () => {
  mock.submitScript = [
    { status: 403, body: { code: 'ArrearsQuota', message: 'account in arrears' } },
    { status: 403, body: { code: 'ArrearsQuota', message: 'account in arrears' } },
    { status: 403, body: { code: 'ArrearsQuota', message: 'account in arrears' } },
  ];
  const clock = makeClock();
  await assert.rejects(
    () => dashScopeCreateImageTask({ prompt: 'p' }, { ...clock }),
    (e) =>
      e instanceof DashScopeProviderError &&
      e.failureKind === 'quota' &&
      e.providerCode === 'ArrearsQuota' &&
      /after 3 attempts/.test(e.message),
  );
  assert.equal(submitCalls().length, 3, 'quota-classified failures are retryable (they can clear)');
});

test('dashscope adapter: 429 is quota-classified with retryAfterMs surfaced for the engine', async () => {
  mock.submitScript = [
    { status: 429, headers: { 'retry-after': '1' }, body: { code: 'Throttling.RateQuota', message: 'Requests rate-limited' } },
    { status: 200, body: { output: { task_id: 'img-after-429', task_status: 'PENDING' } } },
  ];
  const clock = makeClock();
  const handle = await dashScopeCreateImageTask({ prompt: 'p' }, { ...clock });
  assert.equal(handle.taskId, 'img-after-429', 'throttling retried, then succeeded');
  assert.deepEqual(clock.sleeps, [1000], 'Retry-After: 1 honored verbatim by the engine');
});

// ═══════════════════════════════════════════════════════════════════════════
// resilience composition — breaker INSIDE the retry loop (PR #17 law)
// ═══════════════════════════════════════════════════════════════════════════

test('render resilience: transient 5xx retries to success and the breaker observes EVERY attempt', async () => {
  mock.submitScript = [
    { status: 500, body: { message: 'boom' } },
    { status: 502, body: { message: 'bad gateway' } },
    { status: 200, body: { output: { task_id: 'img-retried', task_status: 'PENDING' } } },
  ];
  const clock = makeClock();
  const handle = await dashScopeCreateImageTask({ prompt: 'p' }, { ...clock });
  assert.equal(handle.taskId, 'img-retried');
  assert.equal(submitCalls().length, 3);
  assert.equal(clock.sleeps.length, 2, 'one backoff sleep per retry');
  // breaker-INSIDE-retry: both failed attempts were recorded by the breaker
  const snap = breakerSnapshot().dashscope;
  assert.equal(snap.failureCount, 2, 'the breaker saw every failed attempt (not just the sequence)');
  assert.equal(snap.state, 'closed', 'below the threshold — still closed');
});

test('render resilience: Retry-After is respected verbatim but capped by the bounded law', async () => {
  setEnv({ YOU_RETRY_MAX_DELAY_MS: '250' });
  mock.submitScript = [
    { status: 429, headers: { 'retry-after': '3600' }, body: { code: 'Throttling.RateQuota', message: 'slow down' } },
    { status: 200, body: { output: { task_id: 'img-capped', task_status: 'PENDING' } } },
  ];
  const clock = makeClock();
  const handle = await dashScopeCreateImageTask({ prompt: 'p' }, { ...clock });
  assert.equal(handle.taskId, 'img-capped');
  assert.deepEqual(clock.sleeps, [250], 'a 1-hour Retry-After was capped to the 250ms ceiling — never a hang');
});

test('render resilience: a breaker that opens MID-RETRY short-circuits with the verbatim typed error', async () => {
  setEnv({ YOU_BREAKER_FAILURE_THRESHOLD: '2', YOU_BREAKER_WINDOW_MS: '60000', YOU_BREAKER_COOLDOWN_MS: '30000' });
  mock.submitScript = [
    { status: 500, body: { message: 'down 1' } },
    { status: 500, body: { message: 'down 2' } },
    { status: 500, body: { message: 'down 3 — must NOT be reached' } },
  ];
  const clock = makeClock();
  await assert.rejects(
    () => dashScopeCreateImageTask({ prompt: 'p' }, { ...clock }),
    (e) => e instanceof ProviderUnavailableError && e.code === 'provider_unavailable' && e.breakerState === 'open',
  );
  assert.equal(submitCalls().length, 2, 'the third retry attempt was refused by the OPEN breaker — no wire call');
  assert.equal(breakerSnapshot().dashscope.state, 'open');
});

test('render resilience: an already-open breaker fails fast without touching the wire', async () => {
  tripBreaker('dashscope', 'tripped by the test');
  await assert.rejects(
    () => dashScopeCreateImageTask({ prompt: 'p' }),
    (e) =>
      e instanceof ProviderUnavailableError &&
      e.code === 'provider_unavailable' &&
      e.breakerState === 'open' &&
      /cooldown has not elapsed/.test(e.message),
  );
  assert.equal(submitCalls().length, 0);
  assert.equal(breakerSnapshot().dashscope.openedReason, 'tripped by the test', 'the trip reason stays visible to operators');
});

test('render resilience: per-call timeout is honest (AbortError → timeout failureKind, retried, then reported)', async () => {
  setEnv({ YOU_DASHSCOPE_TIMEOUT_MS: '80' });
  mock.hangMs = 400; // the mock stalls longer than the per-call timeout
  const clock = makeClock();
  await assert.rejects(
    () => dashScopeCreateImageTask({ prompt: 'p' }, { ...clock }),
    (e) => e instanceof DashScopeProviderError && e.failureKind === 'timeout' && /no response within 80ms/.test(e.message),
  );
  assert.ok(submitCalls().length >= 2, 'timeouts are retryable — the engine retried before reporting');
  mock.hangMs = 0;
});

// ═══════════════════════════════════════════════════════════════════════════
// bounded polling — deadline AND attempt caps, read-only breaker admission
// ═══════════════════════════════════════════════════════════════════════════

test('render poll: bounded loop reaches SUCCEEDED with honest timing and NO breaker mutation', async () => {
  mock.pollScript = ['PENDING', 'RUNNING', 'SUCCEEDED'];
  const clock = makeClock();
  const out = await dashScopePollTask('img-task-1', { ...clock, maxWaitMs: 60_000, pollIntervalMs: 5_000 });
  assert.equal(out.status, 'succeeded');
  assert.equal(out.url, `${mockBase}/result`);
  assert.equal(out.attempts, 3);
  assert.equal(out.waitedMs, 10_000, 'two 5s poll intervals — real, measured by the injectable clock');
  assert.equal(out.lastProviderStatus, 'SUCCEEDED');
  // read-only admission: the poll never records breaker outcomes
  const snap = breakerSnapshot().dashscope;
  assert.equal(snap.successCount, 0, 'a poll is not a breaker success');
  assert.equal(snap.failureCount, 0, 'per-poll hiccups do not trip the API breaker');
  assert.equal(pollCalls().length, 3);
});

test('render poll: deadline exhaustion is an honest timeout, never an infinite loop', async () => {
  mock.pollScript = new Array(50).fill('PENDING');
  const clock = makeClock();
  const out = await dashScopePollTask('img-task-1', { ...clock, maxWaitMs: 12_000, pollIntervalMs: 5_000 });
  assert.equal(out.status, 'timeout');
  assert.equal(out.url, null);
  assert.equal(out.attempts, 3, 'ceil(12s/5s) — the derived attempt cap equals the deadline');
});

test('render poll: the max-attempt cap binds even when the deadline is far away', async () => {
  mock.pollScript = new Array(50).fill('PENDING');
  const clock = makeClock();
  const out = await dashScopePollTask('img-task-1', { ...clock, maxWaitMs: 600_000, pollIntervalMs: 5_000, maxAttempts: 2 });
  assert.equal(out.status, 'timeout');
  assert.equal(out.attempts, 2);
});

test('render poll: terminal provider failure is reported verbatim (no fabricated artifact)', async () => {
  mock.pollScript = ['RUNNING', 'FAILED'];
  const clock = makeClock();
  const out = await dashScopePollTask('vid-task-1', { ...clock });
  assert.equal(out.status, 'failed');
  assert.equal(out.url, null);
  assert.equal(out.lastProviderStatus, 'FAILED');
});

test('render poll: throttled polls are tolerated until the deadline; other errors get 3 strikes', async () => {
  mock.pollScript = [
    { status: 429, headers: { 'retry-after': '1' }, body: { code: 'Throttling.RateQuota', message: 'slow down' } },
    'PENDING',
    'SUCCEEDED',
  ];
  const clock = makeClock();
  const out = await dashScopePollTask('vid-task-1', { ...clock, maxWaitMs: 120_000, pollIntervalMs: 5_000 });
  assert.equal(out.status, 'succeeded', 'a single throttle did not kill the poll');
  assert.equal(out.attempts, 3);

  mock.pollScript = [
    { status: 500, body: { message: 'poll blew up 1' } },
    { status: 500, body: { message: 'poll blew up 2' } },
    { status: 500, body: { message: 'poll blew up 3' } },
    'SUCCEEDED', // must NOT be reached
  ];
  const clock2 = makeClock();
  await assert.rejects(
    () => dashScopePollTask('vid-task-1', { ...clock2, maxWaitMs: 120_000 }),
    (e) => e instanceof DashScopeProviderError && e.operation === 'poll' && /poll blew up 3/.test(e.message),
  );
});

test('render poll: read-only admission refuses to START while the breaker is open', async () => {
  tripBreaker('dashscope', 'provider down');
  await assert.rejects(
    () => dashScopePollTask('vid-task-1', { ...makeClock() }),
    (e) => e instanceof ProviderUnavailableError,
  );
  assert.equal(pollCalls().length, 0, 'no poll request while the breaker refuses admission');
});

// ═══════════════════════════════════════════════════════════════════════════
// image generation end-to-end — honest outcomes only
// ═══════════════════════════════════════════════════════════════════════════

test('dashscope image: submit → poll → fetch lands the real bytes with an audit trail', async () => {
  mock.pollScript = ['PENDING', 'SUCCEEDED'];
  const clock = makeClock();
  const out = await dashScopeGenerateImage('a stylized avatar portrait', '768x1344', { ...clock, maxWaitMs: 60_000 });
  assert.equal(out.base64, mock.resultBytes.toString('base64'));
  assert.equal(out.bytes, mock.resultBytes.length);
  assert.equal(out.mime, 'image/png');
  assert.equal(out.model, DEFAULT_DASHSCOPE_IMAGE_MODEL);
  assert.equal(out.taskId, 'img-task-1');
  assert.equal(out.waitedMs, 5_000);
  assert.equal(out.latencyMs, 5_000, 'end-to-end latency includes the real poll wait');
});

test('dashscope image: poll timeout is an honest typed error — no artifact fabricated', async () => {
  mock.pollScript = new Array(50).fill('PENDING');
  const clock = makeClock();
  await assert.rejects(
    () => dashScopeGenerateImage('p', '1024x1024', { ...clock, maxWaitMs: 11_000, pollIntervalMs: 5_000 }),
    (e) =>
      e instanceof DashScopeProviderError &&
      e.failureKind === 'timeout' &&
      /img-task-1 did not finish within 11000ms/.test(e.message) &&
      /no artifact fabricated/.test(e.message),
  );
});

test('dashscope image: terminal task failure is an honest typed error', async () => {
  mock.pollScript = ['FAILED'];
  const clock = makeClock();
  await assert.rejects(
    () => dashScopeGenerateImage('p', '1024x1024', { ...clock }),
    (e) => e instanceof DashScopeProviderError && e.failureKind === 'task' && /terminal status FAILED/.test(e.message),
  );
});

test('dashscope image: SUCCEEDED with no result URL is an honest parse error', async () => {
  mock.pollScript = [{ status: 200, body: { output: { task_status: 'SUCCEEDED' } } }];
  const clock = makeClock();
  await assert.rejects(
    () => dashScopeGenerateImage('p', '1024x1024', { ...clock }),
    (e) => e instanceof DashScopeProviderError && e.failureKind === 'parse' && /no result URL/.test(e.message),
  );
});

test('dashscope image: the OSS result fetch retries transient failures (bounded, no API breaker)', async () => {
  mock.resultScript = [
    { status: 500 },
    { status: 200, bytes: Buffer.from('recovered-result-bytes') },
  ];
  const clock = makeClock();
  const out = await dashScopeFetchImageAsBase64(`${mockBase}/result`, { ...clock });
  assert.equal(out.base64, Buffer.from('recovered-result-bytes').toString('base64'));
  assert.equal(out.bytes, 'recovered-result-bytes'.length);
  // the result host is NOT the API endpoint — the dashscope breaker stays untouched
  const snap = breakerSnapshot().dashscope;
  assert.equal(snap.successCount, 0);
  assert.equal(snap.failureCount, 0);
});

test('dashscope image: a permanently failing result download reports the honest HTTP error', async () => {
  mock.resultScript = new Array(6).fill({ status: 404 });
  const clock = makeClock();
  await assert.rejects(
    () => dashScopeFetchImageAsBase64(`${mockBase}/result`, { ...clock }),
    (e) => e instanceof DashScopeProviderError && /result download HTTP 404/.test(e.message),
  );
});
