#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPANION_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$COMPANION_DIR/backend"
FRONTEND_DIR="$COMPANION_DIR/frontend"
PACKAGE_DIR="$COMPANION_DIR/package"
BINARIES_DIR="$PACKAGE_DIR/tauri/binaries"

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'This script must be run on macOS.\n' >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  printf 'bun is required but was not found in PATH.\n' >&2
  exit 1
fi

case "$(uname -m)" in
  arm64)
    TAURI_TARGET="aarch64-apple-darwin"
    ;;
  x86_64)
    TAURI_TARGET="x86_64-apple-darwin"
    ;;
  *)
    printf 'Unsupported macOS architecture: %s\n' "$(uname -m)" >&2
    exit 1
    ;;
esac

SIDECAR="$BINARIES_DIR/companion-server-$TAURI_TARGET"

say() {
  printf '\n==> %s\n' "$*"
}

install_dependencies() {
  local directory="$1"

  if [[ ! -d "$directory/node_modules" ]]; then
    say "Installing dependencies in ${directory##"$COMPANION_DIR"/}"
    (cd "$directory" && bun install)
  fi
}

install_dependencies "$BACKEND_DIR"
install_dependencies "$FRONTEND_DIR"
install_dependencies "$PACKAGE_DIR"

say "Building frontend"
(cd "$FRONTEND_DIR" && bun run build)

say "Compiling backend sidecar for $TAURI_TARGET"
(cd "$BACKEND_DIR" && bun build --compile src/index.ts --outfile "$SIDECAR")
chmod +x "$SIDECAR"

say "Cleaning previous Tauri build artifacts"
(cd "$PACKAGE_DIR" && cargo clean --manifest-path tauri/Cargo.toml)

say "Building macOS DMG"
(cd "$PACKAGE_DIR" && bunx tauri build --target "$TAURI_TARGET")

printf '\nDMG files:\n'
printf '%s\n' "$PACKAGE_DIR/tauri/target/$TAURI_TARGET/release/bundle/dmg/"*.dmg
