#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${1:-$HOME/.pi/agent/git/github.com/JarenKempton/pi-config}"
PI_DIR="$HOME/.pi/agent"

mkdir -p "$PI_DIR"

if [ ! -d "$REPO_DIR" ]; then
  echo "Missing pi-config repo at: $REPO_DIR" >&2
  echo "Run: pi install git:git@github.com:JarenKempton/pi-config" >&2
  exit 1
fi

# Convenience pointer to the canonical package checkout.
ln -sfn "$REPO_DIR" "$PI_DIR/pi-config"

# Global agent instructions are not loaded from packages, so expose the repo copy
# at Pi's global context-file location. Keep it as a symlink so edits stay tracked.
ln -sfn "$REPO_DIR/AGENTS.md" "$PI_DIR/AGENTS.md"

# Do not symlink extensions/skills/prompts/themes into ~/.pi/agent. Pi loads them
# through the installed git package in settings.json; separate top-level resource
# dirs create duplicate local-only sources of truth.

echo "Linked global AGENTS.md and pi-config pointer from $REPO_DIR to $PI_DIR"
echo "Log into pi on this machine separately so auth.json stays local."
