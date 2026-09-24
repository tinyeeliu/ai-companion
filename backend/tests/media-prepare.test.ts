import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { proto } from '@whiskeysockets/baileys';
import { sha256Base64Url } from '../src/media/sha';
import { ConnectionMediaCache } from '../src/media/cache';
import { MediaCacheStore, mediaDir, mediaPath } from '../src/media/store';
import { prepareMediaContent } from '../src/whatsapp';
import { allowedInvoke, CHANNEL_INVOKE } from '../src/cloud/protocol';

/** A tiny PNG, enough for Baileys to hash, thumbnail and "upload". */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0000003010100' +
    '18dd8db00000000049454e44ae426082',
  'hex',
);

/** The digest of a header image the cache is primed with. */
const DIGEST = sha256Base64Url(new Uint8Array([7, 7, 7]));

/** A proto as WhatsApp would have returned it for an accepted upload. */
function acceptedProto(): Uint8Array {
  return proto.Message.encode(
    proto.Message.fromObject({
      imageMessage: {
        url: 'https://mmg.whatsapp.net/accepted.enc',
        directPath: '/v/accepted',
        mimetype: 'image/png',
        fileLength: PNG.byteLength,
        fileSha256: Buffer.from(DIGEST, 'base64url'),
      },
    }),
  ).finish();
}

/** A proto as it arrives on an inbound message, carrying the locator and key. */
function inboundProto(sha256: string): Uint8Array {
  return proto.Message.encode(
    proto.Message.fromObject({
      imageMessage: {
        url: 'https://mmg.whatsapp.net/inbound.enc?oe=6ADCAB3C',
        directPath: '/v/inbound.enc?oe=6ADCAB3C',
        mediaKey: Buffer.alloc(32, 1),
        fileEncSha256: Buffer.alloc(32, 2),
        fileLength: PNG.byteLength,
        mediaKeyTimestamp: 1_790_248_346,
        mimetype: 'image/jpeg',
        fileSha256: Buffer.from(sha256, 'base64url'),
      },
    }),
  ).finish();
}

/**
 * `prepareWAMessageMedia` downloads the url itself before it can hash and upload
 * the bytes, so the fixture has to be reachable. A local server keeps the test
 * offline while still exercising the real fetch path.
 */
