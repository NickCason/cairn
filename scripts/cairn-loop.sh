#!/usr/bin/env bash
# cairn-loop.sh — one e2e test iteration of Cairn against a YouTube URL.
#
# Opens the Cairn webapp in Safari, starts a recording session via the
# control endpoint, opens a second Safari window at the YouTube URL (with
# autoplay-friendly behavior), sleeps for the duration, stops Cairn,
# snapshots the transcript, runs the grader, prints a summary line.

set -euo pipefail

URL="${URL:-https://www.youtube.com/watch?v=ugvHCXCOmm4&t=194s}"
DURATION="${DURATION:-600}"
OUT_BASE="${OUT_BASE:-/tmp/cairn-test-runs}"
CTRL="${CTRL:-https://precision-node4.taild99f50.ts.net}"
REFERENCE="${REFERENCE:-$(dirname "$0")/fixtures/dario-reference-v2.json}"

TS="$(date +%Y%m%d-%H%M%S)"
MEETING_NAME="${MEETING_NAME:-loop-$TS}"

usage() {
  cat <<EOF
usage: $0 [--url URL] [--duration SEC] [--out DIR]

Defaults:
  --url       $URL
  --duration  $DURATION (seconds)
  --out       $OUT_BASE/run-<timestamp>

Env overrides: URL, DURATION, OUT_BASE, CTRL, MEETING_NAME, REFERENCE
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

OUT="$OUT_BASE/run-$TS"
mkdir -p "$OUT"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

# 1. Quit any running Safari for a clean state each iteration.
log "quitting any running Safari"
osascript -e 'tell application "Safari" to quit' 2>/dev/null || true
sleep 3
pkill -9 Safari 2>/dev/null || true
sleep 1

# 2. POST /control/start so the server flips state to starting, then open the
# Cairn webapp in Safari with ?meeting_name + ?autostart=1. The renderer's
# IIFE calls startLiveSession(), WS handshake fires, server flips to recording.
log "POST /control/start (meeting_name=$MEETING_NAME)"
curl -fsS -X POST -H 'Content-Type: application/json' \
  -d "{\"meeting_name\":\"$MEETING_NAME\"}" \
  "$CTRL/control/start" > "$OUT/start-resp.json" || true

log "opening Cairn webapp in Safari"
open -a Safari "https://precision-node4.taild99f50.ts.net/?meeting_name=$MEETING_NAME&autostart=1"
sleep 3

# 3. Poll /control/status until state becomes recording (up to 20s).
log "waiting for state=recording (max 20s)"
deadline=$((SECONDS + 20))
until [[ "$(curl -fsS --max-time 2 "$CTRL/control/status" 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin).get("state",""))' 2>/dev/null)" == "recording" ]]; do
  (( SECONDS < deadline )) || { log "ERROR: state did not reach recording in 20s"; exit 2; }
  sleep 1
done
log "state=recording"

# 4. Open Safari at the YouTube URL (opens as window 2 behind the webapp).
# Notes:
#   - Stage Manager interferes; assumes it's disabled.
#   - Window coordinates are in POINTS (not pixels). Query Finder desktop
#     bounds for the actual point dimensions; fall back to 1920x1200.
log "opening Safari at $URL"
open -a Safari "$URL"
sleep 5

# Query screen dimensions in points via Finder desktop bounds.
SCREEN_DIMS="$(osascript -e 'tell application "Finder" to return (item 3 of (bounds of window of desktop) as text) & "," & (item 4 of (bounds of window of desktop) as text)' 2>/dev/null || echo "1920,1200")"
SCREEN_W="${SCREEN_DIMS%,*}"
SCREEN_H="${SCREEN_DIMS#*,}"
SCREEN_W="${SCREEN_W:-1920}"
SCREEN_H="${SCREEN_H:-1200}"
HALF_W=$((SCREEN_W / 2))
WIN_H=$((SCREEN_H - 25))
log "positioning webapp right (window 1), YouTube left (window 2) (display ${SCREEN_W}x${SCREEN_H} points)"
osascript >/dev/null 2>&1 <<OSA || true
tell application "System Events"
    tell process "Safari"
        if (count of windows) >= 1 then
            set position of window 1 to {${HALF_W}, 25}
            set size of window 1 to {${HALF_W}, ${WIN_H}}
        end if
        if (count of windows) >= 2 then
            set position of window 2 to {0, 25}
            set size of window 2 to {${HALF_W}, ${WIN_H}}
        end if
    end tell
end tell
OSA

# Bring the webapp tab to foreground via a re-open. Without focus, Safari
# throttles JS in backgrounded tabs after ~30s and the renderer's WebSocket
# handler suspends — the on-stop relabel batch then never gets processed.
# `open -a Safari <url>` on an already-open URL focuses that tab without
# reloading. YouTube continues playing audio in the background unchanged.
sleep 1
open -a Safari "https://precision-node4.taild99f50.ts.net/?meeting_name=$MEETING_NAME&autostart=1"

# YouTube autoplays the cued URL on its own. Don't send a play keystroke
# here — that toggles play/pause, and if autoplay already fired it pauses
# the video. The autoplay path is reliable for ?t=Xs URLs in Safari.

# 6. Sleep for the duration. Cairn's auto-started session has been recording
# the whole time; YouTube playback continues in the background.
log "recording for $DURATION s ..."
sleep "$DURATION"

# 8. Stop Cairn.
log "POST /control/stop"
curl -fsS -X POST "$CTRL/control/stop" > "$OUT/stop-resp.json"

# 9. Wait for state == stopped (long sessions need the on-stop auth pass to
#    complete; that's typically ~30s/min of accumulated session).
STOP_WAIT_S="${STOP_WAIT_S:-900}"
log "waiting for state=stopped (max ${STOP_WAIT_S}s)"
deadline=$((SECONDS + STOP_WAIT_S))
while :; do
  STATE="$(curl -fsS "$CTRL/control/status" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("state",""))')"
  if [[ "$STATE" == "stopped" ]]; then
    log "state=stopped"
    break
  fi
  (( SECONDS < deadline )) || { log "WARN: did not reach stopped state in ${STOP_WAIT_S}s (current=$STATE)"; break; }
  sleep 2
done

# 9.5 Wait for final_summary to land in the saved transcript.jsonl on node4.
# Sessions live on node4 at $SESS_DIR; poll via SSH.
SESS_DIR="$(curl -fsS "$CTRL/control/status" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("session_dir",""))')"
if [[ -n "$SESS_DIR" ]]; then
  log "waiting for final_summary in $SESS_DIR/transcript.jsonl on node4 (max 300s)"
  deadline=$((SECONDS + 300))
  until ssh nick@100.99.99.72 "grep -q '\"type\":\"final_summary\"' '$SESS_DIR/transcript.jsonl' 2>/dev/null"; do
    (( SECONDS < deadline )) || { log "WARN: final_summary not seen in 300s; continuing"; break; }
    sleep 2
  done
  if ssh nick@100.99.99.72 "grep -q '\"type\":\"final_summary\"' '$SESS_DIR/transcript.jsonl' 2>/dev/null"; then
    log "final_summary present"
  fi
  scp "nick@100.99.99.72:$SESS_DIR/transcript.jsonl" "$OUT/session.jsonl" 2>/dev/null || true
fi

# 10. Snapshot transcript.
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
