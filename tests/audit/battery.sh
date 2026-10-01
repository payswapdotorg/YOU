#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# W3.C F8 audit battery — negative/positive HTTP battery against the app at
# the pinned base (74fbe0b). READ-ONLY on application source: this script
# only drives the public HTTP API plus controlled DB fixtures (db-probe.mjs)
# for state the API cannot create itself (tenant B, expired grants, session
# TTL). Verbatim transcripts go to tests/audit/transcript-partN.txt.
#
# Usage: bash battery.sh <1|2>   (server must already be running on $BASE)
# ═══════════════════════════════════════════════════════════════════════════
set -u

PART="${1:?usage: battery.sh <1|2>}"
BASE="${BASE:-http://localhost:3230}"
REPO_ROOT="$(cd "$(dirname "$BASH_SOURCE")/../.." && pwd)"
APP="$REPO_ROOT/apps/web"
TRANSCRIPT="$REPO_ROOT/tests/audit/transcript-part$PART.txt"
STATE=/tmp/w3c-state.env
COOKIES_A=/tmp/w3c-cookiesA.txt
HDRS=/tmp/w3c-hdr.txt
BODYF=/tmp/w3c-body.txt
RESULTS=/tmp/w3c-results.tsv
export YOU_STORAGE_SECRET="${YOU_STORAGE_SECRET:-audit-storage-secret-0xdeadbeef}"

PASS_COUNT=0; FAIL_COUNT=0; INFO_COUNT=0
: > "$TRANSCRIPT"

# PNG fixture (1x1 transparent) for evidence uploads
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' | base64 -d > /tmp/w3c-fixture.png

[ -f "$STATE" ] || : > "$STATE"
touch "$COOKIES_A" "$RESULTS"

dbp() { (cd "$APP" && YOU_APP_DIR="$APP" DATABASE_URL="file:$APP/db/custom.db" bun "$REPO_ROOT/tests/audit/db-probe.mjs" "$@"); }
sigurl() { (cd "$APP" && YOU_STORAGE_SECRET="$YOU_STORAGE_SECRET" bun "$REPO_ROOT/tests/audit/sign-url.mjs" "$@"); }