let server: ReturnType<typeof Bun.serve>;
let base = '';
/** How many times the fixture server was actually asked for its bytes. */
let served = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: () => {
      served += 1;
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

/** A socket double: prepareMediaContent only reads `waUploadToServer`. */
function fakeSock(): never {
  return { waUploadToServer: async () => ({ url: 'https://mmg.whatsapp.net/uploaded.enc', directPath: '/v/x' }) } as never;
}

/** The upload itself is stubbed, so nothing leaves the machine. */
const stubUpload = (async () =>
  ({ url: 'https://mmg.whatsapp.net/uploaded.enc', directPath: '/v/x' })) as never;

describe('prepareMediaContent', () => {
  test('returns an image proto and carries the caller mimetype', async () => {
    const proto = (await prepareMediaContent(
      fakeSock(),
      ['image', `${base}/a.png`, 'image/png'],
      stubUpload,
    )) as { imageMessage?: { mimetype?: string } };
    // Without the explicit mimetype Baileys would declare image/jpeg for a PNG.
    expect(proto.imageMessage?.mimetype).toBe('image/png');
  });

  test('defaults the mimetype when the caller omits it', async () => {
    const proto = (await prepareMediaContent(fakeSock(), ['image', `${base}/a.jpg`], stubUpload)) as {
      imageMessage?: { mimetype?: string };
    };
    expect(proto.imageMessage?.mimetype).toBe('image/jpeg');
  });

  test('a document keeps its file name and falls back to octet-stream', async () => {
    const proto = (await prepareMediaContent(
      fakeSock(),
      ['document', `${base}/a.pdf`, undefined, 'homework.pdf'],
      stubUpload,
    )) as { documentMessage?: { fileName?: string; mimetype?: string } };
    expect(proto.documentMessage).toMatchObject({ fileName: 'homework.pdf', mimetype: 'application/octet-stream' });
  });

  test('video is prepared as a video message', async () => {
    const proto = (await prepareMediaContent(fakeSock(), ['video', `${base}/a.mp4`], stubUpload)) as {
      videoMessage?: unknown;
    };
    expect(proto.videoMessage).toBeTruthy();
  });

  test('a missing url and an unknown kind are rejected before any upload', async () => {
    await expect(prepareMediaContent(fakeSock(), ['image', ''], stubUpload)).rejects.toThrow('requires a url');
    await expect(prepareMediaContent(fakeSock(), ['sticker', `${base}/s.webp`], stubUpload)).rejects.toThrow(
      'unsupported media kind sticker',
    );
  });

  test('reuses a stored proto instead of fetching and uploading again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'companion-prepare-'));
    const store = new MediaCacheStore(mediaPath(root), mediaDir(root));
    const cache = new ConnectionMediaCache(store, 'wa-1');
    // Deliberately unreachable: a cache hit must not touch the network at all.
    const url = 'http://127.0.0.1:1/never-served.png';
    cache.rememberUrl({ url, sha256: DIGEST, role: 'stored', kind: 'image' });
    cache.rememberProto(`image:${url}`, acceptedProto());

    let uploaded = 0;
    const proto = (await prepareMediaContent(
      fakeSock(),
      ['image', url, 'image/png'],
      (async () => {
        uploaded += 1;
        return { url: 'https://mmg.whatsapp.net/uploaded.enc', directPath: '/v/x' };
      }) as never,
      cache.baileys,
    )) as { imageMessage?: { url?: string } };

    expect(uploaded).toBe(0);
    expect(proto.imageMessage?.url).toBe('https://mmg.whatsapp.net/accepted.enc');
    rmSync(root, { recursive: true, force: true });
  });

  test('an inbound proto makes the header a pure cache hit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'companion-prepare-in-'));
    const store = new MediaCacheStore(mediaPath(root), mediaDir(root));
    const cache = new ConnectionMediaCache(store, 'wa-1');
    const bytes = new Uint8Array([5, 5, 5]);
    const digest = sha256Base64Url(bytes);
    // What the cloud names in the header invoke: its own stored url for the media
    // the user just sent, which is what `rememberInboundMedia` recorded.
    const url = 'https://workspace.example.com/temp/from-inbound.jpeg';
    cache.putBytes({ sha256: digest, bytes, mime: 'image/jpeg', source: 'in' });
    cache.rememberUrl({ url, sha256: digest, role: 'stored', kind: 'image' });
    cache.putProto(digest, inboundProto(digest), { waExpiresAt: Date.now() + 86_400_000 });

    served = 0;
    let uploaded = 0;
    const result = (await prepareMediaContent(
      fakeSock(),
      ['image', url, 'image/jpeg', null, digest],
      (async () => {
        uploaded += 1;
        return { url: 'https://mmg.whatsapp.net/uploaded.enc', directPath: '/v/x' };
      }) as never,
      cache.baileys,
    )) as { imageMessage?: { url?: string } };

    // Neither half of the round trip happened: WhatsApp's own blob is referenced.
    expect(served).toBe(0);
    expect(uploaded).toBe(0);
    expect(result.imageMessage?.url).toBe('https://mmg.whatsapp.net/inbound.enc?oe=6ADCAB3C');
    rmSync(root, { recursive: true, force: true });
  });

  test('an expired proto is not reused, so the header is uploaded again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'companion-prepare-exp-'));
    const store = new MediaCacheStore(mediaPath(root), mediaDir(root));
    const cache = new ConnectionMediaCache(store, 'wa-1');
    const bytes = new Uint8Array([5, 5, 5]);
    const digest = sha256Base64Url(bytes);
    // Reachable, because an expired proto means the download really does happen.
    const url = `${base}/expired.png`;
    cache.putBytes({ sha256: digest, bytes, mime: 'image/png', source: 'in' });
    cache.rememberUrl({ url, sha256: digest, role: 'stored', kind: 'image' });
    cache.putProto(digest, inboundProto(digest), { waExpiresAt: Date.now() - 1 });

    served = 0;
    let uploaded = 0;
    await prepareMediaContent(
      fakeSock(),
      ['image', url, 'image/png', null, digest],
      (async () => {
        uploaded += 1;
        return { url: 'https://mmg.whatsapp.net/uploaded.enc', directPath: '/v/x' };
      }) as never,
      cache.baileys,
    );

    // A dead blob must cost a fresh upload rather than producing a dead message.
    expect(served).toBe(1);
    expect(uploaded).toBeGreaterThan(0);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('whatsapp invoke allowlist', () => {
  test('prepareMedia is allowed and unknown names stay rejected', () => {
    expect(CHANNEL_INVOKE.whatsapp).toContain('prepareMedia');
    expect(allowedInvoke('whatsapp', 'prepareMedia')).toBe(true);
    expect(allowedInvoke('whatsapp', 'sendMessage')).toBe(true);
    expect(allowedInvoke('whatsapp', 'notAMethod')).toBe(false);
    // LINE has its own catalog and must not inherit the WhatsApp names.
    expect(allowedInvoke('line', 'prepareMedia')).toBe(false);
  });
});

describe('PNG fixture', () => {
  test('is a valid png header so the media pipeline can parse it', () => {
    expect(PNG.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });
});
