#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${WBK_APPROVAL_REPO:-dyyz1993/xbrowser}"
BRANCH="${WBK_APPROVAL_BRANCH:-codex/approval-e2e-noop}"
GATE="${WBK_APPROVAL_GATE:-https://approve.xbrowser.dev}"
ENVIRONMENT="${WBK_APPROVAL_ENVIRONMENT:-production}"
UI_SECRET="${UI_SHARED_SECRET:-}"

if [[ -z "$UI_SECRET" && -f "$ROOT/.dev.vars" ]]; then
  UI_SECRET="$(awk -F= '/^UI_SHARED_SECRET=/{sub(/^[^=]*=/,""); print; exit}' "$ROOT/.dev.vars")"
fi
[[ -n "$UI_SECRET" ]] || { echo "UI_SHARED_SECRET is required" >&2; exit 2; }

command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
GH="${GH_BIN:-gh}"

RUN_JSON="$("$GH" run list --repo "$REPO" --workflow "Approval E2E No-op" --branch "$BRANCH" \
  --limit 1 --json databaseId,status,conclusion,url)"
RUN_ID="$(jq -er '.[0].databaseId' <<<"$RUN_JSON")"
STATUS="$(jq -r '.[0].status' <<<"$RUN_JSON")"
RUN_URL="$(jq -r '.[0].url' <<<"$RUN_JSON")"

echo "run=$RUN_ID status=$STATUS url=$RUN_URL"
if [[ "$STATUS" != "waiting" ]]; then
  echo "No-op run is not waiting; refusing to mint an approval ticket." >&2
  exit 1
fi

HEALTH_STATUS="$(curl -sS -o /tmp/drel-approval-health.json -w '%{http_code}' "$GATE/health")"
[[ "$HEALTH_STATUS" == "200" ]] || {
  echo "Gate health failed: HTTP $HEALTH_STATUS" >&2
  exit 1
}

PROBE_STATUS="$(curl -sS -o /tmp/drel-approval-probe.json -w '%{http_code}' \
  "$GATE/run/$RUN_ID" -H "Authorization: Bearer $UI_SECRET")"
echo "github_probe=HTTP $PROBE_STATUS"
if [[ "$PROBE_STATUS" != "200" ]]; then
  cat /tmp/drel-approval-probe.json >&2
  echo >&2
  curl -sS "$GATE/github-app/health" \
    -H "Authorization: Bearer $UI_SECRET" >&2 || true
  echo >&2
  echo "GitHub credentials are not ready; do not submit an approval ticket yet." >&2
  exit 1
fi

REQUEST_ID="xbrowser-noop-$RUN_ID"
TICKET="$(curl -fsS -X POST "$GATE/ticket" \
  -H "Authorization: Bearer $UI_SECRET" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg repo "$REPO" --arg environment "$ENVIRONMENT" \
    --argjson runId "$RUN_ID" --arg requestId "$REQUEST_ID" \
    '{repo:$repo,environment:$environment,runId:$runId,requestId:$requestId}')" \
  | jq -er '.ticket')"

curl -fsS -X POST "$GATE/api/review" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg ticket "$TICKET" --arg id "$REQUEST_ID" \
    '{ticket:$ticket,requestId:$id,actionId:"approve",expectedRevision:1,values:{}}')" \
  | tee /tmp/drel-approval-review.json
echo

jq -e '.state == "approved" and .revision == 2 and .requestId' \
  /tmp/drel-approval-review.json >/dev/null

for _ in $(seq 1 40); do
  RESULT="$("$GH" run view "$RUN_ID" --repo "$REPO" --json status,conclusion,url)"
  echo "$RESULT"
  [[ "$(jq -r '.status' <<<"$RESULT")" == "completed" ]] && break
  sleep 5
done

jq -e '.status == "completed" and .conclusion == "success"' <<<"$RESULT" >/dev/null
echo "Approval E2E passed: requestId=$REQUEST_ID run=$RUN_ID"
