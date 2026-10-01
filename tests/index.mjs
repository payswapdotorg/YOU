// Aggregator entry for `node --test tests/` on Node ≥ 24, where the test
// runner resolves a positional directory argument as a MODULE path (not a
// directory scan). tests/package.json points `main` here; this file imports
// every test file so the verbatim gate command runs the full suite.
// (`node --test` auto-discovery and explicit file paths work as before.)
//
// NOTE (W4.A): imports MUST stay STATIC. With top-level-await dynamic imports
// the runner starts the root test before module evaluation finishes, which
// breaks top-level before()/after() grouping for every imported file (observed
// live: after() hooks fired mid-boot and the dev server was never reaped).
// Static imports keep the baseline semantics: all hooks/tests register during
// synchronous evaluation, then the root runs before-hooks → tests → after-hooks.
// The aggregated flag below is set AFTER the imports evaluate but BEFORE any
// test executes, telling the W4.A hardening suite to reuse (not re-boot) the
// verification-flow server published on globalThis.
import './contract/smoke.test.mjs';
import './contract/verification-flow.test.mjs';
import './contract/hardening.test.mjs';

globalThis.__YOU_TEST_AGGREGATED__ = true;
