import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { prepareMediaContent } from '../src/whatsapp';
import { allowedInvoke, CHANNEL_INVOKE } from '../src/cloud/protocol';

/** A tiny PNG, enough for Baileys to hash, thumbnail and "upload". */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0000003010100' +
    '18dd8db00000000049454e44ae426082',
  'hex',
);

/**
 * `prepareWAMessageMedia` downloads the url itself before it can hash and upload
 * the bytes, so the fixture has to be reachable. A local server keeps the test
 * offline while still exercising the real fetch path.
 */
let server: ReturnType<typeof Bun.serve>;
let base = '';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
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
