import { createApp } from './app';
import { ConnectionManager } from './manager';
import { MessageStore, PRUNE_INTERVAL_MS, messagesPath } from './messages';
import { MEDIA_PRUNE_INTERVAL_MS, MediaCacheStore, mediaDir, mediaPath } from './media/store';
import { linejsFactory } from './line';
import { dataDir, ensureDir, listenPort } from './paths';
import { ConnectionStore } from './store';
import { loadOrCreateConfig } from './token';
import { QUEUE_TICK_MS } from './types';
import { baileysFactory } from './whatsapp';

const port = listenPort();
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

// Wakes normally drive the queue (link hello, session connect). This is the
// safety net that also retires rows past the 1-hour delivery window.
manager.tickQueue();
setInterval(() => {
  try {
    manager.tickQueue();
  } catch (error) {
    console.warn('[companion] queue tick failed', error);
  }
}, QUEUE_TICK_MS);

const app = createApp({ manager, token: config.token, port: config.port });

console.log(`[companion] listening on http://127.0.0.1:${config.port}`);
console.log(`[companion] data ${root}`);

export default {
  port: config.port,
  hostname: '127.0.0.1',
  fetch: app.fetch,
};
