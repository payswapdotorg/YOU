// Aggregator entry for `node --test tests/contract/` on Node ≥ 24, where the
// test runner resolves a positional directory argument as a MODULE path (not
// a directory scan) — exactly the tests/ pattern one level up (P6.B4 adds
// this file so the lane's documented gate command
//   node --test tests/contract/
// runs on the station's Node instead of failing with MODULE_NOT_FOUND).
// tests/contract/package.json points `main` here; this file imports every
// aggregated suite so the verbatim gate command runs them all in ONE process
// with ONE shared app server (the __YOU_TEST_AGGREGATED__ /
// __YOU_TEST_BASE__ law from tests/index.mjs — static imports only, see the
// W4.A note there about top-level-await dynamic imports breaking hooks).
//
// Deliberately NOT imported (same law as tests/index.mjs): the suites that
// boot their OWN server with env overrides —
//   storage-db.test.mjs        (YOU_STORAGE_BACKEND=db override)
//   resilience-routes.test.mjs (provider mock + resilience knobs)
//   compute-broker-e2e.test.mjs (provider-routing env overrides)
// The full station gate for those is each suite's standalone command, per
// the G-7 note in tests/index.mjs.
import './smoke.test.mjs';
import './verification-flow.test.mjs';
import './hardening.test.mjs';
import './ai-registry.test.mjs';
// P6.A6-FULL unit suite (injected sleeps/clocks, no server boot)
import './resilience.test.mjs';
// P6.C2 render-path suite (pure unit + a local 127.0.0.1 DashScope mock)
import './ai-render.test.mjs';
// P6.B8 UX-states unit suite (zero-runtime-import client modules)
import './ux-states.test.mjs';
// P6.C3 compute-broker unit suite
import './compute-broker.test.mjs';
// P6.C4 F1-reconstruction unit suite
import './f1-recon.test.mjs';
// P6.B3 F1 operator capture flow suite (boots/reuses the shared app server)
import './f1-operator-flow.test.mjs';
// P6.C6 Agent Body/Soul production runtime unit suite
import './agent-runtime.test.mjs';
// P6.B4 deficiency-visualization suite (pure unit + boots/reuses the shared
// app server like the B3 suite; direct Prisma seeding mirrors persisted rows)
import './deficiency-viz.test.mjs';
// P6.B6 Solution-Artifact completion suite (pure unit over the section
// builders + boots/reuses the shared app server; real durable jobs:
// capture.quality, twin.compile ×2, performance.fromText, render.image)
import './artifact-completion.test.mjs';

globalThis.__YOU_TEST_AGGREGATED__ = true;
// P6.C10 — the lab-prod suite is NOT imported (same law as the suites above:
// its executors-chain compile breaches the aggregated shared server's 4 GiB
// cgroup ceiling — see the note in tests/index.mjs; it boots its own lean
// server standalone):   node --test tests/contract/lab-prod.test.mjs
