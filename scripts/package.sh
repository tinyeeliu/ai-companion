#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPANION_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$COMPANION_DIR/backend"
FRONTEND_DIR="$COMPANION_DIR/frontend"
PACKAGE_DIR="$COMPANION_DIR/package"
BINARIES_DIR="$PACKAGE_DIR/tauri/binaries"

if ! command -v bun >/dev/null 2>&1; then
  printf 'bun is required but was not found in PATH.\n' >&2
  exit 1
fi

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin)
    case "$arch" in
      arm64)
        TAURI_TARGET="aarch64-apple-darwin"
        ;;
      x86_64)
        TAURI_TARGET="x86_64-apple-darwin"
        ;;
      *)
        printf 'Unsupported macOS architecture: %s\n' "$arch" >&2
        exit 1
        ;;
    esac
    BUNDLE="dmg"
    SIDECAR="$BINARIES_DIR/companion-server-$TAURI_TARGET"
    INSTALLER_LABEL="DMG files"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    case "$arch" in
      x86_64|amd64)
        TAURI_TARGET="x86_64-pc-windows-msvc"
        ;;
      *)
        printf 'Unsupported Windows architecture: %s\n' "$arch" >&2
        exit 1
        ;;
    esac
    BUNDLE="nsis"
    SIDECAR="$BINARIES_DIR/companion-server-$TAURI_TARGET.exe"
    INSTALLER_LABEL="Windows installers"
    ;;
  *)
    printf 'Unsupported operating system: %s\n' "$os" >&2
    exit 1
    ;;
esac

say() {
  printf '\n==> %s\n' "$*"
}

install_dependencies() {
  local directory="$1"

  if [[ ! -d "$directory/node_modules" ]]; then
    say "Installing dependencies in ${directory##"$COMPANION_DIR"/}"
    (cd "$directory" && bun install --frozen-lockfile)
  fi
}

install_dependencies "$BACKEND_DIR"
install_dependencies "$FRONTEND_DIR"
install_dependencies "$PACKAGE_DIR"

say "Building frontend"
(cd "$FRONTEND_DIR" && bun run build)

say "Compiling backend sidecar for $TAURI_TARGET"
mkdir -p "$BINARIES_DIR"
# Do NOT add --bytecode here. The sidecar entry uses top-level await
# (`await manager.restoreEnabled()` in backend/src/index.ts), and Bun's bytecode
# compiler rejects top-level await with `"await" can only be used inside an
# "async" function`, failing the build. Verified failing on bun 1.4.2.
(cd "$BACKEND_DIR" && bun build --compile src/index.ts --outfile "$SIDECAR")
chmod +x "$SIDECAR"

if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  say "Skipping cargo clean on GitHub Actions"
else
  say "Cleaning previous Tauri build artifacts"
  (cd "$PACKAGE_DIR" && cargo clean --manifest-path tauri/Cargo.toml)
fi

say "Building $BUNDLE installer"
(cd "$PACKAGE_DIR" && bunx tauri build --target "$TAURI_TARGET" --bundles "$BUNDLE")

printf '\n%s:\n' "$INSTALLER_LABEL"
if [[ "$BUNDLE" == "dmg" ]]; then
  printf '%s\n' "$PACKAGE_DIR/tauri/target/$TAURI_TARGET/release/bundle/dmg/"*.dmg
else
  printf '%s\n' "$PACKAGE_DIR/tauri/target/$TAURI_TARGET/release/bundle/nsis/"*-setup.exe
fi
