import { createApp } from './app';
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
const drawThings = drawThingsRunner();
const cliReady = await drawThings.available();
const gen = cliReady ? new GenQueue(drawThings) : null;
if (cliReady) {
  // Warm the default model at boot so no request ever pays a multi-gigabyte
  // download, and every `generate` can then run with `--offline`.
  drawThings
    .ensureModel(DEFAULT_MODEL)
    .catch((error: unknown) => console.warn('[companion] model warm-up failed', error));
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
console.log(`[companion] image generation ${cliReady ? 'ready' : 'unavailable (draw-things-cli not found)'}`);

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
