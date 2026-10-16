/**
 * LLM Gateway setup gates and the chat and responses routers. The Codex binary
 * is not downloaded and no live Codex call is made.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { createApp } from '../src/app';
import { binaryPath } from '../src/llm/layout';
import type { SpawnFn } from '../src/llm/process';
import { LlmSetup } from '../src/llm/setup';
import { ConnectionManager } from '../src/manager';
import { ConnectionStore } from '../src/store';
import { setConfigProxyUrl, setConfigToken } from '../src/token';
import { fakeFactory } from './fake-whatsapp';

const dirs: string[] = [];
const servers: { stop: (close?: boolean) => void }[] = [];
const TOKEN = 'test-token';

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'companion-llm-'));
  dirs.push(root);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ token: TOKEN, port: 38888 }));
  return root;
}

function plantBinary(root: string): void {
  const path = binaryPath(root, 'darwin');
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '');
}

function plantAuth(root: string): string {
  const path = join(root, 'auth.json');
  writeFileSync(path, '{"tokens":{}}\n');
  return path;
}

function appWith(root: string, setup: LlmSetup) {
  const manager = new ConnectionManager(new ConnectionStore(root), fakeFactory(new Map()), fetch);
  return createApp({
    manager,
    token: TOKEN,
    port: 38888,
    configRoot: root,
    llm: { setup },
  });
}

function listeningSpawn(port: number, seen: { body: unknown; path: string; env: NodeJS.ProcessEnv | null }): SpawnFn {
  return (_bin, _args, env) => {
    seen.env = env;
    const server = Bun.serve({
      port,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/healthz') return Response.json({ status: 'ok' });
        const responses = url.pathname === '/v1/responses' || url.pathname.startsWith('/v1/responses/');
        if (url.pathname === '/v1/chat/completions' || responses) {
          seen.path = url.pathname + url.search;
          seen.body = req.method === 'GET' || req.method === 'DELETE' ? null : await req.json().catch(() => null);
          if (responses) return Response.json({ id: 'resp_1', output_text: 'Hello' });
          return Response.json({ choices: [{ message: { content: 'Hello' } }] });
        }
        return new Response('no', { status: 404 });
      },
    });
    servers.push(server);
    return { kill() { server.stop(true); }, onExit() { /* stays up until kill */ } };
  };
}

