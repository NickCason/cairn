#!/usr/bin/env bash
# steeLL-v1 helper — route a coding subtask to qwen3.6:35b-a3b on n8.
# Logs every call to cairn-build-stats/qwen-calls.jsonl.
#
# Usage:
#   echo "<task description and code context>" | qwen-helper.sh "<short task summary>"
# Output: model response on stdout.
set -euo pipefail
TASK_SUMMARY="${1:-unspecified}"
STATS_FILE="$(dirname "$0")/../cairn-build-stats/qwen-calls.jsonl"
mkdir -p "$(dirname "$STATS_FILE")"
PROMPT=$(cat)
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP=$(mktemp)
START_NS=$(date +%s%N)
curl -sS http://100.122.121.18:11434/api/chat \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg p "$PROMPT" '{
    model: "qwen3.6:35b-a3b",
    messages: [{role:"user", content:$p}],
    stream: false,
    options: {num_ctx: 8192, temperature: 0.2}
  }')" > "$TMP"
END_NS=$(date +%s%N)
DUR_S=$(awk "BEGIN { printf \"%.2f\", ($END_NS - $START_NS) / 1000000000 }")
RESPONSE=$(jq -r '.message.content // empty' "$TMP")
PT=$(jq -r '.prompt_eval_count // 0' "$TMP")
CT=$(jq -r '.eval_count // 0' "$TMP")
jq -nc --arg ts "$TS" --arg s "$TASK_SUMMARY" --arg m "qwen3.6:35b-a3b" \
       --argjson pt "$PT" --argjson ct "$CT" --argjson d "$DUR_S" \
       '{ts:$ts, task_summary:$s, model:$m, prompt_tokens:$pt, completion_tokens:$ct, eval_duration_s:$d, verdict:"pending"}' \
       >> "$STATS_FILE"
echo "$RESPONSE"
rm -f "$TMP"
