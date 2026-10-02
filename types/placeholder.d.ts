// Root typecheck placeholder - mirrors scripts/lint-placeholder.mjs (staged bootstrap).
// Workspace TS projects wire into "references" as lanes land; until then this
// ambient file keeps `tsc -b` a valid solution root instead of erroring with
// TS18002 (empty "files" list) or TS18003 (no inputs).
