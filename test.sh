#!/usr/bin/env bash
set -uo pipefail

DOMAIN="${1:?Usage: $0 <domain> <api-key>}"
API_KEY="${2:?Usage: $0 <domain> <api-key>}"
BASE="${DOMAIN%/}"

# Use same model everywhere — server auto-translates between APIs
MODEL="gpt-4.1"

pass=0
fail=0

run() {
  local name="$1"; shift
  printf "%-45s " "$name..."
  status=$("$@" -o /dev/null -w "%{http_code}" -s)
  if [[ "$status" =~ ^2 ]]; then
    echo "✅ $status"
    ((pass++))
  else
    echo "❌ $status"
    ((fail++))
  fi
}

run_body() {
  local name="$1"; shift
  printf "%-45s " "$name..."
  resp=$(mktemp)
  status=$("$@" -o "$resp" -w "%{http_code}" -s)
  if [[ "$status" =~ ^2 ]]; then
    echo "✅ $status"
    ((pass++))
  else
    echo "❌ $status"
    cat "$resp"
    echo
    ((fail++))
  fi
  rm -f "$resp"
}

echo "=== Testing: $BASE ==="
echo "    Model: $MODEL"
echo

# --- Health check ---
run "GET /" \
  curl "$BASE/"

# --- Models ---
run "GET /v1/models" \
  curl "$BASE/v1/models"

run "GET /api/v1/models" \
  curl "$BASE/api/v1/models"

run "GET /v1/models/:id" \
  curl "$BASE/v1/models/$MODEL"

# --- Auth errors ---
printf "%-45s " "POST /v1/chat/completions (no auth)..."
status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
if [[ "$status" == "401" ]]; then
  echo "✅ $status (expected)"
  ((pass++))
else
  echo "❌ $status (expected 401)"
  ((fail++))
fi

# --- Chat completions (non-streaming) ---
run_body "POST /v1/chat/completions" \
  curl -X POST "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Say hello in one word.\"}],\"stream\":false}"

# --- Chat completions (streaming) ---
printf "%-45s " "POST /v1/chat/completions (stream)..."
resp=$(curl -s -X POST "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Say hi in one word.\"}],\"stream\":true}")
if echo "$resp" | grep -q "data:"; then
  echo "✅ streamed"
  ((pass++))
else
  echo "❌ no stream data"
  echo "$resp" | head -5
  ((fail++))
fi

# --- Chat completions via /api/v1 prefix ---
run_body "POST /api/v1/chat/completions" \
  curl -X POST "$BASE/api/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Say hey in one word.\"}],\"stream\":false}"

# --- Responses (non-streaming) ---
run_body "POST /v1/responses" \
  curl -X POST "$BASE/v1/responses" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d "{\"model\":\"$MODEL\",\"input\":[{\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Say hello in one word.\"}]}],\"stream\":false}"

# --- Responses (streaming) ---
printf "%-45s " "POST /v1/responses (stream)..."
resp=$(curl -s -X POST "$BASE/v1/responses" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d "{\"model\":\"$MODEL\",\"input\":[{\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Say hi in one word.\"}]}],\"stream\":true}")
if echo "$resp" | grep -q "data:"; then
  echo "✅ streamed"
  ((pass++))
else
  echo "❌ no stream data"
  echo "$resp" | head -5
  ((fail++))
fi

# --- Responses via /api/v1 prefix ---
run_body "POST /api/v1/responses" \
  curl -X POST "$BASE/api/v1/responses" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d "{\"model\":\"$MODEL\",\"input\":[{\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Say hey in one word.\"}]}],\"stream\":false}"

# --- Summary ---
echo
echo "=== Results: $pass passed, $fail failed ==="
exit $((fail > 0 ? 1 : 0))
