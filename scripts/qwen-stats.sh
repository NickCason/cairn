#!/usr/bin/env bash
F="$(dirname "$0")/../cairn-build-stats/qwen-calls.jsonl"
[ ! -s "$F" ] && { echo "No qwen calls logged."; exit 0; }
echo "Total calls: $(wc -l < "$F")"
echo "Total prompt tokens:     $(jq -s 'map(.prompt_tokens) | add' "$F")"
echo "Total completion tokens: $(jq -s 'map(.completion_tokens) | add' "$F")"
echo "Total wall time (s):     $(jq -s 'map(.eval_duration_s) | add' "$F")"
echo "Verdicts:"
jq -r '.verdict' "$F" | sort | uniq -c
