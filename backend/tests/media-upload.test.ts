import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createMediaUploader } from '../src/mediaUpload';
import { uploadEndpointFrom } from '../src/cloud/link';

const BYTES = new Uint8Array([1, 2, 3, 4]);

/** A fetch double that records each call and answers from a script. */
function fakeFetch(handlers: Array<(url: string, init?: RequestInit) => Response>): {
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    fetchFn: async (input, init) => {
      calls.push({ url: input, init });
      const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)];
      return handler!(input, init);
    },
  };
}

function presignOk(uploadUrl = 'https://r2.example.com/put?sig=1', downloadUrl = 'https://store.test/temp/a.jpeg') {
  return () => Response.json({ data: { uploadUrl, downloadUrl } });
}

describe('createMediaUploader', () => {
  test('presigns with the bearer and the plaintext digest, then PUTs the bytes', async () => {
    const { fetchFn, calls } = fakeFetch([presignOk(), () => new Response(null, { status: 200 })]);
    const upload = createMediaUploader({ endpoint: () => 'https://api.test/upload.json', token: () => 'tok', fetchFn });

    const result = await upload(BYTES, 'image/jpeg');

    expect(result).toEqual({ url: 'https://store.test/temp/a.jpeg' });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://api.test/upload.json');
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      mimetype: 'image/jpeg',
      length: 4,
      // base64url without padding, the dialect the cloud stores under.
      sha256: createHash('sha256').update(BYTES).digest('base64url'),
    });
    // The content type is part of the signature, so it must match the presign.
    expect(calls[1]?.url).toBe('https://r2.example.com/put?sig=1');
    expect((calls[1]?.init?.headers as Record<string, string>)['content-type']).toBe('image/jpeg');
  });

  test('no endpoint or no token means no upload, without calling anything', async () => {
    const { fetchFn, calls } = fakeFetch([presignOk()]);
    expect(await createMediaUploader({ endpoint: () => '', token: () => 'tok', fetchFn })(BYTES, 'image/jpeg')).toBeNull();
    expect(await createMediaUploader({ endpoint: () => 'https://api.test/u', token: () => '', fetchFn })(BYTES, 'image/jpeg')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test('a rejected presign, a malformed one, and a failed PUT all return null', async () => {
    const rejected = fakeFetch([() => new Response('nope', { status: 401 })]);
    expect(
      await createMediaUploader({ endpoint: () => 'https://api.test/u', token: () => 't', fetchFn: rejected.fetchFn })(
        BYTES,
        'image/jpeg',
      ),
    ).toBeNull();

    // A 200 with no usable urls is still a failure: the caller must fall back.
    const empty = fakeFetch([() => Response.json({ data: {} })]);
    expect(
      await createMediaUploader({ endpoint: () => 'https://api.test/u', token: () => 't', fetchFn: empty.fetchFn })(
        BYTES,
        'image/jpeg',
      ),
    ).toBeNull();

    const putFails = fakeFetch([presignOk(), () => new Response(null, { status: 403 })]);
    expect(
      await createMediaUploader({ endpoint: () => 'https://api.test/u', token: () => 't', fetchFn: putFails.fetchFn })(
        BYTES,
        'image/jpeg',
      ),
    ).toBeNull();
  });

  test('a transport error never throws, so the message still ships inline', async () => {
    const upload = createMediaUploader({
      endpoint: () => 'https://api.test/u',
      token: () => 't',
      fetchFn: async () => {
        throw new Error('network down');
      },
    });
    expect(await upload(BYTES, 'image/jpeg')).toBeNull();
  });
});

describe('uploadEndpointFrom', () => {
  test('reads data.upload.url and treats anything else as absent', () => {
    expect(uploadEndpointFrom({ ok: true, upload: { url: 'https://api.test/upload.json' } })).toBe(
      'https://api.test/upload.json',
    );
    // Older or other servers simply advertise nothing.
    expect(uploadEndpointFrom({ ok: true })).toBe('');
    expect(uploadEndpointFrom({ upload: {} })).toBe('');
    expect(uploadEndpointFrom({ upload: { url: 42 } })).toBe('');
    expect(uploadEndpointFrom(null)).toBe('');
  });
});
