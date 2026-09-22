# AI Companion Mac package

Tauri 2 tray app. Window loads `http://127.0.0.1:38888`. Closing hides to the tray; Quit stops the Bun sidecar.

```bash
# backend already running is fine; otherwise the sidecar starts it
cd package
bun install
bun run dev
```

Apple Silicon DMG:

```bash
cd ../backend && bun run compile   # optional compiled sidecar
cd ../package && bun run build
```

Output: `tauri/target/release/bundle/dmg/`.
