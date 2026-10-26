#!/usr/bin/env bash
set -euo pipefail
BASE="${BASE:-http://localhost:8787}"
SECRET="${UI_SHARED_SECRET:?Set UI_SHARED_SECRET}"
RUN_ID="${RUN_ID:-}"

echo "1. health"
curl -s "$BASE/health"
echo

echo "2. mint token"
curl -s -X POST "$BASE/token" -H "Authorization: Bearer $SECRET" | head -c 500
echo

if [ -n "$RUN_ID" ]; then
  echo "3. run $RUN_ID status"
  curl -s "$BASE/run/$RUN_ID" -H "Authorization: Bearer $SECRET" | head -c 500
  echo
fi
