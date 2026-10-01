import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("repository source of truth exists", () => {
  for (const file of [
    "AGENTS.md",
    "docs/ARCHITECTURE.md",
    "docs/API_CONTRACTS.md",
    "docs/DATA_MODEL.md",
    "contracts/htir/v1/htir.schema.json",
    "contracts/events/v1/agent-performance-events.schema.json",
    "contracts/lab/v1/world.schema.json"
  ]) assert.equal(fs.existsSync(file), true, file);
});
