# @you/sdk-js

Standalone typed JavaScript/TypeScript client for the **YOU platform** `/api/v1`
surface. Worker A lane, work item A8 (wave 3).

## Status

`0.1.0` — extraction of the in-app typed client plus the templates
(W2.B) and verification-sessions incl. `evaluate` (W3.A / A4) surfaces.
The server routes under `apps/web/src/app/api/v1/**` are the authority;
this package mirrors their request/response shapes.

## Transitional duplication (deliberate)

The in-app Studio client `apps/web/src/lib/you/client/api.ts` (TL-owned)
**stays untouched** and remains what the Studio SPA uses today. This package
duplicates that surface — plus the view types it depends on (from
`apps/web/src/lib/you/contracts/index.ts`, `core/templates.ts`,
`core/verification.ts`) — because a standalone workspace package **must not
import from `apps/web`**.

Drift between the SDK types and the server's serialized views is an
integration bug. The Tech Lead collapses the duplication into a single source
at landing time; until then both surfaces are kept in sync by Worker A.

## Zero runtime dependencies

No dependency on `zod` (or anything else) was needed: the server owns input
validation and emits stable machine error codes; the SDK is a thin typed
transport. Any `fetch` implementation works (Node ≥ 18 undici, bun, browsers).

## Install / usage

The package is part of the pnpm workspace (`packages/*`), consumed as source
(`main`/`exports` point at `src/index.ts`; bun and bundlers run TypeScript
sources directly):

```ts
import { YouClient, YouApiError, uid } from '@you/sdk-js';

// same-origin browser use (session cookie auth):
const you = new YouClient(); // baseUrl defaults to '/api/v1'

// cross-origin / server-side use (session bootstrap then cookie, or API key):
const you = new YouClient({ baseUrl: 'http://localhost:3210/api/v1' });
const session = await you.session.create(); // POST /session → demo tenant bootstrap (sets cookie)

// or with a scoped API key:
const you2 = new YouClient({ baseUrl: 'http://localhost:3210/api/v1', apiKey: 'you_sk_…' });
```

### Idempotency

Mutating routes that consume `X-Idempotency-Key` (§API rules) accept an
optional trailing `idem` argument — e.g. `you.templates.create(body, uid())`.
Replaying the same key returns the original record instead of duplicating it.

### Durable jobs

Asynchronous work (twin compile, capture analysis, template analyze, renders,
lab runs) returns `{ jobId }` immediately; poll `you.jobs.get(jobId)` —
progress advances only on real completion signals.

### Verification flow (§Trust)

```ts
// consent is server-enforced fail-closed: grant it first
await you.consent.grant({ subjectId: 'subj-1', purpose: 'liveness check', scopes: ['capture'] });

const s = await you.verificationSessions.create({ subjectId: 'subj-1', purpose: 'onboarding' });
// s.challenge.prompt → active liveness challenge shown to the subject
// … capture evidence via you.captures.upload …
await you.verificationSessions.submitEvidence(s.id, [assetId]);
const done = await you.verificationSessions.evaluate(s.id); // deterministic, synchronous
// done.result.identityMatch === null && done.result.visualSimilarity === null — ALWAYS:
// this surface never claims an identity match or visual similarity.
await you.verificationSessions.evaluate(s.id); // → YouApiError 409 conflict (already evaluated —
//                                              the persisted result is immutable)
```

The verification-sessions methods take **no** idempotency key by route
contract: replays are answered by the session state machine (`409` for
pending / expired / already-evaluated), never by a silent replay.

## Layout

- `src/types.ts` — view/enum types (duplicated from apps/web contracts; see above)
- `src/client.ts` — `YouClient` (namespaced, typed), `YouApiError`, `uid()`
- `src/index.ts` — public entry
- `tsconfig.json` — standalone `tsc --noEmit` check for this package

## Verification

- `bunx tsc --noEmit` inside this package (strict) — gate transcript in the
  W3.A delivery (`fixed-gates.txt`)
- End-to-end exercised by `tests/contract/verification-flow.test.mjs` (A10)
  against a real booted `apps/web` server.
