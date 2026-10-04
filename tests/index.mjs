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
//
// NOTE (G-7 fix, 2026-10-01): tests/contract/storage-db.test.mjs is
// DELIBERATELY NOT imported here — it asserts the YOU_STORAGE_BACKEND=db
// object store and therefore always boots its OWN server with that env
// override (the aggregate shares one fs-backend server). The full station
// gate is BOTH commands, in order:
//   node --test tests/            (aggregated, fs backend — the default path)
//   node --test tests/contract/storage-db.test.mjs   (standalone, db backend)
import './contract/smoke.test.mjs';
import './contract/verification-flow.test.mjs';
import './contract/hardening.test.mjs';
import './contract/ai-registry.test.mjs';
// P6.A6-FULL unit suite (imported statically, runs in the aggregated gate —
// pure unit: injected sleeps/clocks, no server boot, no network, no db)
import './contract/resilience.test.mjs';
// P6.C2 render-path suite (imported statically, LAST — pure unit + a local
// 127.0.0.1 DashScope mock; injected sleeps/clocks, no app boot, no db)
import './contract/ai-render.test.mjs';
// P6.B8 UX-states unit suite (imported statically, LAST — pure unit over the
// zero-runtime-import client modules degraded.ts + error-taxonomy.ts: 503 /
// Retry-After parsing, countdown math, dead-job explanation, error taxonomy;
// no React, no network, no db)
import './contract/ux-states.test.mjs';
// P6.C3 compute-broker unit suite (imported statically — pure unit over the
// broker's zero-import routing half composed with the real A6 resilience
// helpers; no app boot, no network, no db. The e2e suite
// compute-broker-e2e.test.mjs is STANDALONE by design — it boots its own
// server with provider-routing env overrides, same law as
// resilience-routes.test.mjs / storage-db.test.mjs)
import './contract/compute-broker.test.mjs';
// P6.C4 F1-reconstruction unit suite (imported statically — pure unit over
// the pipeline's zero-import half (lab/f1-recon.ts) composed with the real
// AI registry (the exact resolution the recon seam performs per call):
// consent-gated entry, liveness/quality refusal taxonomy, no-laundering
// failure disclosure, 8-step protocol coverage aggregation, TwinVersion
// provenance linkage, determinism; no app boot, no network, no db)
import './contract/f1-recon.test.mjs';
// P6.B3 F1 operator capture flow suite (imported statically — boots/reuses
// the shared app server like the W4.A hardening suite: consent-gate
// enforcement at the API level, protocol persistence, manifest
// content-addressing, review promotion, deletion/export flow; the only DB
// seeding is the f1.reconstruct terminal state, mirroring the executor's
// row shape — no network beyond 127.0.0.1)
import './contract/f1-operator-flow.test.mjs';
// P6.C6 Agent Body/Soul production runtime unit suite (imported statically —
// pure unit over the runtime's zero-import half (agent/runtime-core.ts)
// composed with the REAL resilience modules (core/retry.ts +
// core/deadletter.ts — the exact engine core/jobs.ts wraps executors in):
// capability manifest honesty, lifecycle + binding rule taxonomy, the
// server-side capability enforcement law, retry-then-deadletter behavior,
// event emission with real measured latencies, determinism, and the honest
// HTTP 4xx/5xx taxonomy; no app boot, no network, no db)
import './contract/agent-runtime.test.mjs';
// P6.B5 targeted EvidenceRequest UX suite (imported statically — boots/reuses
// the shared app server like the P6.B3 suite: guided fulfillment linkage
// (request → captureSessionId → fulfilled at complete), consent-gate
// enforcement on the fulfillment capture, expiry sweep with the
// mid-fulfillment grace, list filtering, tenant isolation; DB seeding only
// for timestamps + the isolation tenant — no network beyond 127.0.0.1)
import './contract/evidence-ux.test.mjs';
// P6.C7 Live session runtime unit suite (imported statically — pure unit
// over the live runtime's zero-import half (live/live-core.ts): consent
// enforcement, signaling state machine, idempotent bounded state events,
// connection transitions, tenant isolation, agent-session binding, C6
// turn-state → live surface mapping, signaling tokens, honest HTTP taxonomy;
// no app boot, no network, no db)
import './contract/live-sessions.test.mjs';
// P6.B7 AI-provider avatar UX suite (imported statically — pure unit over
// the embodiment state machine + soul provider resolution: legal/illegal
// transition table, fail-closed provider status, soul provider config
// validation, tenant isolation; no app boot, no network, no db)
import './contract/avatar-ux.test.mjs';
// P6.C8 virtual try-on contract suite (imported statically — pure unit over
// the try-on adapter's zero-import contract core (adapters/try-on.ts),
// composed exactly as the tryon.render executor folds it: the disclaimer
// contract (verbatim visualOnlyDisclaimer on every result — altered or
// missing refuses), fail-closed YOU_TRYON_PROVIDER resolution (unset/none →
// honest unavailable; missing hosted credentials listed precisely; unknown
// values throw), garment upload validation laws, identity-report honesty
// (unverified = score null + reason, real scores only from real vision
// comparisons, product-ref preservation as a structural invariant), the
// diff manifest (provider-reported or the honest unknown), the strict
// vision-score parser, the hosted Vertex call through injected fetch
// (verbatim error taxonomy, no-image refusal, API-key header flow), the
// pipeline fold (provider gate before ANY provider spend), the HTTP
// taxonomy and tenant isolation via the route-fold harness; no app boot,
// no network, no db)
import './contract/try-on.test.mjs';
// P6.B9 docs/playground/onboarding suite (imported statically — pure unit
// over the frozen-inventory playground ops + sandbox resolution + examples
// compile-mirror + onboarding persistence; API level boots/reuses the shared
// app server like the B3/B5/B7 suites: mutation-confirmation enforcement,
// honest sandbox refusal, set-cookie never rendering, tenant isolation; no
// network beyond 127.0.0.1)
import './contract/b9-docs-playground.test.mjs';

