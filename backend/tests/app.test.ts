import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { createApp } from '../src/app';
import { ConnectionManager } from '../src/manager';
import { ConnectionStore } from '../src/store';
import { loadOrCreateConfig } from '../src/token';
import { fakeFactory, type FakeSession } from './fake-whatsapp';
import { fakeLineFactory, type FakeLineSession } from './fake-line';
import type { FetchLike } from '../src/webhook';

const dirs: string[] = [];
const TOKEN = 'test-token';

/** A Companion-generated message id: uuid v7. */
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'companion-app-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir != null) rmSync(dir, { recursive: true, force: true });
  }
});

function appWith(sessions = new Map<string, FakeSession>(), fetchFn: FetchLike = fetch) {
  const root = tempDir();
  const manager = new ConnectionManager(new ConnectionStore(root), fakeFactory(sessions), fetchFn);
  const app = createApp({ manager, token: TOKEN, port: 38888 });
  return { app, manager, sessions };
}

function lineAppWith(sessions = new Map<string, FakeLineSession>(), fetchFn: FetchLike = fetch) {
  const root = tempDir();
  const manager = new ConnectionManager(
    new ConnectionStore(root),
    fakeFactory(new Map()),
    fetchFn,
    fakeLineFactory(sessions),
  );
  const app = createApp({ manager, token: TOKEN, port: 38888 });
  return { app, manager, sessions };
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
}

describe('token', () => {
  test('creates and reuses config token', () => {
    const root = tempDir();
    const first = loadOrCreateConfig(root, 38888);
    const second = loadOrCreateConfig(root, 38888);
    expect(first.token).toBe(second.token);
    expect(first.token.length).toBeGreaterThan(16);
  });
});

