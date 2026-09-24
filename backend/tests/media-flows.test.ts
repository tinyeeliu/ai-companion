import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { proto } from '@whiskeysockets/baileys';
import { ConnectionMediaCache } from '../src/media/cache';
import { resolveOutboundContent } from '../src/media/outbound';
import { normalizeSha256, sha256Base64Url } from '../src/media/sha';
import { MediaCacheStore, mediaDir, mediaPath } from '../src/media/store';
import { cachedCompanionMedia } from '../src/whatsapp';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function cacheFor(connectionId = 'wa-1'): ConnectionMediaCache {
  const root = mkdtempSync(join(tmpdir(), 'companion-flows-'));
  dirs.push(root);
  return new ConnectionMediaCache(new MediaCacheStore(mediaPath(root), mediaDir(root)), connectionId);
}

const BYTES = new Uint8Array([4, 4, 4, 4]);
const SHA = sha256Base64Url(BYTES);

/** A fetch stand-in that counts calls and answers with fixed bytes. */
function fetcher(result: Uint8Array | null): { calls: string[]; fetchBytes: (url: string) => Promise<Uint8Array | null> } {
  const calls: string[] = [];
  return {
    calls,
    fetchBytes: async (url: string) => {
      calls.push(url);
      return result;
    },
  };
}

