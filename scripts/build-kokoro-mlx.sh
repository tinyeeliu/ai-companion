#!/bin/bash
# Build KokoroCLI (MLX) and copy it into the Companion data dir.
# Weights are downloaded by Setup; this binary is not on Hugging Face.
# Apple Silicon only. Compile stays here, not in the Download request.

set -euo pipefail

PIN="20bf04c506e913ff129d7d2229398180ba24c690"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="${KOKORO_SWIFT_SRC:-/tmp/kokoro-swift}"
APP_ID="app.aicompanion.desktop"

app_data_dir() {
  case "$(uname -s)" in
    Darwin) printf '%s\n' "$HOME/Library/Application Support" ;;
    *) printf '%s\n' "${XDG_DATA_HOME:-$HOME/.local/share}" ;;
  esac
}

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "KokoroCLI MLX builds only on Apple Silicon" >&2
  exit 1
fi

PACKAGED_DATA_DIR="$(app_data_dir)/$APP_ID/data"
if [ -n "${COMPANION_DATA_DIR:-}" ]; then
  DATA_DIR="$COMPANION_DATA_DIR"
elif [ -d "$PACKAGED_DATA_DIR" ]; then
  DATA_DIR="$PACKAGED_DATA_DIR"
else
  DATA_DIR="$ROOT_DIR/data-dev"
fi

DEST="$DATA_DIR/tts/mlx"
mkdir -p "$DEST"

if ! xcrun metal --version >/dev/null 2>&1; then
  xcodebuild -downloadComponent MetalToolchain
fi

if [ ! -d "$SRC/.git" ]; then
  git clone --filter=blob:none https://github.com/mweinbach/kokoro-swift.git "$SRC"
fi
git -C "$SRC" checkout "$PIN"
(cd "$SRC" && swift build -c release --product KokoroCLI)

BIN="$(find "$SRC/.build" -type f -name KokoroCLI ! -path '*.dSYM/*' | head -1)"
if [ -z "$BIN" ]; then
  echo "swift build did not produce KokoroCLI" >&2
  exit 1
fi

cp "$BIN" "$DEST/KokoroCLI"
chmod 755 "$DEST/KokoroCLI"

BIN_DIR="$(dirname "$BIN")"
find "$BIN_DIR" -maxdepth 1 \( -name '*.dylib' -o -name '*.metallib' \) -exec cp {} "$DEST/" \;
find "$BIN_DIR" -maxdepth 1 -type d -name '*.bundle' -exec cp -R {} "$DEST/" \;

echo "Installed $DEST/KokoroCLI"
otool -L "$DEST/KokoroCLI"
