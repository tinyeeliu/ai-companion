# AI Companion

Local desktop gateway for personal WhatsApp and LINE accounts. The phone link stays on this computer. The packaged Mac app listens on `127.0.0.1:38888`; `scripts/run.sh` uses `127.0.0.1:38000` so both can run at once.

This folder is independent of `sm3/` and `frontend/`.

## Layout

| Path | Role |
|---|---|
| `backend/` | Bun + Hono + Baileys + LINEJS |
| `frontend/` | Splash page (Phase 1) |
| `package/` | Tauri 2 Mac app |
| `spec/` | Docs (Bruno cases live in the shared workspace at `../spec/bruno/SM/collections/companion/`) |
| `data/` | Packaged / default runtime files (gitignored) |
| `data-dev/` | `scripts/run.sh` runtime files (gitignored) |

## Dev

```bash
./scripts/run.sh
```

API: `http://127.0.0.1:38000` (data in `data-dev/`). Vite HMR: `http://127.0.0.1:5178`. Copy `token` from `data-dev/config.json` for REST calls. The packaged app is left on `:38888` with its own data.

Bruno contract tests (server already running). Install `@usebruno/cli` if `bru` is not on PATH:

```bash
cd ../spec/bruno/SM/collections/companion
bru run im/test -r --env-file ../../environments/dev-companion.yml
```

Set `token` in `spec/bruno/SM/environments/dev-companion.yml` to the value in `data-dev/config.json`.

## Mac app

```bash
cd backend && bun run compile
cd ../package && bun install && bun run build
```

DMG: `package/tauri/target/release/bundle/dmg/`. Tray + start at login. Closing the window hides the app; Quit stops linked sessions.

## Install

Download from [Releases](https://github.com/tinyeeliu/ai-companion/releases):

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `AICompanion-macos-aarch64.dmg` |
| Windows (x64) | `AICompanion-windows-x64-setup.exe` |

Installers are not code-signed or notarized, so the OS warns on first launch.

**macOS**: open the DMG and drag AICompanion into Applications.

1. Open the app. Gatekeeper reports "Apple could not verify ... is free of malware".
2. Allow it once, either way:
   - System Settings → Privacy & Security → scroll to Security → **Open Anyway**
   - or `xattr -dr com.apple.quarantine /Applications/AICompanion.app`

Right-click → Open does not bypass this on macOS 15+.

**Windows**: if SmartScreen shows "Windows protected your PC", choose **More info** → **Run anyway**.

### Release builds

Tag `main` to build and publish both installers:

```bash
./scripts/tag_release.sh
```

The tag (`*-companion`) starts `.github/workflows/deploy-companion.yaml`.

## API

All routes except health need `Authorization: Bearer <token>`.

See `spec/doc/Architecture.md`.
