# UX Survey — P6 (Stripe public pages → Studio IA reconciliation)

**Round 2 rebuild disclosure.** The round-1 edition of this document was destroyed in a pod
wipe before delivery bytes could be transferred. This is an independent re-survey performed
under the same work-order constraints: public marketing/documentation pages only, fetched
 anonymously, patterns only — no proprietary assets, code, branding, or exact interface
copies. Pattern selection is a round-2 re-derivation from the pages below; it is not a
byte-restore of round 1 (those bytes no longer exist).

- **Survey date:** 2026-10-03
- **Method:** automated page fetch (rendered text extraction) of the nine public URLs
  listed in §Sources; no authenticated Dashboard views were accessed; no screenshots or
  asset files were taken; evidence quotes are limited to short phrases describing behavior.
- **Why Stripe:** a checkout-grade reference for exactly the problems the Studio has —
  long opaque identifiers, async jobs, credentials, consent-gated actions, and operator
  surfaces that must stay honest under failure.

## Sources (all viewed 2026-10-03)

| # | Page | URL |
|---|------|-----|
| 1 | Home (marketing) | https://stripe.com/ |
| 2 | Payments (marketing) | https://stripe.com/payments |
| 3 | Pricing (marketing) | https://stripe.com/pricing |
| 4 | Documentation home | https://docs.stripe.com/ |
| 5 | API reference | https://docs.stripe.com/api |
| 6 | Quickstart | https://docs.stripe.com/quickstart |
| 7 | API keys guide | https://docs.stripe.com/keys |
| 8 | Webhooks guide | https://docs.stripe.com/webhooks |
| 9 | 404 probe (nonexistent page) | https://docs.stripe.com/no-such-page-p6-probe |

## Patterns

### P1 — Progressive disclosure in navigation
The docs home exposes products, then each guide narrows to one task; the marketing pages
summarize first and link deeper ("simple, pay-as-you-go pricing" on /pricing links into
full fee tables). Nothing is hidden behind auth for the learning path; complexity appears
only when the task demands it.
**Studio mapping:** the shell nav groups views by phase (Build → Embodiment → Develop →
Trust → Account) and twin detail reduces to four tabs (Versions / Capture / Improve /
Compare). Overview shows pipeline state, not raw job records.

