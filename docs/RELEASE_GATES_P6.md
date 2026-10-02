# Release Gates — Phase 6 Coordination (P6.T5)

**Coordinator:** TL · **Updated:** 2026-10-02 19:30Z · **Main:** `25e8686`

The five production-readiness gates from `docs/PHASE_6_HANDOFF.md`, tracked to
closure with evidence and owners. This is the coordination record; the
per-item state below is mirrored into `docs/PRODUCTION_CHECKLIST.md`.

## Gate status

| Gate | State | Evidence / blocker | Owner |
|---|---|---|---|
| **PR-1** CI green on clean clone | ✅ **CLOSED** | CI green on 7 consecutive PRs (t1 round-2 through T4); `pnpm setup` + typecheck + test + lint + contract-freeze gate all pass on pristine clones + patch replay (P6.T1 round-1 forensics) | — |
| **PR-2** Production R2 live | ⏳ **CODE-READY, BLOCKED ON CREDS** | Adapter merged (`15aca1b`, P6.A1): SigV4-verified against a cryptographically-checking mock, fail-closed env, capability URLs unchanged. Goes live the moment the bucket + API token exist (P6.T3 operator login #1: Cloudflare) | Operator → TL |
| **PR-3** Hosted provider path live | ⏳ **CODE-READY, BLOCKED ON CREDS** | OpenRouter recon adapter merged (`a8d5073`, P6.C1): E2E-proven against a mock provider (request shape + honest failure). Goes live with `OPENROUTER_API_KEY` (P6.T3; note O-2 in the security review — production must set `YOU_RECON_PROVIDER=openrouter` explicitly) | Operator → TL |
| **PR-4** F1 real authorized QA subject | ⏳ **PENDING** | Requires a hosted deployment to capture against (PR-5 first); the operator is the QA subject per the mission plan | Operator |
| **PR-5** F9 hosted end-to-end artifact | ⏳ **PENDING** | Requires Vercel deployment (P6.T3 operator login #4); the F9 station verification proved the db storage backend is the serverless-viable path (FS cannot write on lambdas) | Operator → TL |

## What landed this phase (evidence index)

| Item | Commit | Proof |
|---|---|---|
| P6.T1 CI repair | `e174be8` | PR #1 (+round-2), CI green on PR + main |
| P6.T2 contract freeze | `da40128` | PR #2: 51-path/65-op inventory, manifest, gate negative-tested |
| P6.A1 R2 adapter | `15aca1b` | PR #3: storage-r2 suite 5/5 (SigV4 cryptographically verified) |
| P6.C1 recon adapter | `a8d5073` | PR #4: recon-openrouter suite 2/2 (full job path + honest failure) |
| P6.A2 config hardening | `5c3d57f` | PR #5: config-hardening 2/2 + direct production-refusal evidence |
| P6.A3 key rotation | `bb339c6` | PR #6: api-key-lifecycle 4/4; first freeze-law additive change |
| P6.T4 security review | `25e8686` | PR #7: `docs/SECURITY_REVIEW_P6.md` (10 closed / 4 scheduled findings) |

All merges squashed to `main`; CI green on every PR and on main after each
merge; the contract-freeze gate ran on every branch.

## Coordination plan to midnight

1. **Operator** (the only blocking actor): provider logins through the replay
   image, in order: Cloudflare (R2) → Neon (Postgres) → Upstash (Redis) →
   Vercel (deploy). The Cloudflare signup tab is staged; each login is
   followed by TL-driven console/API steps (bucket + token creation, project
   wiring, envvar plumbing, deploy + smoke).
2. **TL** (while waiting): A6 interim hardening (per-tenant in-memory rate
   limiter on the session/upload surface — closes security finding O-1's
   interim option), then F10 sign-off assembly (T6) from whatever gate state
   is real at deadline — honest, not aspirational.
3. **Workers**: platform capacity has been saturated all evening (turns spawn
   phantom); the ledger records the TL-implementation substitution with full
   disclosure in each PR.

## Checklist mirror (verified items only)

`docs/PRODUCTION_CHECKLIST.md` boxes are checked ONLY where a test or merge
evidence exists; everything else stays open and owned by its gate above.