// P6.C9 game/VRM/GLB export contract suite (imported statically — pure unit
// over the game-export adapter's zero-import contract core (adapters/
// game-export.ts), composed exactly as the export.glb/export.vrm executors
// fold it: GLB binary validity (magic/chunks/alignment/accessor bounds),
// the you-generic-v1 node+skin hierarchy against the HTIR input, the VRM 0.x
// extension (humanoid map, blendshape placeholder honesty — zero deltas only
// for the HTIR articulation set), LOD counts recounted from the REAL emitted
// glTF JSON, byte-determinism, fail-closed negatives (unknown format, no
// usable geometry — never a default body), the structural-vs-derived
// manifest split, the ARKit/Unity/Unreal mapping table with explicit
// unmapped entries, the honest package manifest, and the route decision
// folds (validation 400, twin/version 404, consent 403 reconstruct scope,
// idempotent replay with ORIGINAL ids, GET tenant isolation 404); no app
// boot, no network, no db)
import './contract/game-export.test.mjs';

// P6.C11 lab benchmark artifacts + Failure Atlas contract suite (imported
// statically — pure unit over the C11 zero-import contract cores (lab/
// run-manifest.ts + lab/failure-codes.ts + lab/soul-swap.ts), composed
// exactly as the lab.benchmark executor and the /api/v1/lab routes fold
// them: write-once run manifests (deterministic construction, structural vs
// observed technology versions, per-stage provider/model/compute basis
// labels, terminal runs NEVER mutated — re-runs are new rows referencing
// their parent), run comparison + regression detection (cross-seed refused,
// same-seed metric/stage diffs, configurable thresholded regression and
// improvement flags, machine-readable verdict, observed latencies displayed
// but never thresholded), the typed versioned failure-code taxonomy with
// honest UNCLASSIFIED, atlas aggregation over REAL seeded cases only (by
// code/region/pipeline/technology version, confidence rollups, inclusive
// time windows, honest empty), the remediation lifecycle open → mitigated →
// verified with evidence-required audit entries and honest 409 refusals,
// policy decisions labeled enforced-vs-proposed, the deterministic
// soul-swap scenario over the real seeded world + compiled organizations
// with ONE injected grounding call per org (or honest modeled-only
// degradation), and the content-addressed artifact export (same run → same
// bytes → same sha256); no app boot, no network, no db)
import './contract/lab-benchmark-atlas.test.mjs';

globalThis.__YOU_TEST_AGGREGATED__ = true;