describe('REST /api/v1/im', () => {
  test('health is public', async () => {
    const { app } = appWith();
    const res = await app.request('/api/v1/im/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.port).toBe(38888);
    expect(body.token).toBe(TOKEN);
  });

  test('list without token is 401', async () => {
    const { app } = appWith();
    const res = await app.request('/api/v1/im/connection');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('UNAUTHORIZED');
  });

  test('list create get qr enable disable webhook send delete', async () => {
    const sessions = new Map<string, FakeSession>();
    const { app, sessions: live } = appWith(sessions);
    void live;

    const listed = await app.request('/api/v1/im/connection', { headers: authHeaders() });
    expect(listed.status).toBe(200);
    expect((await listed.json()).connections).toEqual([]);

    const created = await app.request('/api/v1/im/connection', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ id: 'home' }),
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(createdBody.connection.id).toBe('home');
    expect(createdBody.connection.name).toBe('home');
    expect(createdBody.connection.channel).toBe('whatsapp');
    expect(createdBody.connection.status).toBe('qr');
    expect(createdBody.connection.disconnectCount).toBe(0);

    const renamed = await app.request('/api/v1/im/connection/home', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'House' }),
    });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).connection.name).toBe('House');

    const qr = await app.request('/api/v1/im/connection/home/qr', { headers: authHeaders() });
    expect(await qr.json()).toEqual({ qr: '2@fake-qr', pin: null });

    const enabled = await app.request('/api/v1/im/connection/home/enable', {
      method: 'POST',
      headers: authHeaders(),
    });
    const enabledBody = await enabled.json();
    expect(enabledBody.connection.status).toBe('connected');
    expect(enabledBody.connection.phone).toBe('6591111111');
    expect(enabledBody.connection.user).toBe('Alice');

    const sent = await app.request('/api/v1/im/connection/home/message', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ to: '6591222222', text: 'hello' }),
    });
    expect(sent.status).toBe(200);
    // A send is queued and acked right away; the vendor id only arrives on delivery.
    const sentBody = await sent.json();
    expect(sentBody.to).toBe('6591222222');
    expect(sentBody.status).toBe('pending');
    expect(sentBody.id).toMatch(UUID7);

    const listedOut = await app.request('/api/v1/im/connection/home/messages?direction=out', {
      headers: authHeaders(),
    });
    expect(listedOut.status).toBe(200);
    const outBody = await listedOut.json();
    expect(outBody.total).toBe(1);
    expect(outBody.messages[0].summary).toBe('hello');
    expect(outBody.messages[0].to).toBe('6591222222');
    expect(outBody.messages[0].messageId).toBe(sentBody.id);
    const messageId = outBody.messages[0].id as number;
    const detail = await app.request(`/api/v1/im/connection/home/messages/${messageId}`, {
      headers: authHeaders(),
    });
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.message.rawIn).toEqual({ to: '6591222222', text: 'hello' });
    expect(detailBody.message.rawOut).toEqual({
      kind: 'sendText',
      to: '6591222222',
      text: 'hello',
    });

    const hooked = await app.request('/api/v1/im/connection/home/webhook', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ url: 'http://127.0.0.1:9999/hook', token: 'hook-secret' }),
    });
    const hookedBody = await hooked.json();
    expect(hookedBody.connection.webhookUrl).toBe('http://127.0.0.1:9999/hook');
    expect(hookedBody.connection.webhookToken).toBe('hook-secret');

    const rehooked = await app.request('/api/v1/im/connection/home/webhook', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ url: 'http://127.0.0.1:9999/hook' }),
    });
    // The token is not optional: a url without one is rejected.
    expect(rehooked.status).toBe(400);
    const missingTokenBody = await rehooked.json();
    expect(missingTokenBody.error).toBe('INVALID_PARAM');
    expect(missingTokenBody.message).toBe('token is required when url is set');

    const blankToken = await app.request('/api/v1/im/connection/home/webhook', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ url: 'http://127.0.0.1:9999/hook', token: '   ' }),
    });
    expect(blankToken.status).toBe(400);

    const badToken = await app.request('/api/v1/im/connection/home/webhook', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ url: 'http://127.0.0.1:9999/hook', token: 42 }),
    });
    expect(badToken.status).toBe(400);

    const unhooked = await app.request('/api/v1/im/connection/home/webhook', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ url: null }),
    });
    expect((await unhooked.json()).connection.webhookToken).toBeNull();

    const clouded = await app.request('/api/v1/im/connection/home/cloud', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ url: 'ws://127.0.0.1:1/v1/companion', token: 'link-token' }),
    });
    expect(clouded.status).toBe(200);
    const cloudBody = await clouded.json();
    expect(cloudBody.connection.cloudUrl).toBe('ws://127.0.0.1:1/v1/companion');
    expect(cloudBody.connection.cloudToken).toBe('link-token');

    const disabled = await app.request('/api/v1/im/connection/home/disable', {
      method: 'POST',
      headers: authHeaders(),
    });
    expect((await disabled.json()).connection.status).toBe('disabled');

    const gone = await app.request('/api/v1/im/connection/home', {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect((await gone.json()).ok).toBe(true);
  });

  test('unknown connection and validation', async () => {
    const { app } = appWith();
    const headers = authHeaders();
    expect((await app.request('/api/v1/im/connection/missing', { headers })).status).toBe(404);
    expect(
      (await app.request('/api/v1/im/connection/missing/message', {
        method: 'POST',
        headers,
        body: JSON.stringify({ to: '6591', text: 'x' }),
      })).status,
    ).toBe(404);
    expect(
      (await app.request('/api/v1/im/connection/missing/message', {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: 'x' }),
      })).status,
    ).toBe(400);
    expect(
      (await app.request('/api/v1/im/connection/missing/message', {
        method: 'POST',
        headers,
        body: JSON.stringify({ to: '6591' }),
      })).status,
    ).toBe(400);
    expect((await app.request('/api/v1/im/connection/missing/enable', { method: 'POST', headers })).status).toBe(404);
    expect((await app.request('/api/v1/im/connection/missing/disable', { method: 'POST', headers })).status).toBe(404);
    expect(
      (await app.request('/api/v1/im/connection/missing/webhook', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ url: 'http://127.0.0.1:9/h', token: 'hook-secret' }),
      })).status,
    ).toBe(404);
    expect(
      (await app.request('/api/v1/im/connection/missing/cloud', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ url: 'ws://127.0.0.1:9/c', token: 't' }),
      })).status,
    ).toBe(404);
    expect(
      (await app.request('/api/v1/im/connection/missing', {
        method: 'PUT',
        headers,
        body: JSON.stringify({}),
      })).status,
    ).toBe(400);
    expect((await app.request('/api/v1/im/connection/missing', { method: 'DELETE', headers })).status).toBe(404);
    expect((await app.request('/api/v1/im/connection/missing/messages?direction=in', { headers })).status).toBe(404);
    // `direction` is optional now, so an unknown connection is what fails.
    expect((await app.request('/api/v1/im/connection/missing/messages', { headers })).status).toBe(404);
    expect((await app.request('/api/v1/im/connection/missing/messages/1', { headers })).status).toBe(404);
  });

  test('a bad filter is rejected before the connection is looked up', async () => {
    const { app } = appWith(new Map());
    const headers = authHeaders();
    await app.request('/api/v1/im/connection', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'home' }),
    });
    expect((await app.request('/api/v1/im/connection/home/messages?direction=sideways', { headers })).status).toBe(400);
    expect((await app.request('/api/v1/im/connection/home/messages?status=bogus', { headers })).status).toBe(400);
    expect((await app.request('/api/v1/im/connection/home/messages?direction=all&status=failed&type=text', { headers })).status).toBe(200);
  });

  test('replay validates the body before it looks anything up', async () => {
    const { app } = appWith(new Map());
    const headers = authHeaders();
    await app.request('/api/v1/im/connection', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'home' }),
    });
    // Both ids travel in the body, so a missing one is a 400 rather than a 404.
    const replay = (body: unknown) =>
      app.request('/api/v1/im/replay', { method: 'POST', headers, body: JSON.stringify(body) });

    expect((await replay({ messageId: 1 })).status).toBe(400);
    expect((await replay({ connectionId: '   ', messageId: 1 })).status).toBe(400);
    expect((await replay({ connectionId: 5, messageId: 1 })).status).toBe(400);
    expect((await replay({ connectionId: 'home', messageId: 'abc' })).status).toBe(400);
    expect((await replay({ connectionId: 'home', messageId: 0 })).status).toBe(400);
    expect((await replay({ connectionId: 'home', messageId: 1.5 })).status).toBe(400);

    // Shape is fine, the connection is not.
    const missingConnection = await replay({ connectionId: 'missing', messageId: 1 });
    expect(missingConnection.status).toBe(404);
    expect((await missingConnection.json()).error).toBe('NOT_FOUND');

    // Connection is fine, the row is not.
    const missingMessage = await replay({ connectionId: 'home', messageId: 999 });
    expect(missingMessage.status).toBe(404);
    expect((await missingMessage.json()).error).toBe('NOT_FOUND');
  });

  test('replay refuses an outbound row and a connection without a cloud link', async () => {
    const { app, manager } = appWith(new Map());
    const headers = authHeaders();
    await app.request('/api/v1/im/connection', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'home' }),
    });
    const base = {
      connectionId: 'home',
      channel: 'whatsapp' as const,
      type: 'text',
      fromId: '6591111111',
      toId: '6592222222',
      summary: 'hello',
      timestamp: Date.now(),
      status: 'sent' as const,
      rawIn: { key: { id: 'wamid.1' }, message: { conversation: 'hello' } },
    };
    const inboundId = manager.messages.insert({
      ...base,
      direction: 'in',
      messageId: 'wamid.1',
      providerId: 'wamid.1',
    });
    const outboundId = manager.messages.insert({
      ...base,
      direction: 'out',
      messageId: 'wamid.2',
      providerId: 'wamid.2',
    });
    const replay = (messageId: number) =>
      app.request('/api/v1/im/replay', {
        method: 'POST',
        headers,
        body: JSON.stringify({ connectionId: 'home', messageId }),
      });

    // Received, but this connection has no open cloud link.
    const noLink = await replay(inboundId);
    expect(noLink.status).toBe(409);
    expect((await noLink.json()).error).toBe('NOT_CONNECTED');

    // Outbound rows go to the phone, never to the cloud.
    const wrongWay = await replay(outboundId);
    expect(wrongWay.status).toBe(409);
    expect((await wrongWay.json()).error).toBe('INVALID_STATE');
  });

  test('a send is queued while the phone is offline and delivers on connect', async () => {
    const sessions = new Map<string, FakeSession>();
    const { app, manager } = appWith(sessions);
    await app.request('/api/v1/im/connection', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ id: 'home' }),
      // Not enabled: the fake session stops at the QR step, so it is offline.
    });
    expect(manager.view('home').status).toBe('qr');

    const sent = await app.request('/api/v1/im/connection/home/message', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ to: '6591222222', text: 'queued hello' }),
    });
    // Queuing does not depend on the session being connected.
    expect(sent.status).toBe(200);
    const sentBody = await sent.json();
    expect(sentBody.status).toBe('pending');
    expect(sentBody.id).toMatch(UUID7);

    const queued = await app.request('/api/v1/im/connection/home/messages?direction=out', {
      headers: authHeaders(),
    });
    expect((await queued.json()).messages[0].status).toBe('pending');

    // The phone comes online; the worker drains what was waiting.
    await app.request('/api/v1/im/connection/home/enable', { method: 'POST', headers: authHeaders() });
    await Bun.sleep(20);
    const delivered = await app.request('/api/v1/im/connection/home/messages?direction=out', {
      headers: authHeaders(),
    });
    const deliveredBody = await delivered.json();
    expect(deliveredBody.messages[0].status).toBe('sent');
    expect(deliveredBody.messages[0].providerId).toBe('wamid.fake');
  });

  test('inbound webhook is posted', async () => {
    const posts: unknown[] = [];
    const fetchFn: FetchLike = async (_url, init) => {
      posts.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response('ok', { status: 200 });
    };
    const sessions = new Map<string, FakeSession>();
    const { app, manager } = appWith(sessions, fetchFn);
    await app.request('/api/v1/im/connection', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ id: 'home' }),
    });
    await app.request('/api/v1/im/connection/home/webhook', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ url: 'http://127.0.0.1:9999/hook', token: 'hook-secret' }),
    });
    const session = sessions.get('home');
    expect(session).toBeDefined();
    session!.hooks.onInboundText({
      id: 'wamid.1',
      from: '6591222222',
      to: '6591111111',
      text: 'hi',
      timestamp: 1,
    });
    await Bun.sleep(20);
    expect(posts).toEqual([
      {
        connectionId: 'home',
        channel: 'whatsapp',
        id: 'wamid.1',
        from: '6591222222',
        to: '6591111111',
        text: 'hi',
        timestamp: 1,
        type: 'text',
      },
    ]);
    expect(manager.view('home').incomingCount).toBe(1);

    const listedIn = await app.request('/api/v1/im/connection/home/messages?direction=in', {
      headers: authHeaders(),
    });
    expect(listedIn.status).toBe(200);
    const inBody = await listedIn.json();
    expect(inBody.total).toBe(1);
    expect(inBody.messages[0].summary).toBe('hi');
    const inboundDetail = await app.request(`/api/v1/im/connection/home/messages/${inBody.messages[0].id}`, {
      headers: authHeaders(),
    });
    expect((await inboundDetail.json()).message.rawOut).toEqual(posts[0]);
  });

  test('disconnectCount is unexpected drops in 24 hours', async () => {
    const sessions = new Map<string, FakeSession>();
    const { app, manager } = appWith(sessions);
    await app.request('/api/v1/im/connection', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ id: 'home' }),
    });
    expect(manager.view('home').disconnectCount).toBe(0);

    sessions.get('home')!.hooks.onDisconnected('transient');
    await Bun.sleep(20);
    expect(manager.view('home').disconnectCount).toBe(1);

    const meta = manager.store.meta('home');
    manager.store.saveMeta('home', {
      ...meta,
      disconnectAt: [Date.now() - 25 * 60 * 60 * 1000, ...(meta.disconnectAt ?? [])],
    });
    expect(manager.view('home').disconnectCount).toBe(1);
  });

  test('create line connection, qr pin, send mid unchanged', async () => {
    const sessions = new Map<string, FakeLineSession>();
    const { app, sessions: live } = lineAppWith(sessions);
    void live;

    const created = await app.request('/api/v1/im/connection', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ id: 'desk', channel: 'line' }),
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(createdBody.connection.channel).toBe('line');
    expect(createdBody.connection.status).toBe('qr');
    expect(createdBody.connection.pin).toBe('123456');

    const qr = await app.request('/api/v1/im/connection/desk/qr', { headers: authHeaders() });
    expect(await qr.json()).toEqual({
      qr: 'https://line.me/R/nv/QRCodeAuth/fake',
      pin: '123456',
    });

    const enabled = await app.request('/api/v1/im/connection/desk/enable', {
      method: 'POST',
      headers: authHeaders(),
    });
    const enabledBody = await enabled.json();
    expect(enabledBody.connection.status).toBe('connected');
    expect(enabledBody.connection.phone).toBe('u-fake-mid');
    expect(enabledBody.connection.user).toBe('Display Name');

    const sent = await app.request('/api/v1/im/connection/desk/message', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ to: 'u1234567890abcdef', text: 'hello' }),
    });
    expect(sent.status).toBe(200);
    const sentBody = await sent.json();
    // Queued first, delivered after the ack; a LINE mid is never rewritten.
    expect(sentBody.status).toBe('pending');
    expect(sentBody.id).toMatch(UUID7);
    expect(sentBody.to).toBe('u1234567890abcdef');

    await Bun.sleep(20);
    expect(sessions.get('desk')?.lastTo).toBe('u1234567890abcdef');
  });

  test('rejects unknown channel', async () => {
    const { app } = appWith();
    const res = await app.request('/api/v1/im/connection', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ channel: 'telegram' }),
    });
    expect(res.status).toBe(400);
  });

  test('line inbound webhook includes channel', async () => {
    const posts: unknown[] = [];
    const fetchFn: FetchLike = async (_url, init) => {
      posts.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response('ok', { status: 200 });
    };
    const sessions = new Map<string, FakeLineSession>();
    const { app } = lineAppWith(sessions, fetchFn);
    await app.request('/api/v1/im/connection', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ id: 'desk', channel: 'line' }),
    });
    await app.request('/api/v1/im/connection/desk/webhook', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ url: 'http://127.0.0.1:9999/hook', token: 'hook-secret' }),
    });
    sessions.get('desk')!.hooks.onInboundText({
      id: 'line.1',
      from: 'u111',
      to: 'u222',
      text: 'hi',
      timestamp: 1,
    });
    await Bun.sleep(20);
    expect(posts).toEqual([
      {
        connectionId: 'desk',
        channel: 'line',
        id: 'line.1',
        from: 'u111',
        to: 'u222',
        text: 'hi',
        timestamp: 1,
        type: 'text',
      },
    ]);
  });
});
