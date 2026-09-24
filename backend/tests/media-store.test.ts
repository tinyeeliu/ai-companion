import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { proto } from '@whiskeysockets/baileys';
import { ConnectionMediaCache, encodeMediaProto } from '../src/media/cache';
import { normalizeSha256, sha256Base64Url } from '../src/media/sha';
import {
  MEDIA_MAX_BYTES,
  MEDIA_PROTO_TTL_MS,
  MEDIA_RETENTION_MS,
  MEDIA_STORED_URL_TTL_MS,
  MediaCacheStore,
  extensionForMime,
  mediaDir,
  mediaPath,
  mimeForExtension,
} from '../src/media/store';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'companion-media-'));
  dirs.push(dir);
  return dir;
}

interface Fixture {
  root: string;
  store: MediaCacheStore;
  blobs: string;
}

function fixture(): Fixture {
  const root = tempRoot();
  return { root, store: new MediaCacheStore(mediaPath(root), mediaDir(root)), blobs: mediaDir(root) };
}

const BYTES = new Uint8Array([9, 8, 7, 6]);
const SHA = sha256Base64Url(BYTES);
const OTHER_BYTES = new Uint8Array([1, 1, 1, 1]);
const OTHER_SHA = sha256Base64Url(OTHER_BYTES);

function imageProto(options: {
  sha256?: string;
  length?: number;
  mimetype?: string;
}): Uint8Array {
  const message = proto.Message.fromObject({
    imageMessage: {
      url: 'https://mmg.whatsapp.net/v/t62/abc.enc',
      directPath: '/v/t62/abc',
      mimetype: options.mimetype ?? 'image/jpeg',
      fileLength: options.length ?? BYTES.byteLength,
      ...(options.sha256 == null ? {} : { fileSha256: Buffer.from(options.sha256, 'base64url') }),
    },
  });
  return proto.Message.encode(message).finish();
}

describe('extensionForMime', () => {
  test('maps known mimes and derives a name for the rest', () => {
    expect(extensionForMime('image/jpeg')).toBe('jpeg');
    expect(extensionForMime('image/jpeg; charset=binary')).toBe('jpeg');
    expect(extensionForMime('video/mp4')).toBe('mp4');
    expect(extensionForMime('application/x-whatsapp-thing')).toBe('xwhatsappthing');
    expect(extensionForMime(undefined)).toBe('bin');
    expect(mimeForExtension('jpeg')).toBe('image/jpeg');
    expect(mimeForExtension(null)).toBeUndefined();
  });
});

