#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/assets/icons"
cp "$ROOT"/dist/renderer/*.js "$STAGE/assets/"
cp "$ROOT"/src/renderer/style.css "$STAGE/assets/"
cp "$ROOT"/src/renderer/audio-worklet.js "$STAGE/assets/"
cp "$ROOT"/src/icons/* "$STAGE/assets/icons/"
cp "$ROOT"/src/renderer/index.html "$STAGE/index.html"

rsync -az --delete "$STAGE/" nick@100.99.99.72:/home/nick/cairn-svc/webapp/
ssh nick@100.99.99.72 "systemctl --user restart cairn-svc"

echo "deployed -> https://precision-node4.taild99f50.ts.net/"
