/**
 * Route-level tests for the OpenAI-shaped image endpoint. The CLI adapter is
 * faked, so these exercise validation, the envelope, and `response_format`
 * disposition without a multi-gigabyte model.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { createApp } from '../src/app';
import { ConnectionManager } from '../src/manager';
import { ConnectionStore } from '../src/store';
import { GenQueue, type GenJob, type GenResult, type GenRunner } from '../src/gen/queue';
import { GenFailedError, type DrawThings } from '../src/gen/drawthings';
import { genStore } from '../src/gen/store';
import { fakeFactory } from './fake-whatsapp';

const dirs: string[] = [];
const TOKEN = 'test-token';

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir != null) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'companion-gen-routes-'));
  dirs.push(dir);
  return dir;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

/** Records what the queue was asked for, so tests can assert the mapping. */
function appWith(runner: GenRunner, ready = true, local = true) {
  const root = tempDir();
  const manager = new ConnectionManager(new ConnectionStore(root), fakeFactory(new Map()), fetch);
  const queue = new GenQueue(runner);
  const drawThings = { available: async () => ready } as unknown as DrawThings;
  const app = createApp({
    manager,
    token: TOKEN,
    port: 38888,
    ...(local ? {} : { isLocalRequest: () => false }),
    gen: { queue, drawThings, store: genStore(join(root, 'gen')), ready },
  });
  return { app, queue };
}

function okRunner(jobs: GenJob[] = []) {
  return {
    async run(job: GenJob): Promise<GenResult> {
      jobs.push(job);
      return { png: PNG, durationMs: 12 };
    },
  };
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
}

describe('POST /api/v1/image/generations.json', () => {
  test('returns the OpenAI envelope, defaulting to url disposition', async () => {
    const { app } = appWith(okRunner());
    const res = await app.request('/api/v1/image/generations.json', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'flux_2_klein_4b_q6p.ckpt', prompt: 'a red cube' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: number; data: Array<{ b64_json: string; url: null }> };
    expect(typeof body.created).toBe('number');
    expect(body.data).toHaveLength(1);
    // OpenAI's own default for `response_format` is `url`.
    expect(body.data[0]?.url).not.toBeNull();
    expect(body.data[0]?.b64_json).toBeNull();
  });

  test('b64_json returns inline base64 and url serves the bytes', async () => {
    const { app } = appWith(okRunner());
    const res = await app.request('/api/v1/image/generations.json', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        model: 'flux_2_klein_4b_q6p.ckpt',
        prompt: 'a red cube',
        response_format: 'b64_json',
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ b64_json: string }> };
    expect(body.data[0]?.b64_json).toBe(Buffer.from(PNG).toString('base64'));
  });

  test('url response is fetchable and returns image/png', async () => {
    const { app } = appWith(okRunner());
    const created = await app.request('/api/v1/image/generations.json', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'm.ckpt', prompt: 'x', response_format: 'url' }),
    });
    const body = (await created.json()) as { data: Array<{ url: string }> };
    const url = body.data[0]?.url;
    expect(url).toMatch(/^\/api\/v1\/image\/generations\/[0-9a-f-]+\.png$/);

    const fetched = await app.request(url as string);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(PNG);
  });

  test('maps size to width/height and n to sequential runs', async () => {
    const jobs: GenJob[] = [];
    const { app } = appWith(okRunner(jobs));
    const res = await app.request('/api/v1/image/generations.json', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'm.ckpt', prompt: 'x', size: '1024x1792', n: 3 }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(3);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({ width: 1024, height: 1792 });
  });

  test('low quality reduces steps, high leaves them to the model', async () => {
    const low: GenJob[] = [];
    await appWith(okRunner(low)).app.request('/api/v1/image/generations.json', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'm.ckpt', prompt: 'x', quality: 'low' }),
    });
    expect(low[0]?.steps).toBe(4);

    const high: GenJob[] = [];
    await appWith(okRunner(high)).app.request('/api/v1/image/generations.json', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'm.ckpt', prompt: 'x', quality: 'high' }),
    });
    expect(high[0]?.steps).toBeUndefined();
  });

  test('rejects unknown fields instead of ignoring them', async () => {
    const { app } = appWith(okRunner());
    const res = await app.request('/api/v1/image/generations.json', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'm.ckpt', prompt: 'x', negative_prompt: 'blurry' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('INVALID_PARAM');
    expect(body.message).toContain('negative_prompt');
  });

  test('needs no bearer token on loopback', async () => {
    const { app } = appWith(okRunner());
    const res = await app.request('/api/v1/image/generations.json', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm.ckpt', prompt: 'x' }),
    });
    expect(res.status).toBe(200);
  });

  test('requires the bearer token for an external caller', async () => {
    const { app } = appWith(okRunner(), true, false);
    const open = await app.request('/api/v1/image/generations.json', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm.ckpt', prompt: 'x' }),
    });
    expect(open.status).toBe(401);
    const authed = await app.request('/api/v1/image/generations.json', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'm.ckpt', prompt: 'x' }),
    });
    expect(authed.status).toBe(200);
  });

  test('the generated image is readable without a token', async () => {
    const { app } = appWith(okRunner());
    const created = await app.request('/api/v1/image/generations.json', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm.ckpt', prompt: 'x', response_format: 'url' }),
    });
    const body = (await created.json()) as { data: Array<{ url: string }> };

    const fetched = await app.request(body.data[0]?.url as string);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toBe('image/png');
  });

  test('requires prompt and model', async () => {
    const { app } = appWith(okRunner());
    for (const body of [{ model: 'm.ckpt' }, { prompt: 'x' }]) {
      const res = await app.request('/api/v1/image/generations.json', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  test('rejects an out-of-range n', async () => {
    const { app } = appWith(okRunner());
    const res = await app.request('/api/v1/image/generations.json', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'm.ckpt', prompt: 'x', n: 99 }),
    });
    expect(res.status).toBe(400);
  });

  test('answers 503 when the CLI is unavailable', async () => {
    const { app } = appWith(okRunner(), false);
    const res = await app.request('/api/v1/image/generations.json', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'm.ckpt', prompt: 'x' }),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('CLI_UNAVAILABLE');
  });

  test('surfaces a generation failure as 500', async () => {
    const { app } = appWith({
      async run(): Promise<GenResult> {
        throw new GenFailedError('no such model', 1);
      },
    });
    const res = await app.request('/api/v1/image/generations.json', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'm.ckpt', prompt: 'x' }),
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('GENERATION_FAILED');
  });

  test('unknown image id is 404', async () => {
    const { app } = appWith(okRunner());
    const res = await app.request('/api/v1/image/generations/00000000-0000-0000-0000-000000000000.png');
    expect(res.status).toBe(404);
  });

  test('the IM routes still reject an unauthenticated external caller', async () => {
    // The boundary that matters: the image routes are open only on loopback, and
    // the channel routes must reject an unauthenticated caller from outside.
    const { app } = appWith(okRunner(), true, false);
    expect((await app.request('/api/v1/im/connection.json')).status).toBe(401);
    expect(
      (await app.request('/api/v1/im/connection.json', { headers: authHeaders() })).status,
    ).toBe(200);
  });
});