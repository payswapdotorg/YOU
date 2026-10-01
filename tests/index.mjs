// Aggregator entry for `node --test tests/` on Node ≥ 24, where the test
// runner resolves a positional directory argument as a MODULE path (not a
// directory scan). tests/package.json points `main` here; this file imports
// every test file so the verbatim gate command runs the full suite.
// (`node --test` auto-discovery and explicit file paths work as before.)
import './contract/smoke.test.mjs';
import './contract/verification-flow.test.mjs';
