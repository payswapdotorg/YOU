#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# W4.A — boot + curl evidence for the hardening findings (F-01..F-04).
# Boots apps/web on :3230 with a FRESH SQLite db (deterministic), a header
# capturing request-bin on :3232, then drives the documented scenarios and
# records PASS/FAIL per check. Transcript goes to stdout (tee'd by the caller).
# ═══════════════════════════════════════════════════════════════════════════
set -u
REPO=/home/z/my-project/YOU
APP=$REPO/apps/web
SCRIPTS=/home/z/my-project/scripts
PORT=3230
LPORT=3232
BASE="http://localhost:$PORT"
export DATABASE_URL="file:$APP/db/custom.db"
export YOU_STORAGE_SECRET="audit-storage-secret-0xdeadbeef"

PASS=0; FAIL=0
cleanup() {
  pkill -f "next dev -p $PORT" 2>/dev/null
  pkill -f "header-listener.mjs" 2>/dev/null
  return 0
}
trap cleanup EXIT
ck() { # ck <name> <expected> <actual>
  if [ "$2" = "$3" ]; then
    echo "CHECK [$1]: PASS — $2"; PASS=$((PASS+1))
  else
    echo "CHECK [$1]: FAIL — expected [$2] got [$3]"; FAIL=$((FAIL+1))
  fi
}
contains() { case "$1" in *"$2"*) return 0;; *) return 1;; esac; }
ckc() { # ckc <name> <haystack> <needle>
  if contains "$2" "$3"; then echo "CHECK [$1]: PASS — contains '$3'"; PASS=$((PASS+1));
  else echo "CHECK [$1]: FAIL — missing '$3' in: ${2:0:200}"; FAIL=$((FAIL+1)); fi
}

echo "═══ W4.A EVIDENCE — $(date -u +%Y-%m-%dT%H:%M:%SZ) — HEAD $(git -C "$REPO" rev-parse --short HEAD) ═══"

# ── fresh db + boot ─────────────────────────────────────────────────────────
pkill -f "next dev -p $PORT" 2>/dev/null; pkill -f "header-listener.mjs" 2>/dev/null; sleep 1
rm -f "$APP/db/custom.db"; rm -rf "$APP/db/you-objects"
(cd "$APP" && bunx prisma db push --skip-generate >/dev/null 2>&1) || { echo "db push FAILED"; exit 1; }
echo "fresh db ready at $APP/db/custom.db"

LOG=/tmp/w4a-dev.log; : > "$LOG"
(cd "$APP" && DATABASE_URL="$DATABASE_URL" YOU_STORAGE_SECRET="$YOU_STORAGE_SECRET" \
  setsid nohup bunx next dev -p $PORT > "$LOG" 2>&1 < /dev/null &)
echo "waiting for :$PORT …"
READY=0
for i in $(seq 1 90); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/" 2>/dev/null || true)
  [ "$CODE" = "200" ] && { READY=1; break; }; sleep 1
done
[ "$READY" = "1" ] || { echo "SERVER FAILED TO BOOT"; tail -20 "$LOG"; exit 1; }
echo "server ready (GET / -> 200, waited ${i}s)"

rm -f /tmp/w4a-webhooks.jsonl
(cd "$SCRIPTS" && setsid nohup node header-listener.mjs $LPORT /tmp/w4a-webhooks.jsonl > /tmp/w4a-listener.log 2>&1 < /dev/null &)
sleep 1
echo "header-listener on :$LPORT"

COOKIES=/tmp/w4a-cookies.txt; : > "$COOKIES"
HDRS=/tmp/w4a-hdr.txt; BODY=/tmp/w4a-body.txt

req() { # req <method> <url> [curl args…] — stores status/headers/body
  local method="$1" url="$2"; shift 2
  STATUS=$(curl -s -o "$BODY" -w '%{http_code}' -D "$HDRS" -X "$method" --max-time 60 "$@" "$url" 2>/dev/null || echo 000)
  SETCOOKIE=$(awk 'tolower($1)=="set-cookie:"{sub(/\r$/,"");print $0;exit}' "$HDRS")
  CT=$(awk 'tolower($1)=="content-type:"{sub(/\r$/,"",$2);print $2;exit}' "$HDRS")
}

