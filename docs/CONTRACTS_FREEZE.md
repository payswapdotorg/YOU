# Production Contract Freeze (P6.T2)

**Status: FROZEN at v1.0.0** — enforced by the `contract-freeze` CI gate
(`scripts/check-contracts-freeze.mjs`).

## Frozen surfaces

| Surface | File |
|---|---|
| HTTP API inventory (51 paths / 65 operations) | `contracts/openapi/v1/openapi.yaml` |
| HTIR schema | `contracts/htir/v1/htir.schema.json` |
| Lab world schema | `contracts/lab/v1/world.schema.json` |
| Agent performance events schema | `contracts/events/v1/agent-performance-events.schema.json` |
| SDK public types | `packages/sdk-js/src/types.ts` |
| Shared contract constants | `packages/contracts/src/index.ts` |
| API contract documentation | `docs/API_CONTRACTS.md` |

Integrity manifest: `contracts/SHA256SUMS.v1` (SHA-256 per file).

## The freeze law

1. **No silent drift.** The CI gate fails any commit where a frozen file's
   hash no longer matches the manifest, or where the implemented `/v1`
   route tree diverges from the frozen inventory in either direction.
2. **Changes are explicit.** A frozen file may only change in a commit that
   (a) updates `contracts/SHA256SUMS.v1` in the same commit, and
   (b) declares the contract impact in the PR description.
3. **Breaking changes bump the version.** Any breaking change to a frozen
   surface requires an OpenAPI `info.version` bump (semver-major) and TL
   sign-off before merge.
4. **Additive changes are cheap but not free.** New routes/fields must be
   added to the inventory and manifest together, so the spec never lags
   reality.

## Verification

```
node scripts/check-contracts-freeze.mjs
```

Exit 0 = manifest intact + inventory matches implementation.