describe('MediaCacheStore', () => {
  test('stores plaintext as a content-addressed blob and reads it back', () => {
    const { store, blobs } = fixture();
    const row = store.put({
      connectionId: 'wa-1',
      sha256: SHA,
      length: BYTES.byteLength,
      mime: 'image/jpeg',
      source: 'in',
      bytes: BYTES,
    });

    expect(row.sha256).toBe(SHA);
    expect(row.ext).toBe('jpeg');
    expect(row.blob).toBe(`${SHA}.jpeg`);
    expect(existsSync(join(blobs, `${SHA}.jpeg`))).toBe(true);
    expect(store.readBytes('wa-1', SHA)).toEqual(BYTES);
    expect(store.readBytes('wa-1', OTHER_SHA)).toBeNull();
  });

  test('accepts any digest spelling as the key', () => {
    const { store } = fixture();
    store.put({ connectionId: 'wa-1', sha256: SHA, length: 1, source: 'in', bytes: BYTES });
    const padded = Buffer.from(createDigest()).toString('base64');
    expect(store.get('wa-1', padded)?.sha256).toBe(SHA);
    expect(store.readBytes('wa-1', padded)).toEqual(BYTES);
    expect(store.get('wa-1', 'not-a-digest')).toBeUndefined();
  });

  test('one file on disk for one content, findable from another connection', () => {
    const { store, blobs } = fixture();
    store.put({
      connectionId: 'wa-1',
      sha256: SHA,
      length: 2,
      mime: 'image/jpeg',
      source: 'in',
      bytes: BYTES,
    });
    // wa-2 learns the digest from a proto, so it has meta but never had the bytes.
    store.put({ connectionId: 'wa-2', sha256: SHA, length: 2, mime: 'image/jpeg', source: 'out' });

    expect(readdirSync(blobs)).toEqual([`${SHA}.jpeg`]);
    expect(store.get('wa-2', SHA)?.blob).toBe(`${SHA}.jpeg`);
    expect(store.readBytes('wa-2', SHA)).toEqual(BYTES);
  });

  test('the first name a content gets is the one it keeps', () => {
    const { store, blobs } = fixture();
    // Same bytes, a mime learned late: the file must not move, or the earlier
    // row would point at a path that no longer exists.
    store.put({ connectionId: 'wa-1', sha256: SHA, length: 2, source: 'in', bytes: BYTES });
    store.put({ connectionId: 'wa-1', sha256: SHA, length: 2, mime: 'image/jpeg', source: 'in' });

    expect(readdirSync(blobs)).toEqual([`${SHA}.bin`]);
    expect(store.readBytes('wa-1', SHA)).toEqual(BYTES);
    // The mime is still learned, so a send can declare it.
    expect(store.get('wa-1', SHA)?.mime).toBe('image/jpeg');
  });

  test('a row without bytes reports no plaintext rather than inventing one', () => {
    const { store } = fixture();
    store.put({ connectionId: 'wa-1', sha256: SHA, length: 4, source: 'out' });
    expect(store.get('wa-1', SHA)?.blob).toBeNull();
    expect(store.readBytes('wa-1', SHA)).toBeNull();
  });

  test('a url is a second key onto the same content', () => {
    const { store } = fixture();
    store.put({ connectionId: 'wa-1', sha256: SHA, length: 1, source: 'out', bytes: BYTES });
    store.rememberUrl({ connectionId: 'wa-1', url: 'https://cdn.example.com/a.jpg', sha256: SHA, role: 'stored' });

    expect(store.shaForUrl('wa-1', 'https://cdn.example.com/a.jpg')).toBe(SHA);
    // Another connection has not seen that url, and must not be handed it.
    expect(store.shaForUrl('wa-2', 'https://cdn.example.com/a.jpg')).toBeNull();
    expect(store.listUrls('wa-1', SHA).map((row) => row.role)).toEqual(['stored']);
  });

  test('a stored url is only offered while it is still fresh', () => {
    const { store } = fixture();
    const now = Date.now();
    store.put({ connectionId: 'wa-1', sha256: SHA, length: 1, source: 'out', bytes: BYTES });
    store.rememberUrl({
      connectionId: 'wa-1',
      url: 'https://cdn.example.com/old.jpg',
      sha256: SHA,
      role: 'stored',
      urlAt: now,
    });
    store.rememberUrl({
      connectionId: 'wa-1',
      url: 'https://cdn.example.com/new.jpg',
      sha256: SHA,
      role: 'stored',
      urlAt: now + 1,
    });
    // A vendor url is encrypted, so it is never handed out as a fetchable one.
    store.rememberUrl({ connectionId: 'wa-1', url: 'https://mmg.whatsapp.net/x.enc', sha256: SHA, role: 'vendor' });

    expect(store.storedUrl('wa-1', SHA, now + 2)).toBe('https://cdn.example.com/new.jpg');
    expect(store.storedUrl('wa-1', SHA, now + MEDIA_STORED_URL_TTL_MS + 10)).toBeNull();
  });

  test('age retires rows and unlinks the blobs nothing points at', () => {
    const { store, blobs } = fixture();
    store.put({ connectionId: 'wa-1', sha256: SHA, length: 1, source: 'in', bytes: BYTES });
    expect(readdirSync(blobs)).toHaveLength(1);

    const result = store.prune(Date.now() + MEDIA_RETENTION_MS + 1_000);
    expect(result.objects).toBe(1);
    expect(result.files).toBe(1);
    expect(readdirSync(blobs)).toHaveLength(0);
    expect(store.get('wa-1', SHA)).toBeUndefined();
  });

  test('the byte ceiling evicts least-recently-used objects', () => {
    const { store } = fixture();
    // Meta only: a declared length large enough to breach the ceiling without
    // writing half a gigabyte of test fixture.
    const each = Math.ceil(MEDIA_MAX_BYTES / 4);
    const shas = [0, 1, 2, 3, 4].map((i) => sha256Base64Url(new Uint8Array([i])));
    shas.forEach((sha, index) => {
      store.put({ connectionId: 'wa-1', sha256: sha, length: each, source: 'out' });
      // Distinct use times, so "least recently used" has an order to obey.
      store.touch('wa-1', sha, Date.now() + index);
    });

    const result = store.prune();
    expect(result.objects).toBeGreaterThan(0);
    // The oldest are the ones that go.
    expect(store.get('wa-1', shas[0]!)).toBeUndefined();
    expect(store.get('wa-1', shas[4]!)).toBeDefined();
  });

  test('prune never spins on one object larger than the whole ceiling', () => {
    const { store } = fixture();
    store.put({ connectionId: 'wa-1', sha256: SHA, length: MEDIA_MAX_BYTES * 2, source: 'out' });
    const result = store.prune();
    expect(result.objects).toBe(1);
    expect(store.get('wa-1', SHA)).toBeUndefined();
  });

  test('forgetting a connection keeps the blob another one still points at', () => {
    const { store, blobs } = fixture();
    const input = { sha256: SHA, length: 1, mime: 'image/jpeg', source: 'in' as const, bytes: BYTES };
    store.put({ ...input, connectionId: 'wa-1' });
    store.put({ ...input, connectionId: 'wa-2' });

    expect(store.deleteForConnection('wa-1')).toBe(1);
    expect(existsSync(join(blobs, `${SHA}.jpeg`))).toBe(true);
    expect(store.readBytes('wa-2', SHA)).toEqual(BYTES);

    store.deleteForConnection('wa-2');
    expect(existsSync(join(blobs, `${SHA}.jpeg`))).toBe(false);
  });

  test('drops a url row whose object has gone', () => {
    const { store } = fixture();
    store.put({ connectionId: 'wa-1', sha256: SHA, length: 1, source: 'in', bytes: BYTES });
    store.rememberUrl({ connectionId: 'wa-1', url: 'https://cdn.example.com/a.jpg', sha256: SHA, role: 'stored' });
    store.deleteForConnection('wa-1');
    expect(store.findUrl('wa-1', 'https://cdn.example.com/a.jpg')).toBeUndefined();
  });

  test('refuses a key that is not a digest rather than caching under it', () => {
    const { store } = fixture();
    expect(() =>
      store.put({ connectionId: 'wa-1', sha256: 'photo.jpeg', length: 1, source: 'in', bytes: BYTES }),
    ).toThrow();
    expect(store.shaForUrl('wa-1', '')).toBeNull();
  });
});