# ── F-03: session cookie hardening ──────────────────────────────────────────
echo; echo "── F-03 session cookie ──"
req POST "$BASE/api/v1/session" -c "$COOKIES" -b "$COOKIES" -H 'content-type: application/json' --data '{}'
ck "F03 plain status" 200 "$STATUS"
ckc "F03 plain cookie HttpOnly" "$SETCOOKIE" "HttpOnly"
ckc "F03 plain cookie SameSite=Lax" "$SETCOOKIE" "SameSite=Lax"
if contains "$SETCOOKIE" "Secure"; then echo "CHECK [F03 plain no Secure]: FAIL — Secure present over plain HTTP"; FAIL=$((FAIL+1));
else echo "CHECK [F03 plain no Secure]: PASS — no Secure over plain HTTP"; PASS=$((PASS+1)); fi

req POST "$BASE/api/v1/session" -H 'content-type: application/json' -H 'x-forwarded-proto: https' --data '{}'
ck "F03 https status" 200 "$STATUS"
ckc "F03 https cookie Secure" "$SETCOOKIE" "Secure"
ckc "F03 https cookie HttpOnly" "$SETCOOKIE" "HttpOnly"
ckc "F03 https cookie SameSite=Lax" "$SETCOOKIE" "SameSite=Lax"
echo "  Set-Cookie (https): $SETCOOKIE"

req POST "$BASE/api/v1/session" -H 'content-type: application/json' -H 'x-forwarded-proto: http' --data '{}'
if contains "$SETCOOKIE" "Secure"; then echo "CHECK [F03 explicit http no Secure]: FAIL"; FAIL=$((FAIL+1));
else echo "CHECK [F03 explicit http no Secure]: PASS"; PASS=$((PASS+1)); fi

# ── F-02: unmatched /api/v1/* envelope ──────────────────────────────────────
echo; echo "── F-02 unmatched API paths ──"
req GET "$BASE/api/v1/this-route-does-not-exist-w4a" -b "$COOKIES"
ck "F02 GET status" 404 "$STATUS"
ckc "F02 GET content-type" "$CT" "application/json"
ckc "F02 GET code not_found" "$(cat "$BODY")" '"code":"not_found"'
echo "  body: $(cat "$BODY")"

req POST "$BASE/api/v1/nope-also-w4a/deep/path" -b "$COOKIES" -H 'content-type: application/json' --data '{"a":1}'
ck "F02 POST status" 404 "$STATUS"
ckc "F02 POST content-type" "$CT" "application/json"
ckc "F02 POST code not_found" "$(cat "$BODY")" '"code":"not_found"'

req GET "$BASE/api/v1/session"  # matched route control, no cookie
ck "F02 matched control status" 401 "$STATUS"
ckc "F02 matched control content-type" "$CT" "application/json"

# ── F-01: templates idempotency body-fingerprint ────────────────────────────
echo; echo "── F-01 templates ──"
KEY_TPL="w4a-ev-tpl-001"
BODY_TPL='{"name":"w4a evidence template","description":"fingerprint fixture","status":"draft","scenes":[{"name":"scene-one","parameters":{"angle":"front"}}]}'
req POST "$BASE/api/v1/templates" -b "$COOKIES" -H 'content-type: application/json' -H "x-idempotency-key: $KEY_TPL" --data "$BODY_TPL"
ck "F01 create status" 201 "$STATUS"
TPL_ID=$(jq -r '.id' "$BODY" 2>/dev/null); echo "  template id: $TPL_ID"

# replay: same body, REORDERED JSON keys (canonical form must match)
req POST "$BASE/api/v1/templates" -b "$COOKIES" -H 'content-type: application/json' -H "x-idempotency-key: $KEY_TPL" \
  --data '{"status":"draft","description":"fingerprint fixture","name":"w4a evidence template","scenes":[{"parameters":{"angle":"front"},"name":"scene-one"}]}'
ck "F01 replay reordered status" 200 "$STATUS"
ck "F01 replay reordered same id" "$TPL_ID" "$(jq -r '.id' "$BODY" 2>/dev/null)"

# replay: DIFFERENT body → 409 idempotency_conflict
req POST "$BASE/api/v1/templates" -b "$COOKIES" -H 'content-type: application/json' -H "x-idempotency-key: $KEY_TPL" \
  --data '{"name":"w4a evidence template CHANGED","description":"a different payload"}'
ck "F01 conflict status" 409 "$STATUS"
ckc "F01 conflict code" "$(cat "$BODY")" '"code":"idempotency_conflict"'
ckc "F01 conflict message names key" "$(cat "$BODY")" "$KEY_TPL"
ckc "F01 conflict message names fingerprints" "$(cat "$BODY")" 'sha256:'
echo "  body: $(cat "$BODY")"

