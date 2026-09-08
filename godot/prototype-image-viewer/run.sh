#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")"
GODOT_BIN="${GODOT_BIN:-/home/reidsurmeier/.cache/qwen-ui-pipeline/godot-4.7.2/Godot_v4.7.2-stable_linux.x86_64}"
"$GODOT_BIN" --headless --path . --editor --import --quit
if [ "${1:-}" = "web" ]; then
  mkdir -p web
  "$GODOT_BIN" --headless --path . --export-release Web "$PWD/web/index.html"
else
  exec "$GODOT_BIN" --path .
fi
