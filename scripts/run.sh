#!/bin/bash
# Start the companion *dev* API (:38000) and Vite HMR frontend (:5178).
# Leaves :38888 for the packaged Mac app so both can run on one machine.
# Kills only the dev ports first if they are already listening.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
# Packaged sidecar stays on DEFAULT_PORT 38888. Override only for this script.
export COMPANION_PORT="${COMPANION_PORT:-38000}"
export COMPANION_DATA_DIR="${COMPANION_DATA_DIR:-$ROOT_DIR/data-dev}"
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