describe('ConnectionMediaCache as a Baileys media cache', () => {
  test('captures the proto an upload produced and serves it back by url', () => {
    const { store } = fixture();
    const cache = new ConnectionMediaCache(store, 'wa-1');
    const url = 'https://workspace.example.com/temp/first.jpg';
    cache.rememberUrl({ url, sha256: SHA, role: 'stored', kind: 'image' });

    // Baileys hands the encoded proto back on its way out of an upload.
    cache.baileys.set(`image:${url}`, imageProto({ sha256: SHA }));

    expect(cache.hasProto(SHA)).toBe(true);
    expect(cache.baileys.get<Uint8Array>(`image:${url}`)).toEqual(imageProto({ sha256: SHA }));
    // An unknown url is a miss, however good the proto is.
    expect(cache.baileys.get(`image:https://elsewhere.example.com/x.jpg`)).toBeUndefined();
  });

  test('a proto the cache receives teaches it the digest, length and mime', () => {
    const { store } = fixture();
    const cache = new ConnectionMediaCache(store, 'wa-1');
    expect(cache.row(SHA)).toBeUndefined();

    cache.baileys.set('image:https://workspace.example.com/temp/first.jpg', imageProto({ sha256: SHA, length: 4321 }));

    const row = cache.row(SHA);
    expect(row?.source).toBe('out');
    expect(row?.length).toBe(4321);
    expect(row?.mime).toBe('image/jpeg');
    expect(row?.hasProto).toBe(true);
  });

  test('a proto that carries no digest is not stored under a guess', () => {
    const { store } = fixture();
    const cache = new ConnectionMediaCache(store, 'wa-1');
    cache.baileys.set('image:https://x/a.jpg', imageProto({}));
    expect(cache.baileys.get('image:https://x/a.jpg')).toBeUndefined();
  });

  test('ignores values and keys that are not media', () => {
    const { store } = fixture();
    const cache = new ConnectionMediaCache(store, 'wa-1');
    cache.baileys.set('image:https://x/a.jpg', 'not bytes');
    cache.baileys.set('nocolon', imageProto({ sha256: SHA }));
    expect(cache.baileys.get('image:')).toBeUndefined();
    expect(cache.hasProto(SHA)).toBe(false);
  });

  test('a vendor proto expires, because its CDN url does', () => {
    const { store } = fixture();
    const cache = new ConnectionMediaCache(store, 'wa-1');
    const url = 'https://workspace.example.com/temp/first.jpg';
    cache.rememberUrl({ url, sha256: SHA, role: 'stored', kind: 'image' });
    const now = Date.now();
    store.putProto('wa-1', SHA, imageProto({ sha256: SHA }), { now });

    expect(store.getProto('wa-1', SHA, now + MEDIA_PROTO_TTL_MS - 1)).not.toBeNull();
    expect(store.getProto('wa-1', SHA, now + MEDIA_PROTO_TTL_MS + 1)).toBeNull();
    // Pruning clears the stale proto and reports it.
    expect(store.prune(now + MEDIA_PROTO_TTL_MS + 1).protos).toBe(1);
    expect(cache.hasProto(SHA)).toBe(false);
  });

  test('stored bytes are reported with the mime a send needs', () => {
    const { store } = fixture();
    const cache = new ConnectionMediaCache(store, 'wa-1');
    cache.putBytes({ sha256: SHA, bytes: BYTES, mime: 'image/png', source: 'out' });

    expect(cache.readBytes(SHA)).toEqual(BYTES);
    expect(cache.mimeFor(SHA)).toBe('image/png');
    expect(cache.lengthFor(SHA)).toBe(BYTES.byteLength);
    expect(cache.blobPath(SHA)?.endsWith(`${SHA}.png`)).toBe(true);
  });

  test('a normalizing digest is the same key whichever spelling arrives', () => {
    const { store } = fixture();
    const cache = new ConnectionMediaCache(store, 'wa-1');
    cache.putBytes({ sha256: SHA, bytes: BYTES, source: 'in' });
    const padded = Buffer.from(createDigest()).toString('base64');
    expect(cache.row(padded)?.sha256).toBe(SHA);
    expect(normalizeSha256(padded)).toBe(SHA);
  });

  test('forgetting a connection leaves the other one alone', () => {
    const { store } = fixture();
    const one = new ConnectionMediaCache(store, 'wa-1');
    const two = new ConnectionMediaCache(store, 'wa-2');
    one.putBytes({ sha256: SHA, bytes: BYTES, source: 'in' });
    two.putBytes({ sha256: SHA, bytes: BYTES, source: 'in' });

    expect(one.forget()).toBe(1);
    expect(one.readBytes(SHA)).toBeNull();
    expect(two.readBytes(SHA)).toEqual(BYTES);
  });
});