req GET "$BASE/api/v1/templates/$TPL_ID" -b "$COOKIES"
ck "F01 stored record intact" "w4a evidence template" "$(jq -r '.name' "$BODY" 2>/dev/null)"

# ── F-01: compile job idempotency body-fingerprint ──────────────────────────
echo; echo "── F-01 compile job ──"
req POST "$BASE/api/v1/twins" -b "$COOKIES" -H 'content-type: application/json' --data '{"displayName":"W4A Evidence Twin"}'
ck "F01 twin create" 201 "$STATUS"
TWIN_ID=$(jq -r '.id' "$BODY"); SUBJECT=$(jq -r '.subjectId' "$BODY")
req POST "$BASE/api/v1/consent-grants" -b "$COOKIES" -H 'content-type: application/json' \
  --data "{\"subjectId\":\"$SUBJECT\",\"purpose\":\"w4a evidence compile\",\"scopes\":[\"reconstruct\"],\"ttlHours\":2}"
ck "F01 grant create" 201 "$STATUS"

KEY_CMP="w4a-ev-compile-001"
req POST "$BASE/api/v1/twins/$TWIN_ID/compile" -b "$COOKIES" -H 'content-type: application/json' -H "x-idempotency-key: $KEY_CMP" --data '{"style":"anime"}'
ck "F01 compile create" 202 "$STATUS"
JOB_ID=$(jq -r '.jobId' "$BODY"); echo "  jobId: $JOB_ID"

req POST "$BASE/api/v1/twins/$TWIN_ID/compile" -b "$COOKIES" -H 'content-type: application/json' -H "x-idempotency-key: $KEY_CMP" --data '{"style":"anime"}'
ck "F01 compile replay status" 202 "$STATUS"
ck "F01 compile replay same jobId" "$JOB_ID" "$(jq -r '.jobId' "$BODY" 2>/dev/null)"

req POST "$BASE/api/v1/twins/$TWIN_ID/compile" -b "$COOKIES" -H 'content-type: application/json' -H "x-idempotency-key: $KEY_CMP" --data '{"style":"photorealistic"}'
ck "F01 compile conflict status" 409 "$STATUS"
ckc "F01 compile conflict code" "$(cat "$BODY")" '"code":"idempotency_conflict"'
echo "  body: $(cat "$BODY")"

# ── F-04: signed webhook delivery ───────────────────────────────────────────
echo; echo "── F-04 signed webhook delivery ──"
req POST "$BASE/api/v1/webhooks" -b "$COOKIES" -H 'content-type: application/json' \
  --data "{\"url\":\"http://127.0.0.1:$LPORT/hook\",\"events\":[\"consent.granted\"]}"
ck "F04 webhook register" 201 "$STATUS"
WH_ID=$(jq -r '.id' "$BODY")
if jq -e 'has("secret")' "$BODY" >/dev/null 2>&1; then echo "CHECK [F04 secret not exposed]: FAIL"; FAIL=$((FAIL+1));
else echo "CHECK [F04 secret not exposed]: PASS"; PASS=$((PASS+1)); fi

req POST "$BASE/api/v1/consent-grants" -b "$COOKIES" -H 'content-type: application/json' \
  --data "{\"subjectId\":\"w4a-f04-subject\",\"purpose\":\"w4a signature evidence\",\"scopes\":[\"render\"],\"ttlHours\":1}"
ck "F04 trigger event" 201 "$STATUS"

sleep 4
echo "  listener capture: $(head -c 400 /tmp/w4a-webhooks.jsonl 2>/dev/null || echo '<nothing>')"
VERIFY_OUT=$(cd "$APP" && YOU_APP_DIR="$APP" DATABASE_URL="$DATABASE_URL" node "$SCRIPTS/verify-sig.mjs" /tmp/w4a-webhooks.jsonl "$WH_ID" 2>&1)
echo "$VERIFY_OUT" | sed 's/^/  /'
if echo "$VERIFY_OUT" | rg -q "VERIFY: PASS"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi

req DELETE "$BASE/api/v1/webhooks/$WH_ID" -b "$COOKIES"
ck "F04 webhook cleanup" 204 "$STATUS"

# ── teardown + summary ──────────────────────────────────────────────────────
echo; echo "── server log tail (post-evidence) ──"
tail -8 "$LOG" | sed 's/^/  /'
pkill -f "next dev -p $PORT" 2>/dev/null
pkill -f "header-listener.mjs" 2>/dev/null
echo
echo "═══ W4.A EVIDENCE SUMMARY: PASS=$PASS FAIL=$FAIL ═══"
[ "$FAIL" = "0" ] && exit 0 || exit 1
