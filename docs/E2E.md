# E2E — the fresh-browser suite (P6.B10)

The acceptance chain (docs/TL_HANDOFF.md) ends with the **fresh-browser hosted
proof**: the product must work in a *pristine* browser context — not just over
HTTP. `tests/e2e/` is that leg. It drives a **real Chromium binary** through
the hosted Studio UI and asserts visible DOM state, exactly like a human
operator would see it.

## Run

```bash
# prerequisites (the documented app boot — same as the contract suites)
cd apps/web && bun install && cp .env.example .env && bun run db:push

# from the repo root — the e2e gate
node --test tests/e2e/
# (equivalently: pnpm test:e2e — the root script)
```

The suite boots its own `next dev` on a free 127.0.0.1 port (the same server
lifecycle law as the contract suites) and tears it down afterwards. Set
`YOU_TEST_BASE=http://127.0.0.1:<port>` to reuse an already-booted server.

**App boot choice:** `next dev`, not `build+start` — the same choice the
contract suites make. Rationale: one documented boot path for the whole test
estate, no standalone-build copy step in the loop, and dev-vs-prod rendering
differences are not what this suite is about (the hosted production build is
exercised by the F9 deployment checklist). If a production-mode pass is ever
wanted, run the same suite with `YOU_TEST_BASE` pointed at a `next start`
server.

## What is covered (the six flows)

Every flow starts from a **brand-new browser process with a brand-new profile**
(see *Fresh-context proof* below) and ends with the page-error capture asserted
EMPTY (window.onerror events, uncaught exceptions, `console.error` calls,
network loading failures).

