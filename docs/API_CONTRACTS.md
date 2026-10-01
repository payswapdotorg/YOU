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
- asynchronous work returns a durable job ID immediately
- webhook payloads reference canonical entities
- URLs are capability-constrained and expire
- provider/model selection is optional advanced configuration
- errors use stable machine codes and human-readable messages
- no endpoint can bypass consent, rights, provenance or promotion policy