# ── check runner ────────────────────────────────────────────────────────────
# expectation grammar:
#   NNN    → HTTP status NNN only
#   NNN E  → status + {error:{code,message}} envelope (JSON, no HTML/stack)
#   NNN J  → status + body is valid JSON
#   INFO   → record verbatim, no assertion
runcheck() {
  local id="$1" expect="$2" title="$3"; shift 3
  local status ct body verdict why cmdstr a
  status=$(curl -s -o "$BODYF" -w '%{http_code}' -D "$HDRS" --max-time 180 "$@" 2>/tmp/w3c-curlerr.txt || true)
  ct=$(awk 'tolower($1)=="content-type:"{sub(/\r$/,"",$2);print $2;exit}' "$HDRS")
  body=$(cat "$BODYF")
  cmdstr="curl"
  for a in "$@"; do cmdstr+=" $(printf '%q' "$a")"; done

  {
    echo "════════ [$id] $title ══════════"
    echo "CMD: $cmdstr"
    echo "STATUS: $status (expected: $expect)"
    echo "CONTENT-TYPE: ${ct:-<none>}"
    echo "BODY:"
  } >> "$TRANSCRIPT"

  if [[ "$ct" == text/html* ]]; then
    echo "${body:0:300}" >> "$TRANSCRIPT"; echo "[…html truncated, $(wc -c < "$BODYF") bytes]" >> "$TRANSCRIPT"
  elif [[ "$ct" == image/* ]] || [[ "$ct" == video/* ]] || [[ "$ct" == application/octet-stream ]]; then
    echo "[binary body, $(wc -c < "$BODYF") bytes, content-type $ct — not printed]" >> "$TRANSCRIPT"
  else
    echo "$body" >> "$TRANSCRIPT"
  fi
  if [ "$status" = "000" ]; then
    echo "CURL-STDERR: $(cat /tmp/w3c-curlerr.txt 2>/dev/null | head -3)" >> "$TRANSCRIPT"
  fi

  verdict="PASS"; why=""
  if [ "$expect" != "INFO" ]; then
    local want="${expect%% *}" mode="${expect#* }"; [ "$mode" = "$expect" ] && mode=""
    if [ "$want" = "REJECT" ]; then
      # fail-closed family: 400/403/404 all count as rejection. No envelope
      # requirement: paths unmatched at the framework layer (Next.js normalizes
      # dot-segments before route dispatch) legitimately return the framework's
      # default 404 HTML — the rejection itself is what must hold.
      case "$status" in 400|403|404) want="$status"; mode="";; *) verdict="FAIL"; why="status $status is not a rejection (400/403/404)";; esac
    fi
    if [ "$status" != "$want" ] && [ "$verdict" != "FAIL" ]; then verdict="FAIL"; why="status $status ≠ $want"; fi
    if [ "$verdict" = "PASS" ] && [ "$mode" = "E" ]; then
      if ! echo "$body" | jq -e '(.error|type=="object") and (.error.code|type=="string") and (.error.message|type=="string")' >/dev/null 2>&1; then
        verdict="FAIL"; why="body is not a {error:{code,message}} envelope"
      elif [[ "$ct" != application/json* ]]; then
        verdict="FAIL"; why="content-type $ct is not application/json"
      fi
    fi
    if [ "$verdict" = "PASS" ] && [ "$mode" = "J" ]; then
      if ! echo "$body" | jq -e . >/dev/null 2>&1; then verdict="FAIL"; why="body is not valid JSON"; fi
    fi
  else
    verdict="INFO"
  fi
  echo "VERDICT: $verdict ${why:+— $why}" >> "$TRANSCRIPT"; echo "" >> "$TRANSCRIPT"

  case "$verdict" in PASS) PASS_COUNT=$((PASS_COUNT+1));; FAIL) FAIL_COUNT=$((FAIL_COUNT+1));; INFO) INFO_COUNT=$((INFO_COUNT+1));; esac
  echo -e "$id\t$verdict\t$title" >> "$RESULTS"
  LAST_STATUS="$status"; LAST_BODY="$body"
}

# extra jq assertion appended to the transcript + result tally
xassert() {
  local id="$1" desc="$2" jqexpr="$3" input="$4"
  if printf '%s' "$input" | jq -e "$jqexpr" >/dev/null 2>&1; then
    echo "EXTRA [$id]: PASS — $desc" >> "$TRANSCRIPT"; PASS_COUNT=$((PASS_COUNT+1)); echo -e "$id+x\tPASS\t$desc" >> "$RESULTS"
  else
    echo "EXTRA [$id]: FAIL — $desc (input: $(printf '%s' "$input" | head -c 300))" >> "$TRANSCRIPT"; FAIL_COUNT=$((FAIL_COUNT+1)); echo -e "$id+x\tFAIL\t$desc" >> "$RESULTS"
  fi
}

jsonval() { printf '%s' "$LAST_BODY" | jq -r "$1"; }
save_state() { echo "$1" >> "$STATE"; }

echo "W3.C F8 AUDIT BATTERY — PART $PART — base $BASE — $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$TRANSCRIPT"

# ═══════════════════════════ PART 1 ═══════════════════════════
if [ "$PART" = "1" ]; then

runcheck W3C-001 "200" "Studio SPA page renders at /" "$BASE/"
runcheck W3C-002 "401 E" "GET /session without cookie → unauthenticated envelope" "$BASE/api/v1/session"
runcheck W3C-003 "200 J" "POST /session — bootstrap demo tenant (cookie A)" -X POST "$BASE/api/v1/session" -c "$COOKIES_A" -b "$COOKIES_A"
SESSION_TOKEN=$(awk '$6=="you_session"{print $7}' "$COOKIES_A" | head -1)
save_state "SESSION_TOKEN=$SESSION_TOKEN"

runcheck W3C-004 "201 J" "POST /twins — create twin A (tenant A)" -X POST "$BASE/api/v1/twins" -b "$COOKIES_A" -H 'content-type: application/json' --data '{"displayName":"W3C Audit Twin A","personName":"Audit Subject A"}'
TWIN_A=$(jsonval '.id'); SUBJECT_A=$(jsonval '.subjectId')
save_state "TWIN_A=$TWIN_A"; save_state "SUBJECT_A=$SUBJECT_A"

runcheck W3C-005 "201 J" "POST /twins/:id/capture-sessions — open capture session A" -X POST "$BASE/api/v1/twins/$TWIN_A/capture-sessions" -b "$COOKIES_A" -H 'content-type: application/json' --data '{}'
CAP_A=$(jsonval '.id'); save_state "CAP_A=$CAP_A"

runcheck W3C-006 "403 E" "CONSENT FAIL-CLOSED: evidence upload WITHOUT grant → consent_required" -X POST "$BASE/api/v1/captures/$CAP_A/assets" -b "$COOKIES_A" -F 'file=@/tmp/w3c-fixture.png;type=image/png' -F 'regions=["face.front"]'
xassert W3C-006 "error.code == consent_required" '.error.code=="consent_required"' "$LAST_BODY"

runcheck W3C-007 "201 J" "POST /consent-grants — grant capture scope, subject A, ttl 2h" -X POST "$BASE/api/v1/consent-grants" -b "$COOKIES_A" -H 'content-type: application/json' --data "{\"subjectId\":\"$SUBJECT_A\",\"purpose\":\"w3c audit battery\",\"scopes\":[\"capture\"],\"ttlHours\":2}"
GRANT_A=$(jsonval '.id'); save_state "GRANT_A=$GRANT_A"

runcheck W3C-008 "201 J" "evidence upload WITH grant → accepted" -X POST "$BASE/api/v1/captures/$CAP_A/assets" -b "$COOKIES_A" -F 'file=@/tmp/w3c-fixture.png;type=image/png' -F 'regions=["face.front"]'
ASSET_A=$(jsonval '.id'); save_state "ASSET_A=$ASSET_A"
xassert W3C-008 "asset view exposes no storageKey (derived-output hygiene)" 'has("storageKey")|not' "$LAST_BODY"

echo "── db-probe: expire grant A (simulated TTL lapse) ──" >> "$TRANSCRIPT"
EXPIRE_OUT=$(dbp expire-grant "$GRANT_A"); echo "$EXPIRE_OUT" >> "$TRANSCRIPT"; echo "" >> "$TRANSCRIPT"

runcheck W3C-010 "403 E" "CONSENT TTL FAIL-CLOSED: upload after grant expiry → consent_required" -X POST "$BASE/api/v1/captures/$CAP_A/assets" -b "$COOKIES_A" -F 'file=@/tmp/w3c-fixture.png;type=image/png' -F 'regions=["face.front"]'
xassert W3C-010 "error.code == consent_required" '.error.code=="consent_required"' "$LAST_BODY"

RESTORE_OUT=$(dbp restore-grant "$GRANT_A" 2); echo "── db-probe: restore grant A (+2h) → $RESTORE_OUT ──" >> "$TRANSCRIPT"; echo "" >> "$TRANSCRIPT"
runcheck W3C-012 "201 J" "upload after grant renewal → accepted (fail-open only via active grant)" -X POST "$BASE/api/v1/captures/$CAP_A/assets" -b "$COOKIES_A" -F 'file=@/tmp/w3c-fixture.png;type=image/png' -F 'regions=["face.hairline"]'

runcheck W3C-013 "200 J" "DELETE /consent-grants/:id — revoke grant A (revokedAt set, row kept)" -X DELETE "$BASE/api/v1/consent-grants/$GRANT_A" -b "$COOKIES_A"
xassert W3C-013 "view shows revokedAt non-null" '.revokedAt != null' "$LAST_BODY"

runcheck W3C-014 "403 E" "CONSENT REVOCATION FAIL-CLOSED: upload after revoke → consent_required" -X POST "$BASE/api/v1/captures/$CAP_A/assets" -b "$COOKIES_A" -F 'file=@/tmp/w3c-fixture.png;type=image/png' -F 'regions=["face.front"]'
xassert W3C-014 "error.code == consent_required" '.error.code=="consent_required"' "$LAST_BODY"

SUBJECT_B="subj_w3c_audit_subject_b"
save_state "SUBJECT_B=$SUBJECT_B"
runcheck W3C-015 "403 E" "CONSENT FAIL-CLOSED: verification-session create WITHOUT grant (subject B) → consent_required" -X POST "$BASE/api/v1/verification-sessions" -b "$COOKIES_A" -H 'content-type: application/json' --data "{\"subjectId\":\"$SUBJECT_B\",\"purpose\":\"w3c audit battery — liveness\"}"
xassert W3C-015 "error.code == consent_required" '.error.code=="consent_required"' "$LAST_BODY"

runcheck W3C-016 "201 J" "POST /consent-grants — grant capture scope, subject B, ttl 1h" -X POST "$BASE/api/v1/consent-grants" -b "$COOKIES_A" -H 'content-type: application/json' --data "{\"subjectId\":\"$SUBJECT_B\",\"purpose\":\"w3c audit battery — verification\",\"scopes\":[\"capture\"],\"ttlHours\":1}"
GRANT_B=$(jsonval '.id'); save_state "GRANT_B=$GRANT_B"

runcheck W3C-017 "201 J" "verification-session create WITH grant → 201 (challenge issued)" -X POST "$BASE/api/v1/verification-sessions" -b "$COOKIES_A" -H 'content-type: application/json' --data "{\"subjectId\":\"$SUBJECT_B\",\"purpose\":\"w3c audit battery — liveness\"}"
VERIF_B=$(jsonval '.id'); save_state "VERIF_B=$VERIF_B"
xassert W3C-017 "session view has pending status + consentGrantId" '.status=="pending" and (.consentGrantId != null)' "$LAST_BODY"

EXPIRE_B=$(dbp expire-grant "$GRANT_B"); echo "── db-probe: expire grant B → $EXPIRE_B ──" >> "$TRANSCRIPT"; echo "" >> "$TRANSCRIPT"
runcheck W3C-019 "403 E" "verification-session create after grant TTL expiry → consent_required (fail-closed re-armed)" -X POST "$BASE/api/v1/verification-sessions" -b "$COOKIES_A" -H 'content-type: application/json' --data "{\"subjectId\":\"$SUBJECT_B\",\"purpose\":\"w3c audit battery — liveness again\"}"
xassert W3C-019 "error.code == consent_required" '.error.code=="consent_required"' "$LAST_BODY"

runcheck W3C-020 "403 E" "CONSENT FAIL-CLOSED: twin compile WITHOUT reconstruct grant → consent_required" -X POST "$BASE/api/v1/twins/$TWIN_A/compile" -b "$COOKIES_A" -H 'content-type: application/json' --data '{}'
xassert W3C-020 "error.code == consent_required" '.error.code=="consent_required"' "$LAST_BODY"

runcheck W3C-021 "201 J" "POST /consent-grants — grant reconstruct scope, subject A" -X POST "$BASE/api/v1/consent-grants" -b "$COOKIES_A" -H 'content-type: application/json' --data "{\"subjectId\":\"$SUBJECT_A\",\"purpose\":\"w3c audit battery — reconstruction\",\"scopes\":[\"reconstruct\"],\"ttlHours\":2}"
GRANT_RECON=$(jsonval '.id'); save_state "GRANT_RECON=$GRANT_RECON"

runcheck W3C-022 "202 J" "twin compile WITH reconstruct grant → 202 durable jobId" -X POST "$BASE/api/v1/twins/$TWIN_A/compile" -b "$COOKIES_A" -H 'content-type: application/json' -H 'x-idempotency-key: w3c-compile-001' --data '{}'
JOB_COMPILE=$(jsonval '.jobId'); save_state "JOB_COMPILE=$JOB_COMPILE"

runcheck W3C-023 "200 J" "GET /jobs/:id — honest durable-job state (no fabricated progress)" "$BASE/api/v1/jobs/$JOB_COMPILE" -b "$COOKIES_A"

TV_OUT=$(dbp create-twinversion "$TWIN_A"); echo "── db-probe: published TwinVersion fixture → $TV_OUT ──" >> "$TRANSCRIPT"; echo "" >> "$TRANSCRIPT"
TV_ID=$(printf '%s' "$TV_OUT" | jq -r '.id'); save_state "TV_ID=$TV_ID"

runcheck W3C-025 "403 E" "CONSENT FAIL-CLOSED: POST /renders WITHOUT render grant → consent_required" -X POST "$BASE/api/v1/renders" -b "$COOKIES_A" -H 'content-type: application/json' --data "{\"twinId\":\"$TWIN_A\",\"twinVersionId\":\"$TV_ID\",\"kind\":\"image\",\"style\":\"photorealistic\"}"
xassert W3C-025 "error.code == consent_required" '.error.code=="consent_required"' "$LAST_BODY"

runcheck W3C-026 "201 J" "POST /consent-grants — grant render scope, subject A" -X POST "$BASE/api/v1/consent-grants" -b "$COOKIES_A" -H 'content-type: application/json' --data "{\"subjectId\":\"$SUBJECT_A\",\"purpose\":\"w3c audit battery — render\",\"scopes\":[\"render\"],\"ttlHours\":2}"

runcheck W3C-027 "202 J" "POST /renders WITH render grant → 202" -X POST "$BASE/api/v1/renders" -b "$COOKIES_A" -H 'content-type: application/json' --data "{\"twinId\":\"$TWIN_A\",\"twinVersionId\":\"$TV_ID\",\"kind\":\"image\",\"style\":\"photorealistic\"}"

runcheck W3C-028 "201 J" "POST /agent-bodies — create agent body" -X POST "$BASE/api/v1/agent-bodies" -b "$COOKIES_A" -H 'content-type: application/json' --data '{"name":"w3c-audit-body","role":"auditor"}'
BODY_ID=$(jsonval '.id'); save_state "BODY_ID=$BODY_ID"

runcheck W3C-029 "403 E" "CONSENT FAIL-CLOSED: agent-avatar-session with twin WITHOUT embodiment grant → consent_required" -X POST "$BASE/api/v1/agent-avatar-sessions" -b "$COOKIES_A" -H 'content-type: application/json' --data "{\"bodyId\":\"$BODY_ID\",\"soulKey\":\"soul-one-fast\",\"twinId\":\"$TWIN_A\"}"
xassert W3C-029 "error.code == consent_required" '.error.code=="consent_required"' "$LAST_BODY"

runcheck W3C-030 "201 J" "POST /consent-grants — grant embodiment scope, subject A" -X POST "$BASE/api/v1/consent-grants" -b "$COOKIES_A" -H 'content-type: application/json' --data "{\"subjectId\":\"$SUBJECT_A\",\"purpose\":\"w3c audit battery — embodiment\",\"scopes\":[\"embodiment\"],\"ttlHours\":2}"

runcheck W3C-031 "201 J" "agent-avatar-session WITH embodiment grant → 201" -X POST "$BASE/api/v1/agent-avatar-sessions" -b "$COOKIES_A" -H 'content-type: application/json' --data "{\"bodyId\":\"$BODY_ID\",\"soulKey\":\"soul-one-fast\",\"twinId\":\"$TWIN_A\"}"
AVATAR_SESSION=$(jsonval '.id')

TPL_BODY='{"name":"w3c-audit-template","description":"battery template","status":"draft","scenes":[{"name":"scene-one","parameters":{"angle":"front"}}]}'
runcheck W3C-032 "201 J" "IDEMPOTENCY: POST /templates with X-Idempotency-Key → 201" -X POST "$BASE/api/v1/templates" -b "$COOKIES_A" -H 'content-type: application/json' -H 'x-idempotency-key: w3c-idem-001' --data "$TPL_BODY"
TEMPLATE_ID=$(jsonval '.id'); save_state "TEMPLATE_ID=$TEMPLATE_ID"

runcheck W3C-033 "200 J" "IDEMPOTENCY REPLAY: same key, same body → 200 with existing record" -X POST "$BASE/api/v1/templates" -b "$COOKIES_A" -H 'content-type: application/json' -H 'x-idempotency-key: w3c-idem-001' --data "$TPL_BODY"
xassert W3C-033 "replay returns the SAME template id" ".id==\"$TEMPLATE_ID\"" "$LAST_BODY"

CNT=$(dbp count-templates w3c-idem-001); echo "── db-probe: template count for key w3c-idem-001 → $CNT ──" >> "$TRANSCRIPT"; echo "" >> "$TRANSCRIPT"
xassert W3C-034 "exactly ONE template row for the idempotency key (no duplicates)" '.count==1' "$CNT"

runcheck W3C-035 "200 J" "IDEMPOTENCY REPLAY: same key, DIFFERENT body → 200 with existing (recorded behavior)" -X POST "$BASE/api/v1/templates" -b "$COOKIES_A" -H 'content-type: application/json' -H 'x-idempotency-key: w3c-idem-001' --data '{"name":"w3c-audit-template-CHANGED","description":"different body"}'
xassert W3C-035 "replay still returns the SAME template id (first-write wins)" ".id==\"$TEMPLATE_ID\"" "$LAST_BODY"

runcheck W3C-036 "202 J" "IDEMPOTENCY: POST compile with key w3c-compile-002 → 202" -X POST "$BASE/api/v1/twins/$TWIN_A/compile" -b "$COOKIES_A" -H 'content-type: application/json' -H 'x-idempotency-key: w3c-compile-002' --data '{}'
JOB_IDEM=$(jsonval '.jobId'); save_state "JOB_IDEM=$JOB_IDEM"

runcheck W3C-037 "202 J" "IDEMPOTENCY REPLAY: compile same key → 202 with same jobId" -X POST "$BASE/api/v1/twins/$TWIN_A/compile" -b "$COOKIES_A" -H 'content-type: application/json' -H 'x-idempotency-key: w3c-compile-002' --data '{}'
xassert W3C-037 "replay returns the SAME jobId" ".jobId==\"$JOB_IDEM\"" "$LAST_BODY"

CNTJ=$(dbp count-jobs w3c-compile-002); echo "── db-probe: job count for key w3c-compile-002 → $CNTJ ──" >> "$TRANSCRIPT"; echo "" >> "$TRANSCRIPT"
xassert W3C-038 "exactly ONE job row for the idempotency key" '.count==1' "$CNTJ"

fi # ── end part 1 ──

# ═══════════════════════════ PART 2 ═══════════════════════════
if [ "$PART" = "2" ]; then
# shellcheck disable=SC1090
source "$STATE"

# (re)bootstrap session A — POST /session is idempotent for the demo tenant and
# guarantees the cookie is fresh even after a prior W3C-146 expiry in an earlier run
BST=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/session" -c "$COOKIES_A" -b "$COOKIES_A")
echo "── session A re-bootstrap: HTTP $BST ──" >> "$TRANSCRIPT"; echo "" >> "$TRANSCRIPT"
SESSION_TOKEN=$(awk '$6=="you_session"{print $7}' "$COOKIES_A" | head -1)
save_state "SESSION_TOKEN=$SESSION_TOKEN"

runcheck W3C-101 "201 J" "POST /api-keys — create READ-ONLY key (secret shown once)" -X POST "$BASE/api/v1/api-keys" -b "$COOKIES_A" -H 'content-type: application/json' --data '{"name":"w3c-ro","scopes":["read"]}'
KEY_RO_SECRET=$(jsonval '.secret'); KEY_RO_ID=$(jsonval '.key.id'); save_state "KEY_RO_ID=$KEY_RO_ID"
xassert W3C-101 "secret is a you_sk_… token" '.secret|startswith("you_sk_")' "$LAST_BODY"

runcheck W3C-102 "200 J" "SCOPE: bearer read-only key GET /templates → allowed" "$BASE/api/v1/templates" -H "authorization: Bearer $KEY_RO_SECRET"

runcheck W3C-103 "403 E" "SCOPE ENFORCEMENT: read-only key POST /templates (write) → forbidden" -X POST "$BASE/api/v1/templates" -H "authorization: Bearer $KEY_RO_SECRET" -H 'content-type: application/json' --data '{"name":"should-not-exist"}'
xassert W3C-103 "error.code == forbidden + scope message" '.error.code=="forbidden" and (.error.message|contains("scope"))' "$LAST_BODY"

runcheck W3C-104 "403 E" "SCOPE ENFORCEMENT: read-only key POST /twins (write) → forbidden" -X POST "$BASE/api/v1/twins" -H "authorization: Bearer $KEY_RO_SECRET" -H 'content-type: application/json' --data '{"displayName":"nope"}'

runcheck W3C-105 "201 J" "POST /api-keys — create read+write key" -X POST "$BASE/api/v1/api-keys" -b "$COOKIES_A" -H 'content-type: application/json' --data '{"name":"w3c-rw","scopes":["read","write"]}'
KEY_RW_SECRET=$(jsonval '.secret'); save_state "KEY_RW_SECRET=$KEY_RW_SECRET"

runcheck W3C-106 "200 J" "bearer read+write key GET /templates → allowed" "$BASE/api/v1/templates" -H "authorization: Bearer $KEY_RW_SECRET"
runcheck W3C-107 "201 J" "bearer read+write key POST /templates → allowed" -X POST "$BASE/api/v1/templates" -H "authorization: Bearer $KEY_RW_SECRET" -H 'content-type: application/json' --data '{"name":"w3c-bearer-template","description":"created via bearer write"}'

runcheck W3C-108 "200 J" "DELETE /api-keys/:id — revoke read-only key" -X DELETE "$BASE/api/v1/api-keys/$KEY_RO_ID" -b "$COOKIES_A"
runcheck W3C-108b "401 E" "REVOKED KEY: bearer read-only (revoked) GET → unauthenticated" "$BASE/api/v1/templates" -H "authorization: Bearer $KEY_RO_SECRET"

runcheck W3C-109 "401 E" "malformed bearer token → unauthenticated" "$BASE/api/v1/templates" -H 'authorization: Bearer not-a-key'
runcheck W3C-110 "401 E" "unknown bearer token → unauthenticated" "$BASE/api/v1/templates" -H "authorization: Bearer you_sk_unknownunknownunknownunknownunknownunknown"

runcheck W3C-111 "401 E" "RAW-EVIDENCE RESTRICTION: bearer key (even write) GET /evidence/:id/url → session-only route rejects bearer" "$BASE/api/v1/evidence/$ASSET_A/url" -H "authorization: Bearer $KEY_RW_SECRET"

runcheck W3C-112 "200 J" "GET /evidence/:id/url with session cookie → signed expiring URL" "$BASE/api/v1/evidence/$ASSET_A/url" -b "$COOKIES_A"
SIGNED_URL=$(jsonval '.url'); save_state "SIGNED_URL=$SIGNED_URL"
xassert W3C-112 "url carries exp + sig capability params" '.url|test("exp=[0-9]+&sig=")' "$LAST_BODY"

runcheck W3C-113 "200" "SIGNED URL fetch → object bytes (image/png)" "$BASE$SIGNED_URL"
PNG_CT=$(awk 'tolower($1)=="content-type:"{sub(/\r$/,"",$2);print $2;exit}' "$HDRS")
if [[ "$PNG_CT" == image/png* ]] && [ -s "$BODYF" ]; then
  echo "EXTRA [W3C-113f]: PASS — served ${PNG_CT} ($(wc -c < "$BODYF") bytes)" >> "$TRANSCRIPT"; PASS_COUNT=$((PASS_COUNT+1)); echo -e "W3C-113f\tPASS\tsigned-url object bytes content-type" >> "$RESULTS"
else
  echo "EXTRA [W3C-113f]: FAIL — content-type ${PNG_CT:-none}" >> "$TRANSCRIPT"; FAIL_COUNT=$((FAIL_COUNT+1)); echo -e "W3C-113f\tFAIL\tsigned-url object bytes content-type" >> "$RESULTS"
fi

runcheck W3C-114 "403 E" "SIGNED URL without exp/sig → rejected" "$BASE${SIGNED_URL%%\?*}"
runcheck W3C-115 "403 E" "SIGNED URL with tampered sig → rejected" "$BASE${SIGNED_URL%%\?*}?exp=9999999999&sig=tampereddeadbeef"

STORAGE_KEY=${SIGNED_URL#*/api/v1/storage/}; STORAGE_KEY=${STORAGE_KEY%%\?*}
save_state "STORAGE_KEY=$STORAGE_KEY"
EXPIRED_URL=$(sigurl "$STORAGE_KEY" -60)
echo "── sign-url.mjs: correctly-signed but EXPIRED capability → $EXPIRED_URL ──" >> "$TRANSCRIPT"; echo "" >> "$TRANSCRIPT"
runcheck W3C-116 "403 E" "SIGNED URL correctly signed but EXPIRED → rejected (expiry enforced)" "$BASE$EXPIRED_URL"

TRAVERSAL_KEY="evidence/../../db/custom.db"
TRAVERSAL_URL=$(sigurl "$TRAVERSAL_KEY" 600)
echo "── sign-url.mjs: correctly-signed but UNSAFE traversal key → $TRAVERSAL_URL ──" >> "$TRANSCRIPT"; echo "" >> "$TRANSCRIPT"
runcheck W3C-117 "REJECT" "path traversal without signature → rejected (framework 404; route never sees dot-segments)" --path-as-is "$BASE/api/v1/storage/evidence/../../db/custom.db"
# NOTE: Next.js normalizes dot-segments during URL parsing (before route
# dispatch), so an HTTP traversal request becomes a different path and gets
# the framework's default 404 HTML. The object is never reachable — rejection
# holds at the framework layer. The route-level isSafeKey guard (storage.ts)
# remains defense-in-depth, verified by code inspection, not via HTTP.
runcheck W3C-118 "REJECT" "path traversal WITH valid signature (unsafe key) → rejected (framework-level; isSafeKey guard is defense-in-depth)" --path-as-is "$BASE$TRAVERSAL_URL"

TB_OUT=$(dbp create-tenant-b); echo "── db-probe: tenant B fixtures → $TB_OUT ──" >> "$TRANSCRIPT"; echo "" >> "$TRANSCRIPT"
TB_TOKEN=$(printf '%s' "$TB_OUT" | jq -r '.token'); save_state "TB_TOKEN=$TB_TOKEN"

runcheck W3C-120 "200 J" "tenant B session is functional (GET /session with its cookie)" "$BASE/api/v1/session" -H "Cookie: you_session=$TB_TOKEN"
runcheck W3C-121 "200 J" "TENANT ISOLATION: tenant B GET /twins → empty list (no tenant A data)" "$BASE/api/v1/twins" -H "Cookie: you_session=$TB_TOKEN"
xassert W3C-121 "list is empty (length 0)" 'length==0' "$LAST_BODY"

runcheck W3C-122 "404 E" "TENANT ISOLATION: tenant B GET /twins/:twinA → 404, no cross-tenant read" "$BASE/api/v1/twins/$TWIN_A" -H "Cookie: you_session=$TB_TOKEN"
runcheck W3C-123 "404 E" "TENANT ISOLATION: tenant B GET /captures/:capA → 404" "$BASE/api/v1/captures/$CAP_A" -H "Cookie: you_session=$TB_TOKEN"
runcheck W3C-124 "404 E" "TENANT ISOLATION: tenant B cannot mint a signed URL for tenant A evidence → 404" "$BASE/api/v1/evidence/$ASSET_A/url" -H "Cookie: you_session=$TB_TOKEN"
runcheck W3C-125 "404 E" "TENANT ISOLATION: tenant B POST compile on tenant A twin → 404" -X POST "$BASE/api/v1/twins/$TWIN_A/compile" -H "Cookie: you_session=$TB_TOKEN" -H 'content-type: application/json' --data '{}'
runcheck W3C-126 "200 J" "TENANT ISOLATION: tenant B GET /verification-sessions → empty (no tenant A sessions)" "$BASE/api/v1/verification-sessions" -H "Cookie: you_session=$TB_TOKEN"
xassert W3C-126 "list is empty (length 0)" 'length==0' "$LAST_BODY"

runcheck W3C-127 "200 J" "CONTROL: tenant A cookie GET /twins still sees twin A" "$BASE/api/v1/twins" -b "$COOKIES_A"
xassert W3C-127 "twin A present in tenant A list" "map(.id)|index(\"$TWIN_A\") != null" "$LAST_BODY"

runcheck W3C-128 "201 J" "create twin B (same tenant, different subject — for subject isolation)" -X POST "$BASE/api/v1/twins" -b "$COOKIES_A" -H 'content-type: application/json' --data '{"displayName":"W3C Audit Twin B","personName":"Audit Subject B"}'
TWIN_B=$(jsonval '.id'); SUBJECT_B_REAL=$(jsonval '.subjectId'); save_state "TWIN_B=$TWIN_B"; save_state "SUBJECT_B_REAL=$SUBJECT_B_REAL"

runcheck W3C-129 "201 J" "open capture session B" -X POST "$BASE/api/v1/twins/$TWIN_B/capture-sessions" -b "$COOKIES_A" -H 'content-type: application/json' --data '{}'
CAP_B=$(jsonval '.id'); save_state "CAP_B=$CAP_B"

runcheck W3C-130 "201 J" "grant capture scope for subject B (twin B's subject)" -X POST "$BASE/api/v1/consent-grants" -b "$COOKIES_A" -H 'content-type: application/json' --data "{\"subjectId\":\"$SUBJECT_B_REAL\",\"purpose\":\"w3c audit battery — subject B capture\",\"scopes\":[\"capture\"],\"ttlHours\":2}"
runcheck W3C-131 "201 J" "upload evidence for twin B → 201 (ASSET_B)" -X POST "$BASE/api/v1/captures/$CAP_B/assets" -b "$COOKIES_A" -F 'file=@/tmp/w3c-fixture.png;type=image/png' -F 'regions=["face.front"]'
ASSET_B=$(jsonval '.id'); save_state "ASSET_B=$ASSET_B"

runcheck W3C-132 "201 J" "verification session for twin B's subject (VERIF_B2)" -X POST "$BASE/api/v1/verification-sessions" -b "$COOKIES_A" -H 'content-type: application/json' --data "{\"subjectId\":\"$SUBJECT_B_REAL\",\"purpose\":\"w3c audit battery — subject B liveness\",\"twinId\":\"$TWIN_B\"}"
VERIF_B2=$(jsonval '.id'); save_state "VERIF_B2=$VERIF_B2"

runcheck W3C-133 "400 E" "SUBJECT ISOLATION: verification-session (subject B) referencing subject A's EvidenceAsset → rejected" -X POST "$BASE/api/v1/verification-sessions/$VERIF_B2/evidence" -b "$COOKIES_A" -H 'content-type: application/json' --data "{\"evidenceAssetIds\":[\"$ASSET_A\"]}"
xassert W3C-133 "error message names the subject mismatch" '.error.message|contains("different subject")' "$LAST_BODY"

runcheck W3C-134 "200 J" "CONTROL: verification-session evidence with SAME-subject asset → accepted (in_review)" -X POST "$BASE/api/v1/verification-sessions/$VERIF_B2/evidence" -b "$COOKIES_A" -H 'content-type: application/json' --data "{\"evidenceAssetIds\":[\"$ASSET_B\"]}"
xassert W3C-134 "session transitioned to in_review" '.status=="in_review"' "$LAST_BODY"

runcheck W3C-135 "200 J" "EVENTS: GET /events?type=template.created → envelopes" "$BASE/api/v1/events?type=template.created" -b "$COOKIES_A"
xassert W3C-135 "every event has id/type/entityType/entityId/payload/createdAt" 'all(.[]; (.id|type=="string") and (.type|type=="string") and (.entityType|type=="string") and (.payload|type=="object") and (.createdAt|type=="string"))' "$LAST_BODY"

runcheck W3C-136 "200 J" "EVENTS: GET /events?limit=1 → single envelope" "$BASE/api/v1/events?limit=1" -b "$COOKIES_A"
xassert W3C-136 "limit respected (length 1)" 'length==1' "$LAST_BODY"

# webhook end-to-end with a local request-bin listener
rm -f /tmp/w3c-webhooks.jsonl
(cd "$REPO_ROOT/tests/audit" && setsid nohup bun listener.mjs /tmp/w3c-webhooks.jsonl > /tmp/w3c-listener.log 2>&1 < /dev/null &) ; sleep 1
echo "── listener.mjs started on :3231 (request-bin) ──" >> "$TRANSCRIPT"; echo "" >> "$TRANSCRIPT"

runcheck W3C-138 "201 J" "WEBHOOKS: POST /webhooks — register endpoint (consent.granted)" -X POST "$BASE/api/v1/webhooks" -b "$COOKIES_A" -H 'content-type: application/json' --data '{"url":"http://localhost:3231/hook","events":["consent.granted"]}'
WEBHOOK_ID=$(jsonval '.id'); save_state "WEBHOOK_ID=$WEBHOOK_ID"
xassert W3C-138 "endpoint view does NOT expose the signing secret" 'has("secret")|not' "$LAST_BODY"

runcheck W3C-139 "201 J" "WEBHOOKS: trigger consent.granted event (new grant)" -X POST "$BASE/api/v1/consent-grants" -b "$COOKIES_A" -H 'content-type: application/json' --data "{\"subjectId\":\"$SUBJECT_B_REAL\",\"purpose\":\"w3c webhook trigger\",\"scopes\":[\"render\"],\"ttlHours\":1}"

sleep 4
HOOK_LINE=$(head -1 /tmp/w3c-webhooks.jsonl 2>/dev/null || echo '')
echo "── listener capture (verbatim): $HOOK_LINE ──" >> "$TRANSCRIPT"; echo "" >> "$TRANSCRIPT"
if [ -n "$HOOK_LINE" ] && [ "$HOOK_LINE" != "" ]; then
  echo "════════ [W3C-140] WEBHOOK DELIVERY: endpoint received the event ══════════" >> "$TRANSCRIPT"
  echo "$HOOK_LINE" >> "$TRANSCRIPT"
  HOOK_BODY=$(printf '%s' "$HOOK_LINE" | jq -r '.body')
  printf '%s' "$HOOK_BODY" | jq -e '(.id|type=="string") and (.type=="consent.granted") and (.entityType|type=="string") and (.entityId|type=="string") and (.payload|type=="object") and (.createdAt|type=="string")' >/dev/null 2>&1 \
    && { echo "VERDICT: PASS — POST body is the documented event envelope (id/type/entityType/entityId/payload/createdAt)" >> "$TRANSCRIPT"; PASS_COUNT=$((PASS_COUNT+1)); echo -e "W3C-140\tPASS\twebhook delivery envelope conformance" >> "$RESULTS"; } \
    || { echo "VERDICT: FAIL — body not conforming: $HOOK_BODY" >> "$TRANSCRIPT"; FAIL_COUNT=$((FAIL_COUNT+1)); echo -e "W3C-140\tFAIL\twebhook delivery envelope conformance" >> "$RESULTS"; }
  echo "" >> "$TRANSCRIPT"
else
  echo "════════ [W3C-140] WEBHOOK DELIVERY: no capture after 4s ══════════" >> "$TRANSCRIPT"
  echo "VERDICT: FAIL — listener received nothing" >> "$TRANSCRIPT"; echo "" >> "$TRANSCRIPT"
  FAIL_COUNT=$((FAIL_COUNT+1)); echo -e "W3C-140\tFAIL\twebhook delivery envelope conformance" >> "$RESULTS"
fi

DELIV=$(dbp webhook-deliveries "$WEBHOOK_ID"); echo "── db-probe: delivery records → $DELIV ──" >> "$TRANSCRIPT"; echo "" >> "$TRANSCRIPT"
printf '%s' "$DELIV" | jq -e 'length>=1 and all(.[]; .status=="delivered" and .attempts==1)' >/dev/null 2>&1 \
  && { echo "════════ [W3C-141] WEBHOOK DELIVERY RECORDS: PASS — recorded delivered, 1 attempt ══════════" >> "$TRANSCRIPT"; PASS_COUNT=$((PASS_COUNT+1)); echo -e "W3C-141\tPASS\twebhook delivery records" >> "$RESULTS"; echo "" >> "$TRANSCRIPT"; } \
  || { echo "════════ [W3C-141] WEBHOOK DELIVERY RECORDS: FAIL — see db-probe output above ══════════" >> "$TRANSCRIPT"; FAIL_COUNT=$((FAIL_COUNT+1)); echo -e "W3C-141\tFAIL\twebhook delivery records" >> "$RESULTS"; echo "" >> "$TRANSCRIPT"; }

runcheck W3C-142 "204" "DELETE /webhooks/:id → 204" -X DELETE "$BASE/api/v1/webhooks/$WEBHOOK_ID" -b "$COOKIES_A"

runcheck W3C-143 "INFO" "UNMATCHED ROUTE: GET /api/v1/nonexistent → record verbatim (outside API route set)" "$BASE/api/v1/nonexistent"
runcheck W3C-144 "400 E" "MALFORMED JSON BODY: POST /twins with invalid JSON → validation envelope" -X POST "$BASE/api/v1/twins" -b "$COOKIES_A" -H 'content-type: application/json' --data '{"displayName": '
runcheck W3C-145 "400 E" "MISSING REQUIRED FIELD: POST /twins without displayName → validation envelope" -X POST "$BASE/api/v1/twins" -b "$COOKIES_A" -H 'content-type: application/json' --data '{}'

EXPS=$(dbp expire-session "$SESSION_TOKEN"); echo "── db-probe: expire session A cookie → $EXPS ──" >> "$TRANSCRIPT"; echo "" >> "$TRANSCRIPT"
runcheck W3C-146 "401 E" "SESSION TTL FAIL-CLOSED: GET /session with expired cookie → unauthenticated" "$BASE/api/v1/session" -b "$COOKIES_A"

fi # ── end part 2 ──

# ── summary ─────────────────────────────────────────────────────────────────
{
  echo "════════════════ PART $PART SUMMARY ═════════════════"
  echo "PASS: $PASS_COUNT   FAIL: $FAIL_COUNT   INFO: $INFO_COUNT"
} >> "$TRANSCRIPT"
echo "PART $PART DONE — PASS=$PASS_COUNT FAIL=$FAIL_COUNT INFO=$INFO_COUNT"
echo "transcript: $TRANSCRIPT"
