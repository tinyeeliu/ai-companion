import { describe, expect, test } from 'bun:test';
import { postWebhook, isHttpUrl, isWsUrl, type FetchLike } from '../src/webhook';

describe('webhook', () => {
  test('accepts http(s) urls', () => {
    expect(isHttpUrl('http://127.0.0.1:9/h')).toBe(true);
    expect(isHttpUrl('https://example.com/h')).toBe(true);
    expect(isHttpUrl('ftp://x')).toBe(false);
    expect(isHttpUrl('not-a-url')).toBe(false);
  });

  test('accepts ws(s) urls', () => {
    expect(isWsUrl('ws://127.0.0.1:9/c')).toBe(true);
    expect(isWsUrl('wss://example.com/v1/companion')).toBe(true);
    expect(isWsUrl('https://example.com/c')).toBe(false);
  });

  test('retries then succeeds', async () => {
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      calls += 1;
      if (calls < 3) throw new Error('down');
      return new Response('ok', { status: 200 });
    };
    await expect(postWebhook('http://127.0.0.1:9/h', { a: 1 }, fetchFn)).resolves.toBe(true);
    expect(calls).toBe(3);
  });

  test('returns false after exhausting retries', async () => {
    const fetchFn: FetchLike = async () => {
      throw new Error('down');
    };
    await expect(postWebhook('http://127.0.0.1:9/h', {}, fetchFn)).resolves.toBe(false);
  });

  test('treats non-ok as retryable', async () => {
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      calls += 1;
      return new Response('no', { status: 500 });
    };
    await expect(postWebhook('http://127.0.0.1:9/h', {}, fetchFn)).resolves.toBe(false);
    expect(calls).toBe(3);
  });

  test('sends no Authorization header without a token', async () => {
    const seen: RequestInit[] = [];
    const fetchFn: FetchLike = async (_url, init) => {
      seen.push(init ?? {});
      return new Response('ok', { status: 200 });
    };
    await expect(postWebhook('http://127.0.0.1:9/h', { a: 1 }, fetchFn)).resolves.toBe(true);
    const headers = seen[0]?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['content-type']).toBe('application/json');
  });

  test('sends the token as a Bearer header', async () => {
    const seen: RequestInit[] = [];
    const fetchFn: FetchLike = async (_url, init) => {
      seen.push(init ?? {});
      return new Response('ok', { status: 200 });
    };
    await expect(
      postWebhook('http://127.0.0.1:9/h', { a: 1 }, fetchFn, 'hook-secret'),
    ).resolves.toBe(true);
    expect((seen[0]?.headers as Record<string, string>).Authorization).toBe('Bearer hook-secret');
  });

  test('treats an empty token as absent', async () => {
    const seen: RequestInit[] = [];
    const fetchFn: FetchLike = async (_url, init) => {
      seen.push(init ?? {});
      return new Response('ok', { status: 200 });
    };
    await expect(postWebhook('http://127.0.0.1:9/h', {}, fetchFn, '')).resolves.toBe(true);
    expect((seen[0]?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  test('keeps the Authorization header across retries', async () => {
    const tokens: unknown[] = [];
    const fetchFn: FetchLike = async (_url, init) => {
      tokens.push((init?.headers as Record<string, string>).Authorization);
      throw new Error('down');
    };
    await expect(postWebhook('http://127.0.0.1:9/h', {}, fetchFn, 'hook-secret')).resolves.toBe(false);
    expect(tokens).toEqual(['Bearer hook-secret', 'Bearer hook-secret', 'Bearer hook-secret']);
  });
});