describe('resolveOutboundContent', () => {
  test('fetches an unknown url once, then serves it from disk', async () => {
    const cache = cacheFor();
    const url = 'https://workspace.example.com/temp/photo.jpg';
    const { calls, fetchBytes } = fetcher(BYTES);
    const options = { cache, fetchBytes, blobPath: (sha: string) => cache.blobPath(sha) };

    const first = await resolveOutboundContent({ content: { image: { url } }, ...options });
    expect(calls).toEqual([url]);
    const path = (first as { image: { url: string } }).image.url;
    expect(path).not.toBe(url);
    expect(existsSync(path)).toBe(true);
    expect(cache.readBytes(SHA)).toEqual(BYTES);
    expect(cache.shaForUrl(url)).toBe(SHA);

    // Second time the bytes are local, so nothing is fetched at all.
    const second = await resolveOutboundContent({ content: { image: { url } }, ...options });
    expect(calls).toEqual([url]);
    expect((second as { image: { url: string } }).image.url).toBe(path);
  });

  test('a declared digest plus cached bytes need no network at all', async () => {
    const cache = cacheFor();
    cache.putBytes({ sha256: SHA, bytes: BYTES, mime: 'image/png', source: 'in' });
    const { calls, fetchBytes } = fetcher(BYTES);

    const resolved = (await resolveOutboundContent({
      content: { image: { url: 'https://cdn.example.com/a.png', sha256: SHA }, caption: 'hi' },
      cache,
      fetchBytes,
      blobPath: (sha) => cache.blobPath(sha),
    })) as { image: { url: string; mimetype?: string }; caption?: string };

    expect(calls).toEqual([]);
    expect(existsSync(resolved.image.url)).toBe(true);
    // Baileys would otherwise declare image/jpeg for every image it uploads.
    expect(resolved.image.mimetype).toBe('image/png');
    // The caller's own fields still ride along.
    expect(resolved.caption).toBe('hi');
  });

  test('an accepted proto leaves the content untouched, so Baileys skips both halves', async () => {
    const cache = cacheFor();
    const url = 'https://workspace.example.com/temp/photo.jpg';
    const content = { image: { url }, caption: 'still here' };
    cache.rememberUrl({ url, sha256: SHA, role: 'stored', kind: 'image' });
    cache.putBytes({ sha256: SHA, bytes: BYTES, mime: 'image/jpeg', source: 'out' });
    // An upload already happened; this is the proto Baileys handed back.
    cache.rememberProto(`image:${url}`, encodedImageProto(SHA));
    const { calls, fetchBytes } = fetcher(BYTES);

    const resolved = await resolveOutboundContent({
      content,
      cache,
      fetchBytes,
      blobPath: (sha) => cache.blobPath(sha),
    });

    expect(resolved).toBe(content);
    expect(calls).toEqual([]);
  });

  test('a proto learned from an inbound message is reused with no network at all', async () => {
    const cache = cacheFor();
    const bytes = new Uint8Array([6, 6, 6]);
    const sha = sha256Base64Url(bytes);
    // The cloud's own stored url, which is what it names on the echo reply.
    const url = 'https://workspace.example.com/temp/echo.jpeg';
    // Exactly what `rememberInboundMedia` writes after a download: the plaintext,
    // the url it uploaded to, and the proto WhatsApp already accepted.
    cache.putBytes({ sha256: sha, bytes, mime: 'image/jpeg', source: 'in' });
    cache.rememberUrl({ url, sha256: sha, role: 'stored', kind: 'image' });
    cache.putProto(sha, encodedImageProto(sha), { waExpiresAt: Date.now() + 86_400_000 });

    const content = { image: { url, sha256: sha } };
    const { calls, fetchBytes } = fetcher(bytes);

    const resolved = await resolveOutboundContent({
      content,
      cache,
      fetchBytes,
      blobPath: (item) => cache.blobPath(item),
    });

    // Untouched, so Baileys' own mediaCache answers the rest of the way.
    expect(resolved).toBe(content);
    expect(calls).toEqual([]);
    expect(cache.protoExpiry(sha)).not.toBeNull();
  });

  test('an expired inbound proto is not reused, so the bytes get re-uploaded', async () => {
    const cache = cacheFor();
    const bytes = new Uint8Array([6, 6, 6]);
    const sha = sha256Base64Url(bytes);
    const url = 'https://workspace.example.com/temp/echo.jpeg';
    cache.putBytes({ sha256: sha, bytes, mime: 'image/jpeg', source: 'in' });
    cache.rememberUrl({ url, sha256: sha, role: 'stored', kind: 'image' });
    // An expiry already passed: WhatsApp no longer serves this blob.
    cache.putProto(sha, encodedImageProto(sha), { waExpiresAt: Date.now() - 1 });

    const { calls, fetchBytes } = fetcher(bytes);
    const resolved = (await resolveOutboundContent({
      content: { image: { url, sha256: sha } },
      cache,
      fetchBytes,
      blobPath: (item) => cache.blobPath(item),
    })) as { image: { url: string } };

    expect(cache.hasProto(sha)).toBe(false);
    // The plaintext is still local, so it re-uploads from a file — no download.
    expect(resolved.image.url).not.toBe(url);
    expect(existsSync(resolved.image.url)).toBe(true);
    expect(calls).toEqual([]);
  });

  test('a url-only repeat is recognised without any digest hint', async () => {
    const cache = cacheFor();
    const url = 'https://workspace.example.com/temp/photo.jpg';
    const { calls, fetchBytes } = fetcher(BYTES);
    const options = { cache, fetchBytes, blobPath: (sha: string) => cache.blobPath(sha) };

    await resolveOutboundContent({ content: { image: { url } }, ...options });
    // The same url again, still with no sha: the url is the second key.
    const resolved = (await resolveOutboundContent({ content: { image: { url } }, ...options })) as {
      image: { url: string };
    };

    expect(calls).toHaveLength(1);
    expect(existsSync(resolved.image.url)).toBe(true);
  });

  test('a failed fetch leaves the send exactly as it was', async () => {
    const cache = cacheFor();
    const content = { image: { url: 'https://cdn.example.com/gone.jpg' } };
    const { fetchBytes } = fetcher(null);

    const resolved = await resolveOutboundContent({
      content,
      cache,
      fetchBytes,
      blobPath: (sha) => cache.blobPath(sha),
    });

    expect(resolved).toBe(content);
  });

  test('a declared digest the bytes contradict does not become the key', async () => {
    const cache = cacheFor();
    const wrong = sha256Base64Url(new Uint8Array([0]));
    const url = 'https://workspace.example.com/temp/photo.jpg';
    const { fetchBytes } = fetcher(BYTES);

    await resolveOutboundContent({
      content: { image: { url, sha256: wrong } },
      cache,
      fetchBytes,
      blobPath: (sha) => cache.blobPath(sha),
    });

    expect(cache.readBytes(SHA)).toEqual(BYTES);
    expect(cache.shaForUrl(url)).toBe(SHA);
  });

  test('content with no media, or binary media, is passed straight through', async () => {
    const cache = cacheFor();
    const { calls, fetchBytes } = fetcher(BYTES);
    const options = { cache, fetchBytes, blobPath: (sha: string) => cache.blobPath(sha) };

    const text = { text: 'hello' };
    expect(await resolveOutboundContent({ content: text, ...options })).toBe(text);
    const buffer = { image: Buffer.from(BYTES) };
    expect(await resolveOutboundContent({ content: buffer, ...options })).toBe(buffer);
    expect(await resolveOutboundContent({ content: null, ...options })).toBeNull();
    expect(calls).toEqual([]);
  });

  test('the media key Baileys would choose is the one rewritten', async () => {
    const cache = cacheFor();
    const fetched: string[] = [];
    // Baileys scans MEDIA_KEYS and the last match wins, so a document beats an
    // image. Rewriting the other one would be a silent no-op.
    const content = {
      image: { url: 'https://cdn.example.com/a.jpg' },
      document: { url: 'https://cdn.example.com/b.pdf', fileName: 'b.pdf' },
    };

    const resolved = (await resolveOutboundContent({
      content,
      cache,
      fetchBytes: async (url) => {
        fetched.push(url);
        return BYTES;
      },
      blobPath: (sha) => cache.blobPath(sha),
    })) as { image: { url: string }; document: { url: string; fileName?: string } };

    expect(fetched).toEqual(['https://cdn.example.com/b.pdf']);
    expect(existsSync(resolved.document.url)).toBe(true);
    expect(resolved.document.fileName).toBe('b.pdf');
    expect(resolved.image.url).toBe('https://cdn.example.com/a.jpg');
  });
});

