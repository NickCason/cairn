#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Where cairn-svc runs (from the environment; nothing machine-specific is committed).
CAIRN_SSH="${CAIRN_SSH:?set CAIRN_SSH to user@host of the machine running cairn-svc}"
CAIRN_DIR="${CAIRN_DIR:-cairn-svc}"   # cairn-svc checkout on that machine, relative to its home
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/assets/icons"
cp "$ROOT"/dist/renderer/*.js "$STAGE/assets/"
cp "$ROOT"/src/renderer/style.css "$STAGE/assets/"
cp "$ROOT"/src/renderer/audio-worklet.js "$STAGE/assets/"
cp "$ROOT"/src/icons/* "$STAGE/assets/icons/"
cp "$ROOT"/src/renderer/index.html "$STAGE/index.html"

rsync -az --delete "$STAGE/" "$CAIRN_SSH:$CAIRN_DIR/webapp/"
ssh "$CAIRN_SSH" "systemctl --user restart cairn-svc"

echo "deployed to $CAIRN_SSH:$CAIRN_DIR/webapp/${CTRL:+ -> $CTRL/}"
