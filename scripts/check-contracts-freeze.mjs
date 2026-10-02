#!/usr/bin/env node
// check-contracts-freeze.mjs — P6.T2 contract-freeze gate.
//
// Verifies two invariants:
//   1. every file listed in contracts/SHA256SUMS.v1 still hashes to its
//      frozen value (frozen surfaces cannot drift silently);
//   2. the path inventory in contracts/openapi/v1/openapi.yaml still
//      matches the implemented /v1 route tree (the inventory cannot
//      silently diverge from reality).
//
// A frozen file MAY be changed, but only together with an updated
// manifest in the same commit — the PR then carries the contract change
// explicitly for TL review (docs/CONTRACTS_FREEZE.md law).

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const manifestPath = join(root, "contracts", "SHA256SUMS.v1");
let failures = 0;

// --- 1. manifest check -----------------------------------------------------
const lines = readFileSync(manifestPath, "utf8").split("\n").filter((l) => l.trim());
for (const line of lines) {
  const m = line.match(/^([0-9a-f]{64})  (.+)$/);
  if (!m) { console.error(`MALFORMED MANIFEST LINE: ${line}`); failures++; continue; }
  const [, want, rel] = m;
  let got;
  try {
    got = createHash("sha256").update(readFileSync(join(root, rel))).digest("hex");
  } catch {
    console.error(`MISSING FROZEN FILE: ${rel}`);
    failures++;
    continue;
  }
  if (got !== want) {
    console.error(`CONTRACT DRIFT: ${rel}\n  frozen  ${want}\n  actual  ${got}\n  If this change is intentional, update contracts/SHA256SUMS.v1 in this commit and note the contract impact in the PR (docs/CONTRACTS_FREEZE.md).`);
    failures++;
  }
}
console.log(`manifest: ${lines.length} frozen surfaces checked`);

// --- 2. route inventory check ----------------------------------------------
const routes = new Set();
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name === "route.ts") {
      const rel = relative(join(root, "apps/web/src/app/api/v1"), dir)
        .replaceAll("\\", "/")
        .split("/")
        .map((s) => (s.startsWith("[") ? `{${s.slice(1, -1).replace("...", "")}}` : s))
        .join("/");
      if (rel === "{path}") continue; // catch-all fallback is not a contract surface
      const src = readFileSync(p, "utf8");
      for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        if (src.match(new RegExp(`export async function ${m}\\b`))) routes.add(`/${rel}#${m.toLowerCase()}`);
      }
    }
  }
})(join(root, "apps/web/src/app/api/v1"));

const spec = readFileSync(join(root, "contracts/openapi/v1/openapi.yaml"), "utf8");
const specOps = new Set();
for (const [idx, body] of spec.split("\n  /").entries()) {
  const p = idx === 0 ? null : "/" + body.split(":\n")[0];
  if (!p) continue;
  for (const m of ["get", "post", "put", "patch", "delete"]) {
    if (new RegExp(`^    ${m}:$`, "m").test(body)) specOps.add(`${p}#${m}`);
  }
}

const missingInSpec = [...routes].filter((r) => !specOps.has(r));
const extraInSpec = [...specOps].filter((r) => !routes.has(r));
if (missingInSpec.length) { console.error(`ROUTES MISSING FROM FROZEN SPEC:\n  ${missingInSpec.join("\n  ")}`); failures++; }
if (extraInSpec.length) { console.error(`FROZEN SPEC OPERATIONS WITH NO ROUTE:\n  ${extraInSpec.join("\n  ")}`); failures++; }
console.log(`inventory: ${routes.size} implemented operations vs ${specOps.size} frozen operations`);

if (failures) { console.error(`CONTRACT FREEZE GATE: FAILED (${failures})`); process.exit(1); }
console.log("CONTRACT FREEZE GATE: PASSED");