| Flow | Asserted in the DOM |
|---|---|
| **(a) bootstrap session** | a pristine browser (no cookies, no localStorage — proven at document start) loads `/`, the app bootstraps the demo session through its own client, and renders **authenticated**: sidebar identity ("Studio Founder"), tenant ("YOU Demo Studio"), the Overview landing surface, and the `you_session` cookie issued in that fresh context. |
| **(b) create twin → capture** | the full consent-gate state machine, each state server-enforced: the gate dialog opens on create; refusing leaves the honest blocked callout ("Capture is consent-gated."); granting unblocks the capture toolbar; the **guided F1 capture** refuses the plain grant and surfaces the six-statement consent gate (with the server's machine-readable `missing/invalid:` list); recording it starts the guided flow — the 8-step protocol renders with real progress state ("0/8 steps done"). |
| **(c) evidence requests** | a REAL request seeded through the canonical API (`POST /api/v1/evidence-requests`) renders in the Evidence Requests view (capability, reason, status). |
| **(d) deficiency map** | on a real twin (seeded via the API), the Quality tab renders the deficiency map's **honest empty state** — "No capture evidence yet … every capability is unknown — by honesty law, never shown as ok" — and the suite asserts no fabricated capability summary or "ok" badges appear. |
| **(e) artifact view** | a REAL `performance-review` Solution Artifact is created through the durable-job pipeline (`POST /api/v1/performances/from-text` → poll to `succeeded`), then opened **through the UI** (Performances → row → Solution Artifacts → artifact). The view renders the P5 section surface: the "Section completeness" card, the Evidence/Improve/Feedback/Provenance/API/Performance tabs each rendering their honest filled-or-empty content (e.g. "No evidence referenced", the curl snippets with the real artifact id). |
| **(f) navigation sweep** | every primary sidebar view (all 15) navigates and renders: the active item is marked (`aria-current="page"`), the view's header appears in the main column, no blank views, no dead links — and the error capture stays empty across the whole sweep. |

## Deliberately NOT covered (honest scoping)

- **Real provider renders** — image/video generation, avatar embodiment,
  hosted try-on. Those legs consume provider spend and are covered by the
  contract suites over HTTP (`tests/contract/ai-render.test.mjs`,
  `compute-broker-e2e.test.mjs`, `try-on.test.mjs`, `avatar-ux.test.mjs`).
  The browser suite proves the *hosted product surfaces*, not provider spend.
- **The populated deficiency map / compiled TwinVersion surfaces** — these
  require the full real-provider capture→compile chain (capture.quality +
  twin.compile vision calls). The honest empty state is what a fresh browser
  reaches deterministically; the populated states are contract-proven over
  HTTP (`deficiency-viz`, `artifact-completion` suites). Asserting them here
  would couple the browser gate to provider availability.
- **Multi-tenant / auth-wall negatives** — server-enforced and contract-proven
  (`verification-flow`, `hardening` suites). The browser suite exercises the
  authenticated demo path a hosted fresh browser actually travels.
- **Visual regression / pixel snapshots** — the suite asserts DOM truth, not
  rendering aesthetics.

## The browser harness (design notes)

- **A real browser binary, driven over CDP.** The suite launches
  Chromium headless (`--headless=new`) and drives it over the Chrome DevTools
  Protocol using Node's built-in `WebSocket` — **zero new dependencies**, in
  line with the repo's node:test/no-dep test law. "Playwright-style"
  automation (navigate / click / fill / waitFor / console capture) is
  implemented directly, so the suite stays CI-portable and does not add a
  browser-driver package to the lockfile.
- **Binary discovery** (`tests/e2e/browser.mjs`): `$YOU_E2E_BROWSER` (explicit
  override) → the Playwright browsers cache (`$PLAYWRIGHT_BROWSERS_PATH`, else
  `~/.cache/ms-playwright` — full `chromium-<rev>` first, then
  `chromium_headless_shell-<rev>`) → common system locations
  (`/usr/bin/chromium`, `/usr/bin/google-chrome`, …).
- **Fresh-context proof:** each flow gets a **new browser process** with a new
  throw-away `--user-data-dir`. Emptiness is proven deterministically: a
  document-start script (`Page.addScriptToEvaluateOnNewDocument`) snapshots
  `document.cookie` and `localStorage.length` **before any app script runs** —
  no timing race — and the suite asserts the snapshot is empty at the start of
  every flow.
- **Error capture:** the same document-start hook installs the
  `window.onerror` / `unhandledrejection` collectors; the driver additionally
  records `console.error` calls (`Runtime.consoleAPICalled`), uncaught
  exceptions (`Runtime.exceptionThrown`) and network loading failures
  (`Network.loadingFailed`). Every flow ends with `assertNoPageErrors`.
- **The browser-origin law (a real finding):** Next 16's dev server blocks
  `/_next/hmr` from origins it treats as cross-origin — `127.0.0.1` is one
  of them ("Blocked cross-origin request to Next.js dev resource /_next/hmr
  from 127.0.0.1"). Without the HMR WebSocket the dev-mode client never
  completes hydration: the page renders its SSR shell, zero client fetches
  fire, and zero console errors surface — a fully inert DOM that looks
  loaded. The suite therefore navigates the browser via `localhost` (same
  server, same port — same-origin for the dev server) while the HTTP
  seeding client keeps the station-provided base verbatim.

## Skip guard (honest, never silent)

If `findBrowserBinary()` cannot find a Chromium-family binary anywhere, the
suite does **not** fake a pass: every flow test reports a **skip** carrying
the reason ("no Chromium-family binary found …"). A skipped run is visible in
the `node --test` output (`# skipped`) and is called out here as *not* a green
fresh-browser proof. Install a browser (any of the discovery locations) and
re-run; `YOU_E2E_BROWSER=/path/to/chrome` pins one explicitly.

## Relationship to the contract suite

The two gates are deliberately separate, mirroring the existing law (the
standalone `storage-db` / `resilience-routes` / `compute-broker-e2e` contract
suites that boot their own servers):

```bash
node --test tests/contract/   # the contract gate — no browser needed
node --test tests/e2e/        # the fresh-browser gate — needs Chromium
```

The contract gate is unchanged. The e2e gate adds the browser leg on top.

## CI wiring

The e2e command is a **separate documented gate** (above), matching how the
full contract gate is a station command rather than part of the minimal CI
smoke. To wire it into GitHub Actions later, add a job that installs a
browser into the default discovery path, then runs the command — the suite
itself needs nothing else:

```yaml
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: pnpm install --frozen-lockfile=false
      - run: npx --yes playwright@latest install chromium --with-deps
        # installs into ~/.cache/ms-playwright — the driver's default search path
      - run: cp apps/web/.env.example apps/web/.env
      - run: cd apps/web && pnpm db:push
      - run: node --test tests/e2e/
```

(Not enabled by default: the repo's CI signal stays byte-identical, and the
browser leg is gated on runners having a browser — the skip guard keeps the
command safe anywhere.)
