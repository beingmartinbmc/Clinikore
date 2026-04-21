#!/usr/bin/env bash
# ============================================================
# Clinikore — macOS / Linux one-click installer.
#
# macOS: double-click this file (Finder will run it in Terminal).
# Linux: from a terminal, run:  bash scripts/install.command
#
# Safe to re-run: nothing is deleted, only re-synced.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# --- pretty output ------------------------------------------------------
if [ -t 1 ]; then
  C_RESET="\033[0m"; C_BOLD="\033[1m"
  C_OK="\033[32m"; C_ERR="\033[31m"; C_STEP="\033[36m"; C_WARN="\033[33m"
else
  C_RESET=""; C_BOLD=""; C_OK=""; C_ERR=""; C_STEP=""; C_WARN=""
fi
step() { printf "${C_STEP}[%s]${C_RESET} %s\n" "$1" "$2"; }
ok()   { printf "  ${C_OK}✓${C_RESET} %s\n" "$1"; }
warn() { printf "  ${C_WARN}!${C_RESET} %s\n" "$1"; }
die()  { printf "  ${C_ERR}✗${C_RESET} %s\n" "$1"; exit 1; }

echo
printf "${C_BOLD}===============================================\n"
printf "  Clinikore — Installer\n"
printf "===============================================${C_RESET}\n\n"

# --- [1/5] Python -------------------------------------------------------
# We probe known-good interpreters in preference order. Python 3.14 is
# deliberately excluded because pydantic-core doesn't ship wheels for it yet.
# Minimum supported is 3.9 — every dependency in requirements.txt supports it.
step "1/5" "Checking for Python 3.9+..."
PY_BIN=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3.9 python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then
    # Skip anything >= 3.14 since prebuilt wheels are missing.
    v_major=$("$candidate" -c 'import sys;print(sys.version_info[0])' 2>/dev/null || echo 0)
    v_minor=$("$candidate" -c 'import sys;print(sys.version_info[1])' 2>/dev/null || echo 0)
    if [ "$v_major" -eq 3 ] && [ "$v_minor" -ge 9 ] && [ "$v_minor" -le 13 ]; then
      PY_BIN="$candidate"
      break
    fi
  fi
done
if [ -z "$PY_BIN" ]; then
  die "No usable Python 3.9–3.13 found. Install Python 3.12 with: brew install python@3.12 (macOS) or from https://www.python.org/downloads/"
fi
PYVER=$("$PY_BIN" -c 'import sys;print("{}.{}".format(*sys.version_info[:2]))')
ok "Found $PY_BIN ($PYVER)"

# --- [2/5] Node (only if frontend sources are present) ------------------
# Match the step 5 logic: if package.json is present we need to (re)build the
# UI and therefore need Node; if only the pre-built dist/ is shipped, skip.
if [ ! -f "$ROOT_DIR/frontend/package.json" ]; then
  step "2/5" "Pre-built UI bundle — Node not required."
else
  step "2/5" "Checking for Node.js 18+..."
  if ! command -v npm >/dev/null 2>&1; then
    die "Node.js / npm not found. Install the LTS version from https://nodejs.org/"
  fi
  NODEVER=$(node --version)
  ok "Found Node $NODEVER"
fi

# --- [3/5] venv ---------------------------------------------------------
step "3/5" "Creating Python virtual environment..."
if [ ! -d .venv ]; then
  "$PY_BIN" -m venv .venv
  ok "venv created at .venv"
else
  ok "venv already exists"
fi

# shellcheck disable=SC1091
source .venv/bin/activate

# --- [4/5] Python deps --------------------------------------------------
step "4/5" "Installing / updating Python dependencies..."
pip install --quiet --upgrade pip
# --upgrade ensures re-runs pull any new/changed pins from requirements.txt.
pip install --upgrade -r requirements.txt
ok "Python dependencies installed"

# --- [5/5] Frontend -----------------------------------------------------
# Rebuild whenever frontend/ sources are present so re-running the installer
# picks up newly added components, translations, etc. If sources are absent
# (packaged build where only dist/ ships) we skip the Node step entirely.
if [ -f "$ROOT_DIR/frontend/package.json" ]; then
  if command -v npm >/dev/null 2>&1; then
    step "5/5" "Installing and building the UI..."
    ( cd frontend && npm install && npm run build )
    ok "UI built into frontend/dist"
  else
    die "Node.js / npm not found but frontend/package.json is present. Install the LTS version from https://nodejs.org/"
  fi
else
  step "5/5" "Pre-built UI bundle — Node not required."
fi

echo
printf "${C_OK}${C_BOLD}===============================================\n"
printf "  All done!\n"
printf "===============================================${C_RESET}\n\n"
echo "Launch the app with:"
echo "  • macOS:  double-click  scripts/run.command"
echo "  • Linux:  bash          scripts/run.command"
echo

# When double-clicked from Finder, keep the Terminal window open so the
# doctor can read the success message.
if [ -z "${CI:-}" ] && [ -z "${SSH_TTY:-}" ] && [ -t 1 ]; then
  read -r -p "Press Enter to close..." _ || true
fi
