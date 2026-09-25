/**
 * @fileoverview POST /api/v1/im/test.json: inject one cloud frame and collect
 * the frames that come back, without a real socket.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { createApp } from '../src/app';
import type { CloudLinkHooks } from '../src/cloud/link';
import { parseFrame } from '../src/cloud/protocol';
import { ConnectionManager } from '../src/manager';
import { ConnectionStore } from '../src/store';
import { HttpError } from '../src/types';
import { fakeFactory, type FakeSession } from './fake-whatsapp';

const dirs: string[] = [];
const managers: ConnectionManager[] = [];
const TOKEN = 'test-token';

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'companion-test-exchange-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (managers.length > 0) {
    const manager = managers.pop();
    if (manager == null) continue;
    try {
      await manager.disable('wa-test');
    } catch {
      /* no row */
    }
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir != null) rmSync(dir, { recursive: true, force: true });
  }
});

class FakeSocket {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly handlers = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  send(raw: string): void {
    this.sent.push(raw);
  }

  close(): void {
    this.readyState = 3;
  }

  emit(type: string, event: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  hello(): void {
    this.emit('message', { data: JSON.stringify({ v: 1, type: 'hello', data: { ok: true } }) });
  }

  frame(body: Record<string, unknown>): void {
    this.emit('message', { data: JSON.stringify({ v: 1, ...body }) });
  }
}

function captureSockets(): {
  last: () => FakeSocket | null;
  factory: CloudLinkHooks['socketFactory'];
} {
  const created: FakeSocket[] = [];
  return {
    last: () => created.at(-1) ?? null,
    factory: () => {
      const socket = new FakeSocket();
      created.push(socket);
      return socket as unknown as ReturnType<NonNullable<CloudLinkHooks['socketFactory']>>;
    },
  };
}

const payload = {
  v: 1,
  type: 'event',
  name: 'messages.upsert',
  userId: '85265862165',
  connectionId: 'captured-elsewhere',
  data: { messages: [], type: 'notify' },
};

async function openWhatsapp(): Promise<{
  manager: ConnectionManager;
  app: ReturnType<typeof createApp>;
  socket: FakeSocket;
  session: FakeSession;
}> {
  const sessions = new Map<string, FakeSession>();
  const sockets = captureSockets();
  const manager = new ConnectionManager(
    new ConnectionStore(tempDir()),
    fakeFactory(sessions),
    fetch,
    undefined,
    undefined,
    null,
    sockets.factory,
  );
  managers.push(manager);
  manager.store.add('wa-test', null, 'Test', 'whatsapp');
  await manager.enable('wa-test');
  await manager.setCloud('wa-test', 'wss://cloud.example/v1/companion', 'tok');
  const socket = sockets.last();
  if (socket == null) throw new Error('cloud socket was not dialed');
  socket.open();
  socket.hello();
  const session = sessions.get('wa-test');
  if (session == null) throw new Error('session was not started');
  return { manager, app: createApp({ manager, token: TOKEN, port: 38000 }), socket, session };
}

function authHeaders(): HeadersInit {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
}

describe('POST /api/v1/im/test.json', () => {
  test('returns downlink invokes once maxResponse is reached', async () => {
    const { app, socket } = await openWhatsapp();
    const started = Date.now();
    const pending = app.request('/api/v1/im/test.json', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ channel: 'whatsapp', payload, maxResponse: 2, maxWait: 30 }),
    });
    await Bun.sleep(20);
    socket.frame({ type: 'ping' });
    socket.frame({ type: 'invoke', id: 'a', name: 'readMessages', data: { args: [] } });
    socket.frame({ type: 'hello', data: { ok: true } });
    socket.frame({ type: 'invoke', id: 'b', name: 'sendPresenceUpdate', data: { args: ['composing', 'jid'] } });
    const res = await pending;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ type: string; name?: string }>;
    expect(body.map((frame) => frame.name)).toEqual(['readMessages', 'sendPresenceUpdate']);
    const sent = socket.sent.map((raw) => parseFrame(raw)).filter((frame) => frame?.type === 'result');
    expect(sent).toHaveLength(2);
    expect(sent[0]?.data).toEqual({ skipped: true });
  });

  test('skipReply does not run the invoke on the session', async () => {
    const { app, socket, session } = await openWhatsapp();
    let calls = 0;
    session.invoke = async () => {
      calls += 1;
      return { ran: true };
    };
    const pending = app.request('/api/v1/im/test.json', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ channel: 'whatsapp', payload, maxResponse: 1, maxWait: 5 }),
    });
    await Bun.sleep(20);
    socket.frame({ type: 'invoke', id: 's', name: 'sendMessage', data: { args: ['jid', { text: 'hi' }] } });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(calls).toBe(0);
    const listed = await app.request('/api/v1/im/connection/wa-test/messages.json?direction=out', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const messages = (await listed.json()) as { messages: unknown[] };
    expect(messages.messages).toEqual([]);
  });

  test('skipReply false runs the session invoke and still acks', async () => {
    const { app, socket, session } = await openWhatsapp();
    let calls = 0;
    session.invoke = async (name, args) => {
      calls += 1;
      return { name, args };
    };
    const pending = app.request('/api/v1/im/test.json', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        channel: 'whatsapp',
        payload,
        maxResponse: 1,
        maxWait: 5,
        skipReply: false,
      }),
    });
    await Bun.sleep(20);
    socket.frame({ type: 'invoke', id: 'r', name: 'readMessages', data: { args: [[{ id: 'm1' }]] } });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
    const sent = socket.sent.map((raw) => parseFrame(raw)).filter((frame) => frame?.type === 'result');
    expect(sent.at(-1)?.data).toEqual({ name: 'readMessages', args: [[{ id: 'm1' }]] });
  });

  test('a second call fails immediately', async () => {
    const { app, socket } = await openWhatsapp();
    const first = app.request('/api/v1/im/test.json', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ channel: 'whatsapp', payload, maxResponse: 1, maxWait: 5 }),
    });
    await Bun.sleep(20);
    const second = await app.request('/api/v1/im/test.json', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ channel: 'whatsapp', payload, maxResponse: 1, maxWait: 5 }),
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: 'TEST_IN_PROGRESS' });
    socket.frame({ type: 'invoke', id: 'a', name: 'readMessages', data: { args: [] } });
    expect((await first).status).toBe(200);
  });

  test('no open link is NOT_CONNECTED', async () => {
    const sessions = new Map<string, FakeSession>();
    const manager = new ConnectionManager(new ConnectionStore(tempDir()), fakeFactory(sessions));
    managers.push(manager);
    const app = createApp({ manager, token: TOKEN, port: 38000 });
    const res = await app.request('/api/v1/im/test.json', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ channel: 'whatsapp', payload, maxResponse: 1, maxWait: 1 }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'NOT_CONNECTED' });
  });

  test('each call sends a new message id', async () => {
    const { app, socket } = await openWhatsapp();
    const keyed = {
      ...payload,
      data: {
        type: 'notify',
        messages: [{ key: { remoteJid: '85265862165@s.whatsapp.net', fromMe: false, id: 'SAME' }, message: { conversation: 'hi' } }],
      },
    };
    const body = JSON.stringify({ channel: 'whatsapp', payload: keyed, maxResponse: 1, maxWait: 5 });
    const first = app.request('/api/v1/im/test.json', { method: 'POST', headers: authHeaders(), body });
    await Bun.sleep(20);
    socket.frame({ type: 'invoke', id: 'a', name: 'readMessages', data: { args: [] } });
    expect((await first).status).toBe(200);
    const second = app.request('/api/v1/im/test.json', { method: 'POST', headers: authHeaders(), body });
    await Bun.sleep(20);
    socket.frame({ type: 'invoke', id: 'b', name: 'readMessages', data: { args: [] } });
    expect((await second).status).toBe(200);
    const ids = socket.sent
      .map((raw) => parseFrame(raw))
      .filter((frame) => frame?.type === 'event')
      .map((frame) => {
        const messages = (frame?.data as { messages?: Array<{ key?: { id?: string } }> } | undefined)?.messages;
        return messages?.[0]?.key?.id;
      });
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
  });

  test('an empty wait is 408', async () => {
    const { app } = await openWhatsapp();
    const res = await app.request('/api/v1/im/test.json', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ channel: 'whatsapp', payload, maxResponse: 1, maxWait: 0.05 }),
    });
    expect(res.status).toBe(408);
    expect(await res.json()).toMatchObject({ error: 'TIMEOUT' });
  });

  test('port 38000 accepts test.json without a bearer', async () => {
    const sessions = new Map<string, FakeSession>();
    const manager = new ConnectionManager(new ConnectionStore(tempDir()), fakeFactory(sessions));
    managers.push(manager);
    const dev = createApp({ manager, token: TOKEN, port: 38000 });
    const open = await dev.request('/api/v1/im/test.json', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'whatsapp', payload, maxResponse: 1, maxWait: 1 }),
    });
    expect(open.status).toBe(409);
    const packaged = createApp({ manager, token: TOKEN, port: 38888 });
    const locked = await packaged.request('/api/v1/im/test.json', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'whatsapp', payload, maxResponse: 1, maxWait: 1 }),
    });
    expect(locked.status).toBe(401);
  });

  test('traceId is stamped on the frame sent up', async () => {
    const { app, socket } = await openWhatsapp();
    const pending = app.request('/api/v1/im/test.json', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        channel: 'whatsapp',
        payload,
        maxResponse: 1,
        maxWait: 5,
        traceId: '2026-09-26_00-18-00',
      }),
    });
    await Bun.sleep(20);
    const sent = socket.sent.map((raw) => parseFrame(raw)).find((frame) => frame?.type === 'event');
    expect(sent?.traceId).toBe('2026-09-26_00-18-00');
    expect(sent?.connectionId).toBe('wa-test');
    expect(sent?.channel).toBe('whatsapp');
    socket.frame({ type: 'invoke', id: 'a', name: 'readMessages', data: { args: [] } });
    expect((await pending).status).toBe(200);
  });

  test('manager rejects a second exchange before the first finishes', async () => {
    const { manager, socket } = await openWhatsapp();
    const first = manager.testExchange({
      channel: 'whatsapp',
      payload,
      maxResponse: 1,
      maxWaitMs: 5_000,
      skipReply: true,
    });
    await Bun.sleep(20);
    await expect(
      manager.testExchange({
        channel: 'whatsapp',
        payload,
        maxResponse: 1,
        maxWaitMs: 5_000,
        skipReply: true,
      }),
    ).rejects.toBeInstanceOf(HttpError);
    socket.frame({ type: 'invoke', id: 'a', name: 'readMessages', data: { args: [] } });
    await first;
  });
});
