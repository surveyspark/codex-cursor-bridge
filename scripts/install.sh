#!/usr/bin/env bash
# codex-cursor-bridge installer (release archive).
#
# - Copies the bundled CLI to ~/.local/bin (or a --bin-dir of your choice).
# - Installs the two host plugins into the user plugin directories.
# - Idempotent: safe to run repeatedly. Never modifies existing plugin
#   directories without --force (backs them up first).
# - Supports --dry-run to print planned actions only.
#
# Usage: ./install.sh [--dry-run] [--force] [--bin-dir DIR] [--plugins-only] [--cli-only]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=0
FORCE=0
PLUGINS_ONLY=0
CLI_ONLY=0
BIN_DIR="${HOME}/.local/bin"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    --bin-dir) BIN_DIR="$2"; shift ;;
    --plugins-only) PLUGINS_ONLY=1 ;;
    --cli-only) CLI_ONLY=1 ;;
    -h|--help)
      echo "usage: install.sh [--dry-run] [--force] [--bin-dir DIR] [--plugins-only] [--cli-only]"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '%s\n' "$*"; }
run() {
  if [ "$DRY_RUN" = "1" ]; then log "dry-run: $*"; else eval "$*"; fi
}

OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  CURSOR_PLUGINS_DIR="${HOME}/.cursor/plugins/local"
  CODEX_PLUGINS_DIR="${HOME}/.codex/plugins"
elif [ "$OS" = "Linux" ]; then
  CURSOR_PLUGINS_DIR="${HOME}/.cursor/plugins/local"
  CODEX_PLUGINS_DIR="${HOME}/.codex/plugins"
else
  log "unsupported OS for install.sh (use install.ps1 on Windows)"; exit 1
fi

fail() {
  log "ERROR: $*"
  exit 1
}

command -v node >/dev/null 2>&1 || fail "node is required (>= 20.19): https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js >= 20.19 required, found $(node --version)"

# CLI install
if [ "$CLI_ONLY" = "0" ] && [ "$PLUGINS_ONLY" = "0" ]; then CLI_INSTALL=1; else CLI_INSTALL=$([ "$PLUGINS_ONLY" = "1" ] && echo 0 || echo 1); fi
if [ "$CLI_ONLY" = "1" ]; then CLI_INSTALL=1; fi

if [ "$CLI_INSTALL" = "1" ]; then
  if [ ! -f "${SCRIPT_DIR}/codex-cursor-bridge.mjs" ]; then
    fail "codex-cursor-bridge.mjs not found next to install.sh (use the release archive)"
  fi
  run "mkdir -p '${BIN_DIR}'"
  if [ -e "${BIN_DIR}/codex-cursor-bridge" ] && [ "$FORCE" = "0" ] && [ "$DRY_RUN" = "0" ]; then
    log "existing CLI found at ${BIN_DIR}/codex-cursor-bridge (use --force to overwrite)"
  else
    run "cp '${SCRIPT_DIR}/codex-cursor-bridge.mjs' '${BIN_DIR}/codex-cursor-bridge'"
    run "chmod +x '${BIN_DIR}/codex-cursor-bridge'"
    log "installed CLI: ${BIN_DIR}/codex-cursor-bridge"
  fi
  case ":${PATH}:" in
    *":${BIN_DIR}:"*) ;;
    *) log "note: ${BIN_DIR} is not on your PATH; add it to your shell profile" ;;
  esac
fi

# Plugin installs
install_plugin() {
  src="$1"; dest="$2"; name="$3"
  [ -d "$src" ] || fail "plugin source missing: $src"
  if [ -e "$dest" ]; then
    if [ "$FORCE" = "1" ]; then
      backup="${dest}.bak.$(date +%s)"
      run "mv '$dest' '$backup'"
      log "backed up existing plugin to $backup"
    else
      log "plugin already present: $dest (use --force to replace)"
      return 0
    fi
  fi
  run "mkdir -p '$(dirname "$dest")'"
  run "cp -R '$src' '$dest'"
  log "installed $name plugin: $dest"
}

if [ "$CLI_ONLY" != "1" ]; then
  install_plugin "${SCRIPT_DIR}/../../plugins/cursor-delegates-to-codex" "${CURSOR_PLUGINS_DIR}/codex-cursor-bridge" "Cursor"
  install_plugin "${SCRIPT_DIR}/../../plugins/codex-plans-cursor-executes" "${CODEX_PLUGINS_DIR}/codex-cursor-bridge" "Codex"
fi

log ""
log "next steps:"
log "  1. run: codex-cursor-bridge doctor"
log "  2. restart Cursor / Codex so the plugins are discovered"
log "uninstall: remove the plugin directories above and ${BIN_DIR}/codex-cursor-bridge"