describe('llm gateway', () => {
  test('defaults off and asks for a download', async () => {
    const root = tempRoot();
    const setup = new LlmSetup({
      root,
      publicPort: 38888,
      authPath: join(root, 'missing-auth.json'),
      platform: 'darwin',
      arch: 'arm64',
    });
    const app = appWith(root, setup);
    const view = await (await app.request('/api/v1/setup.json')).json() as {
      features: { id: string; enabled: boolean; useProxy: boolean; steps: string[] }[];
    };
    expect(view.features[0]).toMatchObject({
      id: 'llm',
      enabled: false,
      useProxy: false,
      steps: ['download'],
    });
    const off = await app.request('/codex/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-luna', input: 'hi' }),
    });
    expect(off.status).toBe(503);
  });

  test('a machine without a build refuses download', async () => {
    const root = tempRoot();
    const setup = new LlmSetup({
      root,
      publicPort: 38888,
      platform: 'linux',
      arch: 'arm64',
    });
    const app = appWith(root, setup);
    const view = await (await app.request('/api/v1/setup.json')).json() as {
      features: { steps: string[] }[];
    };
    expect(view.features[0].steps).toEqual(['unsupported']);
    const res = await app.request('/api/v1/setup/llm/download.json', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  test('enable is refused without a Codex login or a proxy URL', async () => {
    const root = tempRoot();
    plantBinary(root);
    const setup = new LlmSetup({
      root,
      publicPort: 38888,
      authPath: join(root, 'missing-auth.json'),
      platform: 'darwin',
      arch: 'arm64',
      gatewayPort: 28771,
    });
    const app = appWith(root, setup);
    const missing = await app.request('/api/v1/setup/llm.json', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(missing.status).toBe(400);

    const proxy = await app.request('/api/v1/setup/llm.json', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ useProxy: true }),
    });
    expect(proxy.status).toBe(200);
    const view = await proxy.json() as { steps: string[]; useProxy: boolean };
    expect(view.useProxy).toBe(true);
    expect(view.steps).toContain('proxy');
    expect(view.steps).toContain('login');
  });

  test('saving a proxy keeps the token', async () => {
    const root = tempRoot();
    const setup = new LlmSetup({ root, publicPort: 38888, platform: 'darwin', arch: 'arm64' });
    const app = appWith(root, setup);
    const saved = await app.request('/api/v1/settings/proxy.json', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proxyUrl: 'http://10.0.0.1:41074' }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ proxyUrl: 'http://10.0.0.1:41074' });
    const settings = await (await app.request('/api/v1/settings.json')).json() as { token: string; proxyUrl: string };
    expect(settings.token).toBe(TOKEN);
    expect(settings.proxyUrl).toBe('http://10.0.0.1:41074');
    const after = setConfigToken(root, 'rotated');
    expect(after.token).toBe('rotated');
    expect(after.proxyUrl).toBe('http://10.0.0.1:41074');
    expect(setConfigProxyUrl(root, '').proxyUrl).toBe('');
    expect(setConfigToken(root, TOKEN).token).toBe(TOKEN);
  });

  test('both completion paths reach the gateway with the prefix removed', async () => {
    const root = tempRoot();
    plantBinary(root);
    const auth = plantAuth(root);
    const port = 28772;
    const seen: { body: unknown; path: string; env: NodeJS.ProcessEnv | null } = { body: null, path: '', env: null };
    const previous = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://should-not-leak:9';
    const setup = new LlmSetup({
      root,
      publicPort: 38000,
      gatewayPort: port,
      authPath: auth,
      platform: 'darwin',
      arch: 'arm64',
      spawnImpl: listeningSpawn(port, seen),
    });
    const app = appWith(root, setup);
    try {
      const enabled = await app.request('/api/v1/setup/llm.json', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      expect(enabled.status).toBe(200);
      const view = await enabled.json() as { enabled: boolean; baseUrl: string; steps: string[] };
      expect(view.enabled).toBe(true);
      expect(view.baseUrl).toBe('http://127.0.0.1:38000/codex/v1');
      expect(view.steps).toEqual([]);
      expect(seen.env?.HTTPS_PROXY).toBeUndefined();
      expect(seen.env?.NO_PROXY).toBeUndefined();

      const direct = await app.request('/codex/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(direct.status).toBe(200);
      expect(seen.body).toMatchObject({ model: 'gpt-5.6-luna' });

      const routed = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'codex/gpt-5.6-luna', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(routed.status).toBe(200);
      expect(seen.body).toMatchObject({ model: 'gpt-5.6-luna' });

      const unknown = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.6-luna', messages: [] }),
      });
      expect(unknown.status).toBe(404);

      const directResponses = await app.request('/codex/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.6-luna', input: 'hi' }),
      });
      expect(directResponses.status).toBe(200);
      expect(seen.path).toBe('/v1/responses');
      expect(seen.body).toMatchObject({ model: 'gpt-5.6-luna', input: 'hi' });

      const routedResponses = await app.request('/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'codex/gpt-5.6-luna', input: 'hi' }),
      });
      expect(routedResponses.status).toBe(200);
      expect(seen.body).toMatchObject({ model: 'gpt-5.6-luna' });

      const bareResponses = await app.request('/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.6-luna', input: 'hi' }),
      });
      expect(bareResponses.status).toBe(404);

      const tokens = await app.request('/v1/responses/input_tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'codex/gpt-5.6-luna', input: 'hi' }),
      });
      expect(tokens.status).toBe(200);
      expect(seen.path).toBe('/v1/responses/input_tokens');
      expect(seen.body).toMatchObject({ model: 'gpt-5.6-luna' });

      const loaded = await app.request('/v1/responses/resp_1?stream=true');
      expect(loaded.status).toBe(200);
      expect(seen.path).toBe('/v1/responses/resp_1?stream=true');
      expect(seen.body).toBeNull();

      const cancelled = await app.request('/codex/v1/responses/resp_1/cancel', { method: 'POST' });
      expect(cancelled.status).toBe(200);
      expect(seen.path).toBe('/v1/responses/resp_1/cancel');

      const removed = await app.request('/codex/v1/responses/resp_1', { method: 'DELETE' });
      expect(removed.status).toBe(200);
      expect(seen.path).toBe('/v1/responses/resp_1');

      const tested = await app.request('/api/v1/setup/llm/test.json', { method: 'POST' });
      expect(tested.status).toBe(200);
      expect(await tested.json()).toMatchObject({ text: 'Hello' });
    } finally {
      if (previous == null) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previous;
      await app.request('/api/v1/setup/llm.json', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
    }
  });

  test('use proxy puts only the settings URL on the child', async () => {
    const root = tempRoot();
    plantBinary(root);
    const auth = plantAuth(root);
    setConfigProxyUrl(root, 'http://10.1.1.1:41074');
    const port = 28773;
    const seen: { body: unknown; path: string; env: NodeJS.ProcessEnv | null } = { body: null, path: '', env: null };
    const setup = new LlmSetup({
      root,
      publicPort: 38888,
      gatewayPort: port,
      authPath: auth,
      platform: 'darwin',
      arch: 'arm64',
      spawnImpl: listeningSpawn(port, seen),
    });
    const app = appWith(root, setup);
    const enabled = await app.request('/api/v1/setup/llm.json', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ useProxy: true, enabled: true }),
    });
    expect(enabled.status).toBe(200);
    expect(seen.env?.HTTPS_PROXY).toBe('http://10.1.1.1:41074');
    expect(seen.env?.NO_PROXY).toBe('localhost,127.0.0.1,::1');
    await app.request('/api/v1/setup/llm.json', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
  });
});
