#!/usr/bin/env bash
# macOS / Linux launcher. Double-clickable on macOS.
# Assumes `scripts/install.command` has been run once already.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -d .venv ] || [ ! -d frontend/dist ]; then
  echo "First-time setup not complete. Please run:"
  echo "    bash scripts/install.command"
  echo
  if [ -t 1 ]; then read -r -p "Press Enter to close..." _ || true; fi
  exit 1
fi

# shellcheck disable=SC1091
source .venv/bin/activate
exec python main.py
