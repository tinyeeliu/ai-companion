#!/bin/bash
# Start the companion *dev* API (:38000) and Vite HMR frontend (:5178).
# Leaves :38888 for the packaged Mac app so both can run on one machine.
# Kills only the dev ports first if they are already listening.
#
# Data dir: an explicit COMPANION_DATA_DIR wins. Otherwise this reuses the
# packaged app's Application Support dir when it already exists, so one linked
# session serves both builds. On a machine that never ran the app, it falls
# back to data-dev/.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
APP_ID="app.aicompanion.desktop"

# Where Tauri's app_data_dir() lands, per platform.
app_data_dir() {
  case "$(uname -s)" in
    Darwin) printf '%s\n' "$HOME/Library/Application Support" ;;
    Linux) printf '%s\n' "${XDG_DATA_HOME:-$HOME/.local/share}" ;;
    *) printf '%s\n' "${APPDATA:-$HOME/AppData/Roaming}" ;;
  esac
}

PACKAGED_DATA_DIR="$(app_data_dir)/$APP_ID/data"

# Packaged sidecar stays on DEFAULT_PORT 38888. Override only for this script.
export COMPANION_PORT="${COMPANION_PORT:-38000}"

if [ -n "${COMPANION_DATA_DIR:-}" ]; then
  : # caller override wins
elif [ -d "$PACKAGED_DATA_DIR" ]; then
  COMPANION_DATA_DIR="$PACKAGED_DATA_DIR"
else
  COMPANION_DATA_DIR="$ROOT_DIR/data-dev"
fi
export COMPANION_DATA_DIR

VITE_PORT="${COMPANION_VITE_PORT:-5178}"
PORT="$COMPANION_PORT"

say() { printf '%s\n' "$*"; }

stop_port() {
  local port="$1"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    return 0
  fi
  say "Stopping listener on :$port (PID $pids)"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  for _ in $(seq 1 30); do
    lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || return 0
    sleep 0.1
  done
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    say "Force killing :$port (PID $pids)"
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
}

stop_port "$PORT"
stop_port "$VITE_PORT"

if [ "$COMPANION_DATA_DIR" = "$PACKAGED_DATA_DIR" ]; then
  if lsof -tiTCP:38888 -sTCP:LISTEN >/dev/null 2>&1; then
    say "WARNING: the packaged app is listening on :38888 and shares ${COMPANION_DATA_DIR}."
    say "         Quit it from the tray (Quit, not just closing the window) before connecting,"
    say "         or two WhatsApp sockets will fight over the same linked session."
  fi
fi

if [ ! -d "$BACKEND_DIR/node_modules" ]; then
  say "Installing backend dependencies"
  (cd "$BACKEND_DIR" && bun install)
fi

if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
  say "Installing frontend dependencies"
  (cd "$FRONTEND_DIR" && bun install)
fi

cleanup() {
  if [ -n "${BACKEND_PID:-}" ]; then
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

say "Starting companion *dev* API at http://127.0.0.1:${PORT} (data ${COMPANION_DATA_DIR})"
say "Packaged app keeps http://127.0.0.1:38888"
(
  cd "$BACKEND_DIR"
  bun run src/index.ts
) &
BACKEND_PID=$!

for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:${PORT}/api/v1/im/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

say "Vite control panel: http://127.0.0.1:${VITE_PORT} (HMR; /api → :${PORT})"
cd "$FRONTEND_DIR"
bunx vite --host 127.0.0.1 --port "$VITE_PORT" --strictPort >/dev/null 2>&1