describe('cachedCompanionMedia', () => {
  test('a fresh stored url is handed back with nothing leaving the machine', async () => {
    const cache = cacheFor();
    cache.putBytes({ sha256: SHA, bytes: BYTES, mime: 'image/jpeg', source: 'in' });
    cache.rememberUrl({
      url: 'https://workspace.example.com/temp/photo.jpeg',
      sha256: SHA,
      role: 'stored',
      kind: 'image',
    });
    let uploaded = 0;

    const plan = await cachedCompanionMedia({
      cache,
      kind: 'image',
      sha256: SHA,
      remaining: 1024,
      upload: async () => {
        uploaded += 1;
        return { url: 'https://elsewhere' };
      },
    });

    expect(plan?.block).toEqual({
      url: 'https://workspace.example.com/temp/photo.jpeg',
      mimetype: 'image/jpeg',
      sha256: SHA,
      length: BYTES.byteLength,
    });
    expect(uploaded).toBe(0);
    expect(plan?.remaining).toBe(1024);
  });

  test('cached bytes are uploaded when no usable url is known', async () => {
    const cache = cacheFor();
    cache.putBytes({ sha256: SHA, bytes: BYTES, mime: 'image/jpeg', source: 'in' });
    const uploaded: Uint8Array[] = [];

    const plan = await cachedCompanionMedia({
      cache,
      kind: 'image',
      sha256: SHA,
      remaining: 1024,
      upload: async (bytes) => {
        uploaded.push(bytes);
        return { url: 'https://workspace.example.com/temp/fresh.jpeg' };
      },
    });

    expect(plan?.block?.url).toBe('https://workspace.example.com/temp/fresh.jpeg');
    expect(uploaded).toEqual([BYTES]);
    // Recorded so the next copy needs neither a decrypt nor an upload.
    expect(cache.storedUrl(SHA)).toBe('https://workspace.example.com/temp/fresh.jpeg');
    expect(plan?.remaining).toBe(1024);
  });

  test('with no uploader the bytes ride the frame, and spend its budget', async () => {
    const cache = cacheFor();
    cache.putBytes({ sha256: SHA, bytes: BYTES, mime: 'image/jpeg', source: 'in' });

    const plan = await cachedCompanionMedia({ cache, kind: 'image', sha256: SHA, remaining: 1024 });

    expect(plan?.block?.bytes).toEqual(BYTES);
    expect(plan?.block?.sha256).toBe(SHA);
    expect(plan?.remaining).toBe(1024 - BYTES.byteLength);
  });

  test('a hit too large for the frame is skipped, not truncated', async () => {
    const cache = cacheFor();
    cache.putBytes({ sha256: SHA, bytes: BYTES, mime: 'image/jpeg', source: 'in' });

    const plan = await cachedCompanionMedia({ cache, kind: 'image', sha256: SHA, remaining: 2 });

    expect(plan?.block).toBeNull();
    expect(plan?.remaining).toBe(2);
  });

  test('a miss falls through rather than pretending to have media', async () => {
    const cache = cacheFor();
    // Meta without plaintext: a proto captured on the outbound path.
    cache.rememberUrl({ url: 'https://x/a.jpg', sha256: SHA, role: 'stored', kind: 'image' });

    expect(await cachedCompanionMedia({ cache, kind: 'image', sha256: SHA, remaining: 1024 })).toBeNull();
    expect(await cachedCompanionMedia({ cache, kind: 'image', sha256: null, remaining: 1024 })).toBeNull();
    expect(
      await cachedCompanionMedia({ cache, kind: 'image', sha256: 'not-a-digest', remaining: 1024 }),
    ).toBeNull();
  });

  test('a vendor url is never handed out as a fetchable one', async () => {
    const cache = cacheFor();
    cache.putBytes({ sha256: SHA, bytes: BYTES, mime: 'image/jpeg', source: 'in' });
    cache.rememberUrl({
      url: 'https://mmg.whatsapp.net/v/t62/abc.enc',
      sha256: SHA,
      role: 'vendor',
      kind: 'image',
    });

    const plan = await cachedCompanionMedia({ cache, kind: 'image', sha256: SHA, remaining: 1024 });

    // Falls back to inline bytes: an encrypted url would be useless to the cloud.
    expect(plan?.block?.bytes).toEqual(BYTES);
    expect(plan?.block?.url).toBeUndefined();
  });

  test('accepts the digest in any spelling the wire uses', async () => {
    const cache = cacheFor();
    cache.putBytes({ sha256: SHA, bytes: BYTES, mime: 'image/jpeg', source: 'in' });
    const padded = Buffer.from(normalizeSha256(SHA)!, 'base64url').toString('base64');

    const plan = await cachedCompanionMedia({ cache, kind: 'image', sha256: padded, remaining: 1024 });
    expect(plan?.block?.sha256).toBe(SHA);
  });
});

/** An encoded `imageMessage` proto carrying the digest, as Baileys would cache it. */
function encodedImageProto(sha256: string): Uint8Array {
  return proto.Message.encode(
    proto.Message.fromObject({
      imageMessage: {
        url: 'https://mmg.whatsapp.net/v/t62/abc.enc',
        mimetype: 'image/jpeg',
        fileLength: BYTES.byteLength,
        fileSha256: Buffer.from(sha256, 'base64url'),
      },
    }),
  ).finish();
}
