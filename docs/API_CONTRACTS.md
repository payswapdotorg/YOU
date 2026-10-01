# YOU API Contract v1

Base: /v1

## Twins
POST /twins
GET /twins/:id
GET /twins/:id/versions
POST /twins/:id/capture-sessions
POST /twins/:id/representations
POST /twins/:id/compile
DELETE /twins/:id

## Captures
POST /captures
GET /captures/:id
POST /captures/:id/complete
GET /captures/:id/evidence

## Performances
POST /performances
GET /performances/:id
POST /performances/from-video
POST /performances/from-audio
POST /performances/from-motion

## Templates and scenes
POST /templates
GET /templates/:id
POST /templates/:id/analyze

## Rendering
POST /renders
GET /renders/:id
POST /live-sessions
GET /live-sessions/:id
POST /try-ons

## Agent avatars
POST /agent-bodies
POST /agent-bodies/:id/possessions
POST /agent-avatar-sessions
POST /agent-avatar-sessions/:id/events
DELETE /agent-avatar-sessions/:id

## Trust
POST /verification-sessions
POST /consent-grants
GET /consent-grants/:id
DELETE /consent-grants/:id
GET /artifacts/:id/provenance

## Labs
POST /lab/objectives
POST /lab/runs
GET /lab/runs/:id
POST /lab/experiments
GET /lab/technologies
GET /lab/pipelines
POST /lab/organizations
POST /lab/promotions

## Developer platform
POST /api-keys
GET /events
POST /webhooks/endpoints
GET /usage

## API rules
- mutating requests support Idempotency-Key
- Idempotency-Key replays are body-fingerprint bound (W4.A F-01): the same key
  with the SAME canonical body replays to the original record (200 template /
  202 same jobId); the same key with a DIFFERENT body returns
  409 `idempotency_conflict` — the stored record is never returned for a
  different payload. Fingerprints are sha256 over the canonical JSON body
  (stable key order); for job-submitting routes the fingerprint binds to the
  persisted job input (the body-derived payload the Job row stores)
- asynchronous work returns a durable job ID immediately
- unmatched /api/v1/* paths return the JSON error envelope
  {error:{code:"not_found",message}} with 404 and content-type
  application/json — never framework HTML inside the API surface (W4.A F-02)
- webhook payloads reference canonical entities
- webhook deliveries are signed (W4.A F-04) — see §Webhook deliveries
- URLs are capability-constrained and expire
- provider/model selection is optional advanced configuration
- errors use stable machine codes and human-readable messages
- no endpoint can bypass consent, rights, provenance or promotion policy

## Webhook deliveries
Every delivery POST carries two signature headers computed with the
endpoint's stored registration secret:

- `X-You-Timestamp: <unix-seconds>`
- `X-You-Signature: sha256=<hex>` = HMAC-SHA256(secret, `timestamp + "." + rawBody`)

Receivers verify by recomputing the HMAC over the received timestamp and the
EXACT raw request body (byte-for-byte, before any JSON re-serialization),
comparing against `X-You-Signature` in constant time, and rejecting stale
timestamps. A tampered body fails verification. Limitation (unchanged):
deliveries are attempted once with a 5s timeout — there is no retry scheduler
yet; failures are recorded verbatim on the WebhookDelivery row.