describe('WhatsApp expiry on a cached proto', () => {
  test('records the declared expiry and refuses reuse once it passes', () => {
    const { store } = fixture();
    const now = Date.now();
    const expiresAt = now + 60_000;
    // The inbound shape: bytes and proto arrive together, on the same row.
    store.put({ connectionId: 'wa-1', sha256: SHA, length: BYTES.byteLength, source: 'in', bytes: BYTES });
    store.putProto('wa-1', SHA, imageProto({ sha256: SHA }), { waExpiresAt: expiresAt, now });

    expect(store.get('wa-1', SHA)?.waExpiresAt).toBe(expiresAt);
    expect(store.getProto('wa-1', SHA, now + 1)).not.toBeNull();
    expect(store.getProto('wa-1', SHA, expiresAt - 1)).not.toBeNull();
    // At the declared expiry the blob is gone, however fresh the row still is.
    expect(store.getProto('wa-1', SHA, expiresAt)).toBeNull();
    expect(store.protoExpiry('wa-1', SHA)).toBe(expiresAt);
  });

  test('a proto that declared no expiry keeps the conservative fallback', () => {
    const { store } = fixture();
    const now = Date.now();
    store.putProto('wa-1', SHA, imageProto({ sha256: SHA }), { now });

    expect(store.protoExpiry('wa-1', SHA)).toBeNull();
    expect(store.getProto('wa-1', SHA, now + MEDIA_PROTO_TTL_MS - 1)).not.toBeNull();
    expect(store.getProto('wa-1', SHA, now + MEDIA_PROTO_TTL_MS + 1)).toBeNull();
  });

  test('prune clears a proto whose declared expiry has passed, and only then', () => {
    const { store } = fixture();
    const now = Date.now();
    store.putProto('wa-1', SHA, imageProto({ sha256: SHA }), {
      waExpiresAt: now + 1_000,
      now,
    });

    // Still live, so the fallback TTL must not retire it early.
    expect(store.prune(now + 1_000 - 1).protos).toBe(0);
    expect(store.prune(now + 1_000).protos).toBe(1);
    expect(store.getProto('wa-1', SHA, now + 1_000)).toBeNull();
    expect(store.protoExpiry('wa-1', SHA)).toBeNull();
  });

  test('a new proto replaces the old one expiry too', () => {
    const { store } = fixture();
    const now = Date.now();
    store.putProto('wa-1', SHA, imageProto({ sha256: SHA }), { waExpiresAt: now + 5_000, now });
    store.putProto('wa-1', SHA, imageProto({ sha256: SHA }), { now: now + 1 });
    expect(store.protoExpiry('wa-1', SHA)).toBeNull();
  });
});

