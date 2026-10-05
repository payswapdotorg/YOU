# YOU — Human Reality Infrastructure

YOU is the Stripe-like infrastructure layer for human digital twins and AI-agent embodiment.

Core loop: Person/Agent -> Evidence -> Twin -> Representation -> Performance -> Reality -> Output.

## Source of truth
Read AGENTS.md, then the canonical docs under docs/. Chat history is not an implementation dependency.

## Product
Persistent photorealistic/3D/anime/stylized twins; image/video replacement; try-on; game/AR exports; realtime embodied agents; AI-provider avatars with Agent Body + swappable Soul; autonomous Labs; interactive Solution Artifacts; consent, verification and provenance.

## Concurrency
Worker A: Core/API.
Worker B: Studio/UX.
Worker C: Labs/AI.
TL: contracts, integration, security, promotion and release.

## Prototype deployment
Vercel + Cloudflare Workers + Neon + Upstash + Cloudflare R2, with GPU execution behind the Compute Broker. Free tiers are bounded development/beta accelerators, never hard dependencies.
> Deploy note 2026-10-05: Vercel project nodeVersion set to 22.x (fixes pnpm@10.0.0 x Node 24 install failures).
