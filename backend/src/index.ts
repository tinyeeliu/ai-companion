import { createApp } from './app';
import { existsSync } from 'node:fs';
import { ConnectionManager } from './manager';
import { MessageStore, PRUNE_INTERVAL_MS, messagesPath } from './messages';
import { MEDIA_PRUNE_INTERVAL_MS, MediaCacheStore, mediaDir, mediaPath } from './media/store';
import { GEN_PRUNE_INTERVAL_MS, genStore } from './gen/store';
import { drawThingsRunner } from './gen/drawthings';
import { GenQueue } from './gen/queue';
import { DEFAULT_MODEL } from './gen';
import { linejsFactory } from './line';
import { dataDir, ensureDir, genDir, listenHost, listenPort } from './paths';
import { ConnectionStore } from './store';
import { loadOrCreateConfig } from './token';
import { QUEUE_TICK_MS } from './types';
import { baileysFactory } from './whatsapp';

const port = listenPort();
const host = listenHost();
const root = dataDir();
ensureDir(root);
const config = loadOrCreateConfig(root, port);
const messages = new MessageStore(messagesPath(root));
messages.prune();
setInterval(() => {
  try {
    messages.prune();
  } catch (error) {
    console.warn('[companion] prune failed', error);
  }
}, PRUNE_INTERVAL_MS);
// One file and one folder, separate from `messages.sqlite` on purpose: the cache
// is regenerable, so clearing it is `rm -rf data/media data/media.sqlite` and can
// never touch the durable delivery queue.
const media = new MediaCacheStore(mediaPath(root), mediaDir(root));
media.prune();
setInterval(() => {
  try {
    media.prune();
  } catch (error) {
    console.warn('[companion] media prune failed', error);
  }
}, MEDIA_PRUNE_INTERVAL_MS);
const manager = new ConnectionManager(
  new ConnectionStore(root),
  baileysFactory,
  fetch,
  linejsFactory,
  messages,
  media,
);
await manager.restoreEnabled();

// Image generation. The CLI is optional: a machine without it (or a packaged
// build that never installed it) still runs Companion in full, it just answers
// 503 on the image routes. Probed once here rather than per request.
//
// The models directory comes from `data/config.json` first, then the
// environment. It cannot be env-only: an external supervisor (Devctl) spawns
// `companion/scripts/run.sh` with no environment of its own, so a variable
// exported in a developer's shell never reaches this process. The persisted
// value travels with the data directory and works however Companion was started.
const drawThings = drawThingsRunner({ modelsDir: config.modelsDir ?? undefined });
const cliReady = await drawThings.available();
const gen = cliReady ? new GenQueue(drawThings) : null;
const modelsDir = drawThings.modelsDirectory();
if (cliReady) {
  // A configured-but-absent directory (an unmounted external drive, usually)
  // should be obvious at boot rather than surfacing as a confusing "model files
  // are missing" on the first request.
  if (modelsDir != null && !existsSync(modelsDir)) {
    console.warn(
      `[companion] models directory does not exist: ${modelsDir} — image generation will fail until it is mounted`,
    );
  } else {
    verifyDefaultModel(drawThings, modelsDir);
  }
}
const genImages = genStore(genDir(root));
genImages.prune();
setInterval(() => {
  try {
    genImages.prune();
  } catch (error) {
    console.warn('[companion] gen prune failed', error);
  }
}, GEN_PRUNE_INTERVAL_MS);
console.log(
  `[companion] image generation ${cliReady ? 'ready' : 'unavailable (draw-things-cli not found)'}${
    cliReady ? ` (models: ${modelsDir ?? 'cli default'})` : ''
  }`,
);

// Wakes normally drive the queue (link init, session connect). This is the
// safety net that also retires rows past the 1-hour delivery window.
manager.tickQueue();
setInterval(() => {
  try {
    manager.tickQueue();
  } catch (error) {
    console.warn('[companion] queue tick failed', error);
  }
}, QUEUE_TICK_MS);

const app = createApp({
  manager,
  token: config.token,
  port: config.port,
  configRoot: root,
  ...(gen != null ? { gen: { queue: gen, drawThings, store: genImages, ready: cliReady } } : {}),
});

console.log(`[companion] listening on http://${host}:${config.port}`);
console.log(`[companion] local UI http://127.0.0.1:${config.port}`);
if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
  console.log('[companion] bound beyond loopback: non-local callers must send Authorization: Bearer <token>');
}
console.log(`[companion] data ${root}`);

export default {
  port: config.port,
  hostname: host,
  fetch: app.fetch,
};

/**
 * Verify the default model is present, without downloading it.
 *
 * This deliberately does **not** call `models ensure`. Every `generate` runs
 * `--offline`, so a model that is absent cannot be used anyway; fetching it at
 * boot would only mean the first request silently populates a directory the
 * operator may have curated by hand. Worse, with a configured `--models-dir`
 * pointing at an external drive that does not hold the default model, `ensure`
 * would start a multi-gigabyte download onto that drive — an unintended write
 * from simply starting the server.
 *
 * `listModels` already scopes to the resolved directory and asks for
 * downloaded-only, so it is the same question a `generate` asks.
 */
function verifyDefaultModel(drawThings: ReturnType<typeof drawThingsRunner>, modelsDir: string | undefined): void {
  drawThings
    .listModels()
    .then((downloaded) => {
      if (!downloaded.includes(DEFAULT_MODEL)) {
        console.warn(
          `[companion] ${DEFAULT_MODEL} is not downloaded in ${modelsDir ?? 'the CLI default models directory'} — requests for it will fail; run \`draw-things-cli models ensure --model ${DEFAULT_MODEL}\` yourself to fetch it`,
        );
      }
    })
    .catch((error: unknown) => {
      // A listing failure is not fatal: requests may still work if the model is
      // there and only the catalog read failed.
      console.warn(`[companion] could not list models to verify ${DEFAULT_MODEL}`, error);
    });
}
