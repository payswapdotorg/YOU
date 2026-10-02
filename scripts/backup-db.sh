#!/usr/bin/env bash
# backup-db.sh — P6.A5: consistent SQLite backup + restore drill for the YOU app db.
#
# Usage:
#   bun scripts/backup-db.sh                 # backup apps/web/db/custom.db → backups/<stamp>/
#   bun scripts/backup-db.sh --restore <dir> # restore from a backup dir (STOPS nothing —
#                                            # run against a stopped app; the drill does this)
#
# Production note: on the hosted topology the relational plane is Neon
# PostgreSQL (branch-based PITR — see docs/BACKUP_RESTORE_P6.md); this script
# is the LOCAL/dev-tier procedure AND the restore-drill harness that proves
# the restore path actually works (a backup that has never been restored is
# a hope, not a backup).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The db the app actually uses: DATABASE_URL (if absolute) wins — process env
# beats .env files (the exact trap this station hit live: a shell-exported
# DATABASE_URL silently redirected every dev server to another db).
case "${DATABASE_URL:-}" in
  file:/*) DB="${DATABASE_URL#file:}" ;;
  *)       DB="$ROOT/apps/web/db/custom.db" ;;
esac
BACKUPS="$ROOT/backups"

stamp() { date -u +%Y%m%dT%H%M%SZ; }

do_backup() {
  [ -f "$DB" ] || { echo "no db at $DB — nothing to back up" >&2; exit 1; }
  mkdir -p "$BACKUPS"
  local dest="$BACKUPS/$(stamp)"
  mkdir -p "$dest"
  # consistent online snapshot (safe against a live writer, unlike cp):
  # sqlite3 CLI .backup → python3 sqlite3 backup API → cp (last resort,
  # disclosed). All three write $dest/custom.db.
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB" ".backup '$dest/custom.db'"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$DB" "$dest/custom.db" <<'PYEOF'
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
con = sqlite3.connect(src)
con.backup(sqlite3.connect(dst))
con.close()
PYEOF
  else
    echo "WARNING: no sqlite3 tooling — cp fallback (NOT consistent against a live writer)" >&2
    cp "$DB" "$dest/custom.db"
  fi
  # integrity + row evidence (the restore drill asserts against these)
  python3 - "$dest" <<'PYEOF'
import sqlite3, sys, pathlib
dest = pathlib.Path(sys.argv[1])
con = sqlite3.connect(dest / "custom.db")
ok = con.execute("PRAGMA integrity_check;").fetchone()[0]
(dest / "integrity.txt").write_text("integrity_check: %s" % ok + chr(10))
lines = []
for t in ("Tenant", "Twin", "EvidenceAsset", "ConsentGrant", "Session"):
    try:
        lines.append("%s=%d" % (t.lower() + "s", con.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0]))
    except Exception as e:
        lines.append("%s=ERR(%s)" % (t, e))
(dest / "rowcounts.txt").write_text("\n".join(lines) + "\n")
PYEOF
  sha256sum "$dest/custom.db" > "$dest/custom.db.sha256"
  echo "BACKUP OK: $dest"
  cat "$dest/integrity.txt" "$dest/rowcounts.txt" 2>/dev/null || true
}

do_restore() {
  local src="$1"
  [ -f "$src/custom.db" ] || { echo "no custom.db under $src" >&2; exit 1; }
  (cd "$src" && sha256sum -c custom.db.sha256 >/dev/null) || { echo "checksum mismatch — refusing to restore" >&2; exit 1; }
  mkdir -p "$ROOT/apps/web/db"
  cp "$src/custom.db" "$DB"
  echo "RESTORE OK: $DB <- $src (checksum verified)"
}

case "${1:-}" in
  --restore) do_restore "${2:?usage: backup-db.sh --restore <dir>}" ;;
  *) do_backup ;;
esac
