// ═══════════════════════════════════════════════════════════════════════════
// YOU fresh-browser driver (P6.B10) — a ZERO-DEPENDENCY CDP driver over Node's
// built-in WebSocket (Node ≥ 22; the repo's node:test law: no test deps).
//
// WHAT THIS IS: Playwright-style automation against a REAL Chromium binary —
// launch, navigate, evaluate, click, fill, and capture console/exception
// errors — implemented directly over the Chrome DevTools Protocol so the
// suite stays dependency-free and CI-portable (documented in docs/E2E.md).
//
// FRESH-CONTEXT LAW: every `openFreshContext()` launches a BRAND-NEW browser
// PROCESS with a BRAND-NEW --user-data-dir. No cookies, no localStorage, no
// session carry-over is possible between flows: the acceptance under test is
// that a pristine browser reaches the working hosted product, bootstrap
// included. A document-start snapshot (cookie + localStorage length, taken
// BEFORE any app script runs, via Page.addScriptToEvaluateOnNewDocument)
// proves the context was empty — no timing race, no heuristics.
//
// TEARDOWN LAW: Chromium is spawned DETACHED (own process group) so close()
// can SIGKILL the ENTIRE tree — renderer, gpu, utility and crashpad children
// included. A module-level registry lets the suite's after() hook sweep any
// survivor; a leaked browser would otherwise starve later flows (observed
// live: orphaned renderers exhaust the 4 GB station and cascade EAGAIN
// spawn failures into every subsequent flow).
//
// HONEST SKIP GUARD: `findBrowserBinary()` searches the documented locations
// (YOU_E2E_BROWSER override → Playwright's browsers path → system Chromium).
// When NO binary exists anywhere the suite SKIPS with a loud reason (never a
// silent pass, never a fake green) — see docs/E2E.md §Skip guard.
// ═══════════════════════════════════════════════════════════════════════════
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// every live browser process group (pid → userDataDir); swept by
// killAllStrayBrowsers() so nothing outlives the suite
const liveBrowsers = new Map();

// ─── browser binary discovery ───────────────────────────────────────────────