### P2 — Task-oriented page titles
The webhooks guide is titled "Receive Stripe events in your webhook endpoint" — the
job-to-be-done, not the mechanism. Navigation and search results read as tasks, which
keeps wayfinding self-describing.
**Studio mapping:** `VIEW_TITLES` + empty-state hints are phrased as jobs ("Capture
sessions are started from a twin — the checklist guides region coverage…"), and the
command palette lists actions ("Create Twin", "Run Lab benchmark") before destinations.

### P3 — Quickstart narrows to first success
The quickstart page reduces an entire platform to one rail: integrate, test, done. The
first rung is deliberately small and always visible, not gated behind configuration.
**Studio mapping:** Overview's GetStarted card routes straight to Create Twin; the create
dialog is one focused form; capture checklists decompose evidence gathering into
per-region items so the first upload is always one small step.

### P4 — Test/live duality made explicit everywhere
Key pages state mode unambiguously: sandbox vs live mode keys, "Switch to your live mode
keys" as an explicit action, and test-key prefixes so a credential's power is readable at
a glance. The system never lets you forget which world you are operating in.
**Studio mapping:** the shell sidebar carries an "env: local" badge; Labs renders
simulated research truth with an explicit banner (never production truth); Settings
lists the environment facts (SQLite, local object store, cookie session) rather than
imitating a cloud console.

### P5 — Credential lifecycle transparency
The keys guide describes the full life cycle — create, reveal, expire, roll — and is
frank about risk classes (unrestricted secret keys discouraged; restricted keys
recommended; managed keys delegated to hosting platforms; webhook signing secrets
separated from API keys). Power is explained next to the button that grants it.
**Studio mapping:** Develop → API Keys shows a secret exactly once at creation, makes
revocation immediate and server-enforced, and says so in Settings ("Keys & access").

### P6 — Copy affordances for long identifiers
Every long value in the docs (keys, event names, code) has a copy affordance and a
display form that truncates safely; identifiers are never re-typed by hand.
**Studio mapping:** `IdChip` (copy-on-click with copied confirmation) and `CopyButton`
/ `CodeBlock` across twin IDs, asset IDs, job IDs, and the Artifact API tab snippet.

### P7 — Predictable error taxonomy with retry guidance
The API reference enumerates error classes (invalid parameters, authentication,
network) and states plainly which failures are retryable ("We don't save the idempotent
result… You can retry these requests"). Client libraries are expected to "gracefully
handle all possible API exceptions."
**Studio mapping:** the B8 `QueryError` / `ApiErrorSurface` pair renders typed failures
with retry and retry-after guidance; P6.B2 extends this so every list query and mutation
route through one of them instead of hand-rolled error divs.

### P8 — Idempotency surfaced as product behavior
Idempotency keys are a first-class docs concept: same key + same parameters = no double
effect; mismatches error loudly. Retry-safety is a UI promise, not an implementation
secret.
**Studio mapping:** mutation surfaces mint fresh idem keys on retry (reconstruct,
analyze, renders); the operator dead-letter surface replays a dead job as a new attempt
with its own idempotency, and the UI words retries as attempts rather than promising
duplicate-free magic.

### P9 — Contained 404 with a way out
The nonexistent-page probe returns a small page: a title ("Page not found"), the docs
logo, and one recovery action ("Return to Stripe Docs home"). No dead ends, no stack
trace, no marketing flood.
**Studio mapping:** `ViewErrorBoundary` degrades a crashing view to an honest surface
with recovery to Overview; empty states carry next-step actions (consent gate → Create
Twin; roadmap → Agent Avatars) so there is always a way forward.

### P10 — Economics honesty in dense tables
The pricing page leads with the summary ("No setup fees, monthly fees, or hidden fees"),
then shows complete fee tables including the awkward ones (dispute fees, with "You get
this fee back for won disputes"). Density is fine; surprise is not.
**Studio mapping:** Usage & Billing and the operator metrics surface enumerate real
costs/counters in dense tables with explicit caveats rather than rounding away
unpleasant states (dead jobs, breaker-open, degraded provider).

## IA reconciliation (primary flow)

Primary flow: **Create Twin → Review → Improve → Style → Performance → Render →
Artifact → API.**

| Flow stage | Studio view(s) | Patterns applied | Why |
|------------|-----------------|------------------|-----|
| Create Twin | overview, twins, shell | P2, P3 | GetStarted routes to one focused create form; titles/hints read as tasks |
| Review (captures) | captures, twin-detail (Capture tab) | P3, P6, P7 | Checklist decomposes evidence; IdChip copies asset IDs; upload failures retry inline |
| Improve | twin-detail (Improve/Compare tabs) | P1, P7 | Tab-level disclosure; typed errors on versions query |
| Style | templates | P7, P8 | Analyze refusals (503/429) surface inline with retry; fresh idem keys per attempt |
| Performance | performances, labs | P3, P10 | Twin-attach honesty while loading; benchmark truth stays labeled simulated (P4) |
| Render | renders, live | P4, P7 | Kind/style selects labeled; video previews named; job panels show live steps only |
| Artifact | artifact, develop | P6, P10 | Copyable API snippet; immutable-version economics stated plainly |
| API (operate) | develop, settings-ops, usage | P4, P5, P7, P8, P10 | Key lifecycle honesty; operator retry/replay with dead-letter semantics; usage counters not rounded away |
| Cross-cutting | shell (all views) | P1, P2, P9 | Phase-grouped nav; task wording; error boundary returns to Overview |

## Honest scope & limits

- Marketing and documentation pages only; the authenticated Stripe Dashboard was NOT
  viewed. Claims above are about public-page interaction design, not dashboard internals.
- Extraction was automated (rendered text); dynamic/JS-only behaviors could not be
  observed. No screenshots were captured or reproduced.
- Pattern names and the mapping table are this survey's own analysis; they abstract
  interaction behavior, not visual design, and no proprietary assets, code, branding,
  or exact interface copies were taken.
- The 404 probe URL is intentionally a nonexistent page created for this survey.
- Round-1's exact pattern set was destroyed with the pod; this round-2 set covers the
  same ground but is not guaranteed isomorphic to it. Divergences are disclosed here
  rather than papered over.
