#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${1:-$HOME/code/pi-config}"
PI_DIR="$HOME/.pi/agent"

mkdir -p "$PI_DIR"

ln -sfn "$REPO_DIR/settings.json" "$PI_DIR/settings.json"
ln -sfn "$REPO_DIR/extensions" "$PI_DIR/extensions"
ln -sfn "$REPO_DIR/skills" "$PI_DIR/skills"
ln -sfn "$REPO_DIR/themes" "$PI_DIR/themes"

echo "Linked pi config from $REPO_DIR to $PI_DIR"
echo "Log into pi on this machine separately so auth.json stays local."
