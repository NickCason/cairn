#!/usr/bin/env bash
# cairn-loop.sh — one e2e test iteration of Cairn against a YouTube URL.
#
# Quits Safari, starts Cairn recording via the control endpoint, opens
# Safari at the given URL (with autoplay-friendly behavior), sleeps for
# the duration, stops Cairn, snapshots the transcript, runs the grader,
# prints a summary line.

set -euo pipefail

URL="${URL:-https://www.youtube.com/watch?v=ugvHCXCOmm4&t=194s}"
DURATION="${DURATION:-600}"
OUT_BASE="${OUT_BASE:-/tmp/cairn-test-runs}"
CONTROL_HOST="${CONTROL_HOST:-127.0.0.1}"
CONTROL_PORT="${CONTROL_PORT:-8765}"
REFERENCE="${REFERENCE:-$(dirname "$0")/fixtures/dario-reference.json}"

usage() {
  cat <<EOF
usage: $0 [--url URL] [--duration SEC] [--out DIR]

Defaults:
  --url       $URL
  --duration  $DURATION (seconds)
  --out       $OUT_BASE/run-<timestamp>

Env overrides: URL, DURATION, OUT_BASE, CONTROL_HOST, CONTROL_PORT, REFERENCE
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    --out) OUT_BASE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 1 ;;
  esac
done

TS="$(date +%Y%m%d-%H%M%S)"
OUT="$OUT_BASE/run-$TS"
mkdir -p "$OUT"

CTRL="http://${CONTROL_HOST}:${CONTROL_PORT}"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

# 1. Pre-flight: ensure Cairn is running.
if ! pgrep -f 'Cairn.app/Contents/MacOS' > /dev/null; then
  log "Cairn not running; launching."
  open -a Cairn
  sleep 4
fi

# 2. Confirm control endpoint reachable.
if ! curl -fsS --max-time 3 "$CTRL/control/status" > /dev/null; then
  log "ERROR: control endpoint $CTRL/control/status unreachable. Is the build current?"
  exit 2
fi
log "control endpoint OK"

# 3. Quit Safari.
log "quitting Safari"
osascript -e 'tell application "Safari" to quit' 2>/dev/null || true
deadline=$((SECONDS + 10))
while pgrep -x Safari > /dev/null; do
  (( SECONDS < deadline )) || { log "WARN: Safari did not quit within 10s; continuing anyway"; break; }
  sleep 0.5
done

# 4. Start Cairn recording.
MEETING_NAME="loop-$TS"
log "POST /control/start meeting=$MEETING_NAME"
START_RESP="$(curl -fsS -X POST "$CTRL/control/start" \
  -H 'Content-Type: application/json' \
  -d "{\"meeting_name\":\"$MEETING_NAME\"}")"
echo "$START_RESP" > "$OUT/start-resp.json"
if ! echo "$START_RESP" | grep -q '"ok": true'; then
  log "ERROR: /control/start did not return ok=true"
  cat "$OUT/start-resp.json"
  exit 3
fi

# 5. Open Safari at the URL; press Space to ensure playback.
log "opening Safari at $URL"
open -a Safari "$URL"
sleep 3
osascript -e 'tell application "Safari" to activate' >/dev/null 2>&1 || true
sleep 1
osascript -e 'tell application "System Events" to keystroke " "' >/dev/null 2>&1 || true

# 6. Sleep for the duration.
log "recording for $DURATION s ..."
sleep "$DURATION"

# 7. Stop Cairn.
log "POST /control/stop"
curl -fsS -X POST "$CTRL/control/stop" > "$OUT/stop-resp.json"

# 8. Wait for state == stopped.
log "waiting for state=stopped (max 90s)"
deadline=$((SECONDS + 90))
while :; do
  STATE="$(curl -fsS "$CTRL/control/status" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("state",""))')"
  if [[ "$STATE" == "stopped" ]]; then
    log "state=stopped"
    break
  fi
  (( SECONDS < deadline )) || { log "WARN: did not reach stopped state in 90s (current=$STATE)"; break; }
  sleep 1
done

# 9. Snapshot transcript.
log "snapshotting transcript"
curl -fsS "$CTRL/control/transcript" > "$OUT/transcript.json"

# 10. Grade.
log "grading vs reference"
if [[ -f "$REFERENCE" ]]; then
  python3 "$(dirname "$0")/grade-transcript.py" \
    --transcript "$OUT/transcript.json" \
    --reference "$REFERENCE" \
    --out "$OUT/grade.json" \
    | tee "$OUT/grade-summary.txt"
else
  log "reference not found at $REFERENCE; skipping grading (Task 10 will create it)"
fi

log "run output: $OUT"
