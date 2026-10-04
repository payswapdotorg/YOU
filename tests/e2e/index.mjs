// Aggregator entry for `node --test tests/e2e/` on Node ≥ 24, where the test
// runner resolves a positional directory argument as a MODULE path (not a
// directory scan) — the same law as tests/contract/index.mjs
// (tests/e2e/package.json points `main` here). This file statically imports
// the fresh-browser suite so the documented e2e gate command
//   node --test tests/e2e/
// runs it in ONE process with ONE shared app server.
//
// The e2e suite is DELIBERATELY SEPARATE from the contract gate
// (node --test tests/contract/): the contract suites need no browser; the
// e2e suite needs a real Chromium binary and skips loudly (never silently)
// when none is discoverable — see docs/E2E.md.
import './fresh-browser.test.mjs';
