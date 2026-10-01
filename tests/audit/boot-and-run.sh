#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# W3.C F8 audit battery — boot + run (single-call orchestrator)
# Boots apps/web (pinned base) on :3230 with a deterministic DATABASE_URL and
# YOU_STORAGE_SECRET, waits for readiness, runs battery.sh <part>, then stops
# the server. Designed to run within ONE shell session (sandbox reaps
# background processes between sessions, so nothing may outlive this call).
#
# Usage: bash boot-and-run.sh <1|2> [fresh]
#   fresh → recreate the SQLite db + object store before boot (deterministic)
# ═══════════════════════════════════════════════════════════════════════════
set -u
PART="${1:?usage: boot-and-run.sh <1|2> [fresh]}"
FRESH="${2:-}"
REPO_ROOT="$(cd "$(dirname "$BASH_SOURCE")/../.." && pwd)"
APP="$REPO_ROOT/apps/web"
PORT=3230
export DATABASE_URL="file:$APP/db/custom.db"
export YOU_STORAGE_SECRET="audit-storage-secret-0xdeadbeef"

if [ "$FRESH" = "fresh" ]; then
  rm -f "$APP/db/custom.db"
  rm -rf "$APP/db/you-objects"
  (cd "$APP" && env -i PATH="$PATH" HOME="$HOME" bunx prisma db push --skip-generate >/dev/null 2>&1) \
    || (cd "$APP" && DATABASE_URL="$DATABASE_URL" bunx prisma db push --skip-generate >/dev/null)
  echo "fresh db + object store ready at $APP/db/"
fi

[ -d "$APP/db" ] || mkdir -p "$APP/db"
[ -f "$APP/db/custom.db" ] || (cd "$APP" && env -i PATH="$PATH" HOME="$HOME" bunx prisma db push --skip-generate >/dev/null 2>&1) \
  || (cd "$APP" && DATABASE_URL="$DATABASE_URL" bunx prisma db push --skip-generate >/dev/null)

LOG=/tmp/w3c-dev-server.log
: > "$LOG"
# kill any stale server from a previous session on this port
pkill -f "next dev -p $PORT" 2>/dev/null; sleep 1
(cd "$APP" && DATABASE_URL="$DATABASE_URL" YOU_STORAGE_SECRET="$YOU_STORAGE_SECRET" \
  setsid nohup bunx next dev -p $PORT > "$LOG" 2>&1 < /dev/null &)

echo "waiting for :$PORT …"
READY=0
for i in $(seq 1 90); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:$PORT/" 2>/dev/null || true)
  if [ "$CODE" = "200" ]; then READY=1; break; fi
  sleep 1
done
if [ "$READY" != "1" ]; then
  echo "SERVER FAILED TO BOOT — log tail:"; tail -20 "$LOG"; exit 1
fi
echo "server ready (GET / → 200, waited ${i}s)"
sleep 2

BASE="http://localhost:$PORT" bash "$REPO_ROOT/tests/audit/battery.sh" "$PART"
RC=$?

echo "── server log tail (post-battery) ──"
tail -25 "$LOG" | sed 's/^/  /' | head -30
pkill -f "next dev -p $PORT" 2>/dev/null
pkill -f "listener.mjs" 2>/dev/null
exit $RC