describe('encodeMediaProto', () => {
  test('round-trips the locator and key a re-send needs', () => {
    const encoded = encodeMediaProto('image', {
      url: 'https://mmg.whatsapp.net/v/x.enc?oe=6ADCAB3C',
      directPath: '/v/x.enc?oe=6ADCAB3C',
      mediaKey: Buffer.alloc(32, 1),
      fileEncSha256: Buffer.alloc(32, 2),
      fileSha256: Buffer.alloc(32, 3),
      fileLength: 1234,
      mediaKeyTimestamp: 1_790_248_346,
      mimetype: 'image/jpeg',
    });
    expect(encoded).not.toBeNull();

    const decoded = proto.Message.decode(encoded!).imageMessage;
    expect(decoded?.url).toBe('https://mmg.whatsapp.net/v/x.enc?oe=6ADCAB3C');
    expect(decoded?.directPath).toBe('/v/x.enc?oe=6ADCAB3C');
    expect(decoded?.mediaKey?.byteLength).toBe(32);
    expect(decoded?.fileSha256?.byteLength).toBe(32);
    // `fileLength` is a uint64, so it decodes as a Long rather than a number —
    // exactly the reason the media cache has its own numeric coercion.
    expect(Number(decoded?.fileLength)).toBe(1234);
    expect(decoded?.mimetype).toBe('image/jpeg');
  });

  test('a kind with no proto field is refused rather than guessed at', () => {
    expect(encodeMediaProto('poll', { url: 'https://mmg.whatsapp.net/x.enc' })).toBeNull();
  });
});

describe('migrate', () => {
  test('adds the expiry column to a database written before it existed', () => {
    const root = tempRoot();
    const path = mediaPath(root);
    // The pre-expiry schema, plus a row: this has to be a real upgrade, not a
    // fresh create that the current DDL would have handled anyway.
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE "MediaObject" (
        connection_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        length INTEGER NOT NULL DEFAULT 0,
        mime TEXT,
        ext TEXT,
        file_name TEXT,
        source TEXT NOT NULL DEFAULT 'in',
        blob TEXT,
        proto BLOB,
        proto_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (connection_id, sha256)
      );
      CREATE TABLE "MediaUrl" (
        connection_id TEXT NOT NULL,
        url TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'vendor',
        kind TEXT,
        url_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        PRIMARY KEY (connection_id, url)
      );
    `);
    legacy
      .query(
        `INSERT INTO "MediaObject"
           (connection_id, sha256, length, source, created_at, updated_at, last_used_at, hits)
         VALUES (?, ?, ?, 'in', ?, ?, ?, 0)`,
      )
      .run('wa-1', SHA, BYTES.byteLength, 1, 1, 1);
    legacy.close();

    const store = new MediaCacheStore(path, mediaDir(root));
    // The old row survives, and reads as "declared no expiry".
    expect(store.get('wa-1', SHA)?.waExpiresAt).toBeNull();
    // And the column really is writable afterwards.
    const expiresAt = 1_792_846_652_000;
    store.putProto('wa-1', SHA, imageProto({ sha256: SHA }), { waExpiresAt: expiresAt });
    expect(store.protoExpiry('wa-1', SHA)).toBe(expiresAt);
  });
});

/** The raw digest of BYTES, for the padded-base64 cases. */
function createDigest(): Uint8Array {
  return new Uint8Array(Buffer.from(SHA, 'base64url'));
}

describe('media paths', () => {
  test('sit beside the message store, in their own files', () => {
    const root = tempRoot();
    expect(mediaPath(root)).toBe(join(root, 'media.sqlite'));
    expect(mediaDir(root)).toBe(join(root, 'media'));
    // Not the queue's file: clearing the cache must never touch it.
    expect(mediaPath(root)).not.toBe(join(root, 'messages.sqlite'));
  });

  test('creating the store makes the blob folder', () => {
    const root = tempRoot();
    new MediaCacheStore(mediaPath(root), mediaDir(root));
    expect(existsSync(mediaDir(root))).toBe(true);
    // A pre-existing stray file is not mistaken for a reference.
    writeFileSync(join(mediaDir(root), 'stray.bin'), 'x');
    const store = new MediaCacheStore(mediaPath(root), mediaDir(root));
    expect(store.prune().files).toBe(1);
  });
});
