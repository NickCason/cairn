#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

DEST_LIGHT="$HOME/Desktop/cairn-light.mp4"
DEST_DARK="$HOME/Desktop/cairn-dark.mp4"
DURATION=140                     # seconds per recording (WAV ~117s + buffer)
SCREEN_INDEX=4                   # avfoundation "Capture screen 0" index — confirmed earlier
WAV="$(pwd)/benchmarks/four-speaker-vendor-sync.wav"

npm run build

for THEME in light dark; do
  DEST="$HOME/Desktop/cairn-$THEME.mp4"
  echo "==> recording $THEME → $DEST"
  rm -f "$DEST"

  # Start ffmpeg in background. -t auto-stops after DURATION seconds.
  ffmpeg -y -f avfoundation -framerate 30 -i "$SCREEN_INDEX" \
    -t "$DURATION" -c:v libx264 -preset fast -pix_fmt yuv420p \
    "$DEST" >/tmp/cairn-record-$THEME.log 2>&1 &
  FFMPEG_PID=$!

  # Give ffmpeg ~2 s to spin up before launching the app
  sleep 2

  # Launch electron in demo mode + test-file in background so we can bring it to front
  npx electron . "--demo-mode=$THEME" "--test-file=$WAV" &
  ELECTRON_PID=$!

  # Give electron ~3 s to open its window, then bring it to front
  sleep 3
  osascript -e 'tell application "Electron" to activate' 2>/dev/null || true

  # Wait for electron to finish (blocks until window.close is called by renderer)
  wait $ELECTRON_PID 2>/dev/null || true

  # Give ffmpeg a moment to flush, then stop it
  sleep 2
  kill $FFMPEG_PID 2>/dev/null || true
  wait $FFMPEG_PID 2>/dev/null || true

  echo "    done: $(ls -lh "$DEST" | awk '{print $5}')"
done

echo ""
echo "Recordings saved to:"
echo "  $DEST_LIGHT"
echo "  $DEST_DARK"