function candidatesFromPlaywrightCache(root) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(root); } catch { return out; }
  // chromium-<rev>/chrome-linux*/chrome (Playwright ≥ 1.5x layout uses
  // chrome-linux64 on some archs, chrome-linux on others — glob both) and
  // chromium_headless_shell-<rev>/chrome-headless-shell-linux*/chrome-headless-shell
  const chromiumDirs = entries.filter((e) => /^chromium-\d+$/.test(e)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  const shellDirs = entries.filter((e) => /^chromium_headless_shell-\d+$/.test(e)).sort((a, b) => Number(b.slice(22)) - Number(a.slice(22)));
  for (const dir of [...chromiumDirs, ...shellDirs]) {
    const dirPath = path.join(root, dir);
    let subdirs = [];
    try { subdirs = fs.readdirSync(dirPath, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
    for (const sub of subdirs) {
      for (const exe of ['chrome', 'chrome-headless-shell']) {
        const p = path.join(dirPath, sub, exe);
        try { fs.accessSync(p, fs.constants.X_OK); out.push(p); } catch { /* not present */ }
      }
    }
  }
  return out;
}

const SYSTEM_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

/**
 * Find a real Chromium-family binary. Search order:
 *   1. $YOU_E2E_BROWSER — explicit operator override (must be executable)
 *   2. the Playwright browsers cache ($PLAYWRIGHT_BROWSERS_PATH, else
 *      ~/.cache/ms-playwright) — full chromium first (newest revision
 *      first), then headless shells
 *   3. common system install locations
 * Returns { path, source } or null when no browser exists anywhere.
 */
export function findBrowserBinary() {
  const override = process.env.YOU_E2E_BROWSER?.trim();
  if (override) {
    try { fs.accessSync(override, fs.constants.X_OK); return { path: override, source: 'YOU_E2E_BROWSER' }; } catch {
      throw new Error(`YOU_E2E_BROWSER="${override}" is not an executable browser binary`);
    }
  }
  const cacheRoot = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() || path.join(os.homedir(), '.cache', 'ms-playwright');
  for (const p of candidatesFromPlaywrightCache(cacheRoot)) return { path: p, source: `playwright cache (${cacheRoot})` };
  for (const p of SYSTEM_CANDIDATES) {
    try { fs.accessSync(p, fs.constants.X_OK); return { path: p, source: 'system' }; } catch { /* keep looking */ }
  }
  return null;
}

/** Kill every browser tree this driver launched (the after() sweep). */
export function killAllStrayBrowsers() {
  for (const [pid] of liveBrowsers) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    liveBrowsers.delete(pid);
  }
}

// ─── CDP connection (Node's built-in WebSocket — RFC6455, text frames) ─────

class CdpSocket {
  constructor(ws) { this.ws = ws; this.nextId = 1; this.pending = new Map(); this.handlers = new Map(); this.closed = false; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP WebSocket connect timeout: ${url}`)), 15000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`CDP WebSocket error connecting: ${url}`)); }, { once: true });
    });
    const sock = new CdpSocket(ws);
    ws.addEventListener('message', (ev) => sock._onMessage(ev.data));
    ws.addEventListener('close', () => {
      sock.closed = true;
      for (const { reject } of sock.pending.values()) reject(new Error('CDP socket closed'));
      sock.pending.clear();
    });
    return sock;
  }
  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP ${msg.error.message ?? JSON.stringify(msg.error)}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method && this.handlers.has(msg.method)) {
      for (const h of this.handlers.get(msg.method)) h(msg.params ?? {});
    }
  }
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP socket closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP command timeout: ${method}`));
        }
      }, 30000).unref();
    });
  }
  close() {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

// ─── browser process + page session ────────────────────────────────────────

// Runs in EVERY new document BEFORE any app script (Page.addScriptToEvaluate
// onNewDocument). Jobs:
//   1. the fresh-context snapshot: document-start cookie + localStorage
//      length, read before the app could possibly write either — the
//      deterministic proof each flow starts from a pristine context;
//   2. the window.onerror capture the acceptance asserts is EMPTY — plus
//      'unhandledrejection' events (same net);
//   3. an in-page fetch recorder (method, url, status) — diagnostic truth on
//      any waitFor timeout, and real evidence for the bootstrap assertion.
const NEW_DOCUMENT_HOOK = `
(() => {
  try {
    window.__youFresh = { cookie: document.cookie, storageKeys: localStorage.length };
  } catch (e) {
    window.__youFresh = { cookie: 'unreadable', storageKeys: -1, error: String(e) };
  }
  window.__youErrors = [];
  window.onerror = function (message) { window.__youErrors.push(String(message)); return false; };
  window.addEventListener('error', (e) => {
    window.__youErrors.push(String((e && e.message) || 'error event'));
  });
  window.addEventListener('unhandledrejection', (e) => {
    window.__youErrors.push('unhandledrejection: ' + String((e && e.reason) || ''));
  });
  window.__youNet = [];
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = String((args[0] instanceof Request) ? args[0].url : args[0]);
    const method = (args[0] instanceof Request) ? args[0].method : ((args[1] && args[1].method) || 'GET');
    const entry = { method: String(method).toUpperCase(), url, status: null };
    if (window.__youNet.length > 200) window.__youNet.shift();
    window.__youNet.push(entry);
    return origFetch.apply(this, args).then((res) => {
      entry.status = res.status;
      return res;
    }, (err) => {
      entry.status = 'network-error';
      throw err;
    });
  };
})();
`;

export class Browser {
  constructor(proc, httpBase, browserSock, userDataDir) {
    this.proc = proc;
    this.httpBase = httpBase; // http://127.0.0.1:<devtools-port>
    this.sock = browserSock;
    this.userDataDir = userDataDir;
    this.pages = [];
    liveBrowsers.set(proc.pid, userDataDir);
    proc.once('exit', () => liveBrowsers.delete(proc.pid));
  }

  /** Create a NEW page target and return a connected Page session. */
  async newPage() {
    const { targetId } = await this.sock.send('Target.createTarget', { url: 'about:blank' });
    let pageWsUrl = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const list = await (await fetch(`${this.httpBase}/json/list`)).json();
      const target = list.find((t) => t.id === targetId && t.type === 'page');
      if (target?.webSocketDebuggerUrl) { pageWsUrl = target.webSocketDebuggerUrl; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!pageWsUrl) throw new Error('could not resolve the new page target WebSocket URL');
    const page = await Page.connect(pageWsUrl);
    this.pages.push(page);
    return page;
  }

  /**
   * Deterministic teardown: close page sockets (open WebSockets would keep
   * the runner's event loop alive), ask Chromium to exit, then SIGKILL the
   * ENTIRE process group (detached spawn → own group; renderer/gpu/utility
   * children die with it — no orphans, no resource starvation of later
   * flows), then drop the throw-away profile directory.
   */
  async close() {
    for (const p of this.pages) p.close();
    this.pages.length = 0;
    try { await this.sock.send('Browser.close'); } catch { /* fall through to the kill */ }
    this.sock.close();
    if (this.proc.exitCode === null && this.proc.signalCode === null) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        this.proc.once('exit', finish);
        try { process.kill(-this.proc.pid, 'SIGTERM'); } catch { /* already gone */ }
        setTimeout(() => {
          try { process.kill(-this.proc.pid, 'SIGKILL'); } catch { /* already gone */ }
          setTimeout(finish, 500);
        }, 3000).unref();
        setTimeout(finish, 6000).unref();
      });
    }
    try { fs.rmSync(this.userDataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

export class Page {
  constructor(sock) {
    this.sock = sock;
    this.consoleErrors = []; // console.error calls from the page
    this.exceptions = [];   // Runtime.exceptionThrown (uncaught)
    this.networkFailures = []; // resource loading failures (fetch/XHR/asset)
    this.sock.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') {
        const text = (p.args ?? []).map((a) => a.value ?? a.description ?? a.type ?? '').join(' ');
        this.consoleErrors.push(text);
      }
    });
    this.sock.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails ?? {};
      this.exceptions.push(`${d.text ?? 'exception'} ${d.exception?.description ?? ''}`.trim());
    });
    this.sock.on('Network.loadingFailed', (p) => {
      this.networkFailures.push(`${p.errorText ?? 'loading failed'} (blocked=${p.blockedReason ?? 'no'})`);
    });
  }

  static async connect(wsUrl) {
    const sock = await CdpSocket.connect(wsUrl);
    const page = new Page(sock);
    await sock.send('Runtime.enable');
    await sock.send('Page.enable');
    await sock.send('Network.enable');
    await sock.send('Log.enable');
    await sock.send('Page.addScriptToEvaluateOnNewDocument', { source: NEW_DOCUMENT_HOOK });
    return page;
  }

  /**
   * Evaluate an expression (an IIFE body is fine); resolves awaited
   * promises; returns the JSON value. Throws loudly on CDP-level
   * exceptions with the exception text — never fabricates a result.
   */
  async evaluate(expression) {
    const r = await this.sock.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page evaluation threw: ${d.text ?? ''} ${d.exception?.description ?? ''}`.trim());
    }
    return r.result?.value;
  }

  /**
   * Navigate and wait for the NEW document to reach readyState=interactive.
   * The location.href conjunct is load-bearing: until the new document
   * commits, evaluate runs against the OLD page (about:blank, readyState
   * 'complete') — without it goto would return before navigation begins.
   */
  async goto(url, timeoutMs = 180000) {
    await this.sock.send('Page.navigate', { url });
    const t0 = Date.now();
    for (;;) {
      const state = await this.evaluate('location.href + " " + document.readyState').catch(() => null);
      const [href, ready] = typeof state === 'string' ? state.split(' ') : [];
      if (href && href !== 'about:blank' && href.startsWith(url) && (ready === 'complete' || ready === 'interactive')) {
        return;
      }
      if (Date.now() - t0 > timeoutMs) throw new Error(`page did not reach readyState=interactive at ${url} within ${timeoutMs}ms (last: ${JSON.stringify(state)})`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  /**
   * Poll until `expression` (an IIFE returning a JSON value) is truthy.
   * Evaluation ERRORS never count as success (a broken expression must not
   * fake a green) — they are recorded and surfaced at the timeout.
   * Fails LOUDLY with the label, an excerpt of the body text, recent
   * in-page network calls and the error capture — real diagnostics, never
   * a bare timeout.
   */
  async waitFor(label, expression, timeoutMs = 60000) {
    const t0 = Date.now();
    let last = null;
    let lastError = null;
    for (;;) {
      try {
        last = await this.evaluate(expression);
        lastError = null;
        if (last) return last;
      } catch (e) {
        last = null;
        lastError = e.message;
      }
      if (Date.now() - t0 > timeoutMs) {
        const diag = await this.evaluate(`(() => {
          const body = document.body ? document.body.innerText.slice(0, 1200) : '(no body)';
          const net = (window.__youNet ?? []).slice(-12).map((e) => e.method + ' ' + e.url.split('/api/').pop() + ' -> ' + e.status);
          const errs = (window.__youErrors ?? []).slice(0, 5);
          return { body, net, errs };
        })()`).catch(() => null);
        const net = diag?.net ? `\nrecent requests: ${JSON.stringify(diag.net)}` : '';
        const errs = diag?.errs?.length ? `\npage errors so far: ${JSON.stringify(diag.errs)}` : '';
        const evalErr = lastError ? `\nlast evaluation error: ${lastError}` : '';
        throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms — last value: ${JSON.stringify(last)}${evalErr}${net}${errs}\nbody excerpt: ${diag?.body ?? '(unavailable)'}`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  /**
   * Click a button-ish element. Exact trimmed text match wins over substring.
   * The FULL pointer/mouse sequence is dispatched (pointerdown → mousedown →
   * pointerup → mouseup → click), not a bare el.click(): Radix components
   * (Tabs.Trigger, Select triggers) activate on pointer events, and a
   * synthetic click alone leaves them inert (observed live — the Quality
   * tab never switched). The sequence is a strict superset of plain click
   * semantics for every regular button.
   */
  async click({ text, ariaLabel, scope } = {}) {
    const expr = `(() => {
      const root = ${scope ? `document.querySelector(${JSON.stringify(scope)})` : 'document'};
      if (!root) return 'scope-not-found';
      const sel = 'button, [role="button"], [role="tab"], a[href], [role="menuitem"]';
      const els = [...root.querySelectorAll(sel)];
      let el = null;
      if (${JSON.stringify(ariaLabel ?? null)} !== null) {
        el = els.find((e) => (e.getAttribute('aria-label') || '').includes(${JSON.stringify(ariaLabel)}));
      } else {
        const want = ${JSON.stringify(text ?? '')};
        el = els.find((e) => (e.textContent || '').trim() === want)
          ?? els.find((e) => (e.textContent || '').replace(/\\s+/g, ' ').includes(want));
      }
      if (!el) return 'not-found';
      if (el.disabled) return 'disabled';
      el.scrollIntoView({ block: 'center' });
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return 'clicked';
    })()`;
    const r = await this.evaluate(expr);
    if (r !== 'clicked') {
      const body = await this.evaluate('document.body ? document.body.innerText.slice(0, 400) : ""').catch(() => '');
      throw new Error(`click(${JSON.stringify({ text, ariaLabel, scope })}) → ${r}\nbody excerpt: ${body}`);
    }
    return true;
  }

  /** Fill a controlled React input/textarea (native setter + input event). */
  async fill(selector, value) {
    const r = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'not-found';
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'filled';
    })()`);
    if (r !== 'filled') throw new Error(`fill(${selector}) → ${r}`);
    return true;
  }

  /** Visible page text (innerText) — for substring assertions. */
  async text() {
    return this.evaluate('document.body ? document.body.innerText : ""');
  }

  /**
   * The error capture the acceptance asserts EMPTY: window.onerror events
   * (+unhandledrejection), page console.error calls, uncaught exceptions,
   * and network loading failures.
   */
  async errors() {
    const uncaught = await this.evaluate('window.__youErrors ?? ["(error hook missing)"]');
    return { uncaught, consoleErrors: this.consoleErrors, exceptions: this.exceptions, networkFailures: this.networkFailures };
  }

  async assertNoPageErrors(label) {
    const { uncaught, consoleErrors, exceptions, networkFailures } = await this.errors();
    const all = [
      ...uncaught.map((e) => `window.onerror: ${e}`),
      ...consoleErrors.map((e) => `console.error: ${e}`),
      ...exceptions.map((e) => `exception: ${e}`),
      ...networkFailures.map((e) => `network: ${e}`),
    ];
    if (all.length > 0) {
      throw new Error(`${label}: the fresh-browser error capture is NOT empty (${all.length}):\n  - ${all.slice(0, 12).join('\n  - ')}`);
    }
    return true;
  }

  /** The document-start fresh-context snapshot (cookie/localStorage BEFORE app JS). */
  async freshSnapshot() {
    return this.evaluate('window.__youFresh ?? null');
  }

  /** The in-page fetch log (method, url, status) — real request truth. */
  async netLog() {
    return this.evaluate('window.__youNet ?? []');
  }

  close() { this.sock.close(); }
}

/**
 * Launch a FRESH browser context: a new Chromium process (own process
 * group — see the teardown law above) with a new throw-away profile.
 * Returns { browser, page } ready to navigate.
 */
export async function openFreshContext(binaryPath) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'you-e2e-profile-'));
  const isHeadlessShell = /chrome-headless-shell/.test(binaryPath);
  const args = [
    ...(isHeadlessShell ? [] : ['--headless=new']),
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-crash-reporter',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,800',
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    'about:blank',
  ];
  const proc = spawn(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });

  // the DevTools endpoint is announced on stderr: "DevTools listening on ws://…"
  let stderrTail = '';
  const wsAnnounced = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chromium never announced its DevTools endpoint:\n${stderrTail.slice(-800)}`)), 30000);
    proc.stderr.on('data', (chunk) => {
      stderrTail += chunk.toString();
      const m = stderrTail.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f-]+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chromium exited early (code ${code}):\n${stderrTail.slice(-800)}`)); });
  });
  const browserWsUrl = await wsAnnounced;
  const port = Number(browserWsUrl.match(/127\.0\.0\.1:(\d+)/)[1]);
  const sock = await CdpSocket.connect(browserWsUrl);
  const browser = new Browser(proc, `http://127.0.0.1:${port}`, sock, userDataDir);
  const page = await browser.newPage();
  return { browser, page };
}
