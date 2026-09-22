/**
 * @fileoverview Durable two-way message queue. Covers the delivery rules in one
 * place: serial ordering, retry-only-on-transport, real-error and expiry caps,
 * and the frame each transport puts on the wire.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { CloudLink } from '../src/cloud/link';
import {
  classifyVendorError,
  CloudEventTransport,
  DeviceSendTransport,
  eventFor,
  MessageQueue,
  providerIdOf,
  type QueueSendResult,
  type QueueTransport,
} from '../src/cloud/queue';
import { MessageStore, reviveStoredBinary, type QueuedMessage } from '../src/messages';
import { ConnectionManager } from '../src/manager';
import { ConnectionStore } from '../src/store';
import { QUEUE_MAX_AGE_MS } from '../src/types';
import { fakeLineFactory } from './fake-line';
import { fakeFactory, FakeSession } from './fake-whatsapp';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'companion-queue-'));
  dirs.push(dir);
  return dir;
}

function tempStore(): MessageStore {
  return new MessageStore(join(tempDir(), 'messages.sqlite'));
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir != null) rmSync(dir, { recursive: true, force: true });
  }
});

/** Bun isolates request-scoped timers, but a queue drain resolves in microtasks. */
const settle = (): Promise<void> => Bun.sleep(5);

async function until(condition: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(20);
  }
  throw new Error('condition not met before timeout');
}

function insertInbound(
  store: MessageStore,
  overrides: Partial<Parameters<MessageStore['insert']>[0]> = {},
  now?: number,
): number {
  return store.insert(
    {
      connectionId: 'wa-1',
      channel: 'whatsapp',
      direction: 'in',
      messageId: 'wamid.1',
      providerId: 'wamid.1',
      type: 'text',
      fromId: '6591111111',
      toId: '6592222222',
      summary: 'hi',
      timestamp: 1_700_000_000_000,
      status: 'pending',
      rawIn: { key: { id: 'wamid.1' }, message: { conversation: 'hi' } },
      ...overrides,
    },
    now,
  );
}

/** Transport with full control over health and outcome. */
class StubTransport implements QueueTransport {
  readyFlag = true;
  rejectedFlag = false;
  result: QueueSendResult = { ok: true };
  throwOnSend = false;
  readonly sent: QueuedMessage[] = [];
  private readonly handlers: Array<() => void> = [];

  ready(): boolean {
    return this.readyFlag;
  }

  rejected(): boolean {
    return this.rejectedFlag;
  }

  onReady(handler: () => void): void {
    this.handlers.push(handler);
  }

  notify(): void {
    for (const handler of [...this.handlers]) handler();
  }

  send(row: QueuedMessage): QueueSendResult {
    this.sent.push(row);
    if (this.throwOnSend) throw new Error('socket exploded');
    return this.result;
  }
}

function queueFor(store: MessageStore, transport: QueueTransport, direction: 'in' | 'out' = 'in'): MessageQueue {
  return new MessageQueue({ connectionId: 'wa-1', direction, messages: store, transport });
}

describe('MessageQueue delivery rules', () => {
  test('sends serially, oldest first, and marks each one sent', async () => {
    const store = tempStore();
    for (let i = 0; i < 3; i += 1) {
      insertInbound(store, { messageId: `wamid.${i}`, providerId: `wamid.${i}`, summary: `msg ${i}` });
    }
    const transport = new StubTransport();
    queueFor(store, transport).kick();
    await settle();

    expect(transport.sent.map((row) => row.messageId)).toEqual(['wamid.0', 'wamid.1', 'wamid.2']);
    expect(store.nextPending('wa-1', 'in')).toBeUndefined();
    const list = store.list('wa-1', { direction: 'in' }, 1, 10);
    expect(list.messages.map((row) => row.status)).toEqual(['sent', 'sent', 'sent']);
    expect(list.messages[0]?.errorCount).toBe(0);
  });

  test('an offline destination waits without counting an attempt', async () => {
    const store = tempStore();
    insertInbound(store);
    const transport = new StubTransport();
    transport.readyFlag = false;
    const queue = queueFor(store, transport);
    queue.kick();
    await settle();

    expect(transport.sent).toHaveLength(0);
    const waiting = store.nextPending('wa-1', 'in');
    expect(waiting?.status).toBe('pending');
    expect(waiting?.errorCount).toBe(0);

    // Becoming ready wakes the queue without another explicit kick.
    transport.readyFlag = true;
    transport.notify();
    await settle();
    expect(transport.sent).toHaveLength(1);
    expect(store.nextPending('wa-1', 'in')).toBeUndefined();
  });

  test('a transport failure retries and fails after three attempts', async () => {
    const store = tempStore();
    insertInbound(store);
    const transport = new StubTransport();
    transport.result = { ok: false, real: false, error: 'write failed' };
    const queue = queueFor(store, transport);

    queue.kick();
    await settle();
    expect(store.nextPending('wa-1', 'in')?.errorCount).toBe(1);

    queue.kick();
    await settle();
    expect(store.nextPending('wa-1', 'in')?.errorCount).toBe(2);

    queue.kick();
    await settle();
    const row = store.get('wa-1', 1);
    expect(row?.status).toBe('failed');
    expect(row?.errorCount).toBe(3);
    expect(row?.lastError).toBe('write failed');
    // The cap stops it: a fourth kick sends nothing.
    const before = transport.sent.length;
    queue.kick();
    await settle();
    expect(transport.sent).toHaveLength(before);
  });

  test('one transport failure stops the pass instead of burning the next attempt', async () => {
    const store = tempStore();
    insertInbound(store, { messageId: 'wamid.0', providerId: 'wamid.0' });
    insertInbound(store, { messageId: 'wamid.1', providerId: 'wamid.1' });
    const transport = new StubTransport();
    transport.result = { ok: false, real: false, error: 'write failed' };
    queueFor(store, transport).kick();
    await settle();

    expect(transport.sent).toHaveLength(1);
    expect(store.get('wa-1', 1)?.errorCount).toBe(1);
    // The second row was never touched, so it still has a full budget.
    expect(store.get('wa-1', 2)?.errorCount).toBe(0);
  });

  test('a receiver error fails the message immediately', async () => {
    const store = tempStore();
    insertInbound(store);
    const transport = new StubTransport();
    transport.result = { ok: false, real: true, error: 'bad number' };
    queueFor(store, transport).kick();
    await settle();

    const row = store.get('wa-1', 1);
    expect(row?.status).toBe('failed');
    expect(row?.errorCount).toBe(0);
    expect(row?.lastError).toBe('bad number');
  });

  test('a throwing transport is retried, not treated as a verdict', async () => {
    const store = tempStore();
    insertInbound(store);
    const transport = new StubTransport();
    transport.throwOnSend = true;
    queueFor(store, transport).kick();
    await settle();

    const row = store.get('wa-1', 1);
    expect(row?.status).toBe('pending');
    expect(row?.errorCount).toBe(1);
    expect(row?.lastError).toBe('socket exploded');
  });

  test('a permanently rejected destination fails everything queued', async () => {
    const store = tempStore();
    insertInbound(store, { messageId: 'wamid.0', providerId: 'wamid.0' });
    insertInbound(store, { messageId: 'wamid.1', providerId: 'wamid.1' });
    const transport = new StubTransport();
    transport.rejectedFlag = true;
    queueFor(store, transport).kick();
    await settle();

    expect(transport.sent).toHaveLength(0);
    expect(store.list('wa-1', { direction: 'in' }, 1, 10).messages.map((row) => row.status)).toEqual(['failed', 'failed']);
    expect(store.get('wa-1', 1)?.lastError).toBe('link rejected');
  });

  test('a message older than an hour expires instead of sending', async () => {
    const store = tempStore();
    insertInbound(store, {}, Date.now() - QUEUE_MAX_AGE_MS - 1_000);
    const transport = new StubTransport();
    queueFor(store, transport).kick();
    await settle();

    expect(transport.sent).toHaveLength(0);
    const row = store.get('wa-1', 1);
    expect(row?.status).toBe('failed');
    expect(row?.lastError).toBe('expired');
  });

  test('a failed outbound drain does not block the inbound queue', async () => {
    const store = tempStore();
    insertInbound(store);
    store.insert({
      connectionId: 'wa-1',
      channel: 'whatsapp',
      direction: 'out',
      messageId: 'out-1',
      type: 'text',
      fromId: '6591111111',
      toId: '6592222222',
      summary: 'reply',
      timestamp: Date.now(),
      status: 'pending',
      rawOut: { kind: 'sendText', to: '6592222222', text: 'reply' },
    });

    const outboundTransport = new StubTransport();
    outboundTransport.result = { ok: false, real: false, error: 'phone offline' };
    const inboundTransport = new StubTransport();

    queueFor(store, outboundTransport, 'out').kick();
    queueFor(store, inboundTransport, 'in').kick();
    await settle();

    expect(outboundTransport.sent).toHaveLength(1);
    expect(inboundTransport.sent).toHaveLength(1);
  });
});

describe('CloudEventTransport', () => {
  function fakeLink(options: { open?: boolean; state?: string; writeOk?: boolean } = {}): {
    link: CloudLink;
    events: Array<{ name: string; data: unknown; userId?: string }>;
  } {
    const events: Array<{ name: string; data: unknown; userId?: string }> = [];
    const link = {
      isOpen: () => options.open !== false,
      state: () => options.state ?? 'connected',
      sendEvent: (name: string, data: unknown, userId?: string) => {
        events.push({ name, data, userId });
        return options.writeOk !== false;
      },
    };
    return { link: link as unknown as CloudLink, events };
  }

  test('rebuilds a whatsapp notify upsert with the sender as userId', async () => {
    const store = tempStore();
    insertInbound(store);
    const { link, events } = fakeLink();
    const transport = new CloudEventTransport('whatsapp', () => link);
    const queue = new MessageQueue({ connectionId: 'wa-1', direction: 'in', messages: store, transport });

    transport.notifyReady();
    await settle();

    expect(events).toHaveLength(1);
    const frame = events[0]!;
    expect(frame.name).toBe('messages.upsert');
    expect(frame.userId).toBe('6591111111');
    expect(frame.data).toEqual({
      messages: [{ key: { id: 'wamid.1' }, message: { conversation: 'hi' } }],
      type: 'notify',
    });
    void queue;
  });

  test('rebuilds a line message event with the raw payload', async () => {
    const store = tempStore();
    store.insert({
      connectionId: 'line-1',
      channel: 'line',
      direction: 'in',
      messageId: 'line.1',
      providerId: 'line.1',
      type: 'text',
      fromId: 'u111',
      toId: 'u222',
      summary: 'hi',
      timestamp: Date.now(),
      status: 'pending',
      rawIn: { raw: { id: 'line.1', contentType: 'NONE' }, text: 'hi', from: { id: 'u111' } },
    });
    const { link, events } = fakeLink();
    const transport = new CloudEventTransport('line', () => link);
    new MessageQueue({ connectionId: 'line-1', direction: 'in', messages: store, transport });
    transport.notifyReady();
    await settle();

    expect(events[0]?.name).toBe('message');
    expect(events[0]?.data).toEqual({
      raw: { id: 'line.1', contentType: 'NONE' },
      text: 'hi',
      from: { id: 'u111' },
    });
  });

  test('a rejected link fails the queue rather than sending into it', async () => {
    const store = tempStore();
    insertInbound(store);
    const { link, events } = fakeLink({ state: 'rejected' });
    const transport = new CloudEventTransport('whatsapp', () => link);
    new MessageQueue({ connectionId: 'wa-1', direction: 'in', messages: store, transport });
    transport.notifyReady();
    await settle();

    expect(events).toHaveLength(0);
    expect(store.get('wa-1', 1)?.status).toBe('failed');
  });

  test('a closed socket is a transport failure, so the row is retried', async () => {
    const store = tempStore();
    insertInbound(store);
    const { link } = fakeLink({ writeOk: false });
    const transport = new CloudEventTransport('whatsapp', () => link);
    const queue = new MessageQueue({ connectionId: 'wa-1', direction: 'in', messages: store, transport });
    queue.kick();
    await settle();

    const row = store.get('wa-1', 1);
    expect(row?.status).toBe('pending');
    expect(row?.errorCount).toBe(1);
    expect(row?.lastError).toBe('link write failed');
  });
});

describe('DeviceSendTransport', () => {
  function transportFor(session: FakeSession): DeviceSendTransport {
    return new DeviceSendTransport('whatsapp', () => session);
  }

  test('delivers a queued sendText and reports the vendor id', async () => {
    const store = tempStore();
    store.insert({
      connectionId: 'wa-1',
      channel: 'whatsapp',
      direction: 'out',
      messageId: 'out-1',
      type: 'text',
      fromId: '6591111111',
      toId: '6592222222',
      summary: 'reply',
      timestamp: Date.now(),
      status: 'pending',
      rawOut: { kind: 'sendText', to: '6592222222', text: 'reply' },
    });
    const session = new FakeSession('wa-1', {} as never);
    session.connectedFlag = true;
    const transport = transportFor(session);
    const queue = new MessageQueue({ connectionId: 'wa-1', direction: 'out', messages: store, transport });
    queue.kick();
    await settle();

    // FakeSession.sendText returns `wamid.fake`.
    expect(store.get('wa-1', 1)?.status).toBe('sent');
    expect(store.get('wa-1', 1)?.providerId).toBe('wamid.fake');
  });

  test('delivers a queued invoke through the session', async () => {
    const store = tempStore();
    store.insert({
      connectionId: 'wa-1',
      channel: 'whatsapp',
      direction: 'out',
      messageId: 'out-2',
      type: 'text',
      fromId: '6591111111',
      toId: '6592222222@ s.whatsapp.net'.replace(' ', ''),
      summary: 'reply',
      timestamp: Date.now(),
      status: 'pending',
      rawOut: { kind: 'invoke', name: 'sendMessage', args: ['6592222222@s.whatsapp.net', { text: 'reply' }] },
    });
    const session = new FakeSession('wa-1', {} as never);
    session.connectedFlag = true;
    const transport = transportFor(session);
    new MessageQueue({ connectionId: 'wa-1', direction: 'out', messages: store, transport }).kick();
    await settle();

    expect(store.get('wa-1', 1)?.status).toBe('sent');
  });

  test('a disconnected session is a transport failure', async () => {
    const store = tempStore();
    store.insert({
      connectionId: 'wa-1',
      channel: 'whatsapp',
      direction: 'out',
      messageId: 'out-3',
      type: 'text',
      fromId: 'a',
      toId: 'b',
      summary: 'reply',
      timestamp: Date.now(),
      status: 'pending',
      rawOut: { kind: 'sendText', to: 'b', text: 'reply' },
    });
    const session = new FakeSession('wa-1', {} as never);
    const transport = transportFor(session);
    const queue = new MessageQueue({ connectionId: 'wa-1', direction: 'out', messages: store, transport });
    // Ready is false, so the queue waits rather than counting an attempt.
    queue.kick();
    await settle();
    expect(store.get('wa-1', 1)?.errorCount).toBe(0);
    expect(store.get('wa-1', 1)?.status).toBe('pending');
  });

  test('an unreadable queued payload fails instead of retrying forever', async () => {
    const store = tempStore();
    store.insert({
      connectionId: 'wa-1',
      channel: 'whatsapp',
      direction: 'out',
      messageId: 'out-4',
      type: 'unknown',
      fromId: 'a',
      toId: 'b',
      summary: '[sendMessage]',
      timestamp: Date.now(),
      status: 'pending',
      rawOut: { kind: 'something-else' },
    });
    const session = new FakeSession('wa-1', {} as never);
    session.connectedFlag = true;
    new MessageQueue({
      connectionId: 'wa-1',
      direction: 'out',
      messages: store,
      transport: transportFor(session),
    }).kick();
    await settle();

    expect(store.get('wa-1', 1)?.status).toBe('failed');
    expect(store.get('wa-1', 1)?.lastError).toBe('invalid queued payload');
  });
});

describe('classifyVendorError', () => {
  test('a Boom-style status is a real receiver error', () => {
    expect(classifyVendorError({ output: { statusCode: 400 } })).toBe('real');
    expect(classifyVendorError({ output: { statusCode: 500 } })).toBe('real');
    expect(classifyVendorError({ statusCode: 404 })).toBe('real');
    expect(classifyVendorError({ status: 409 })).toBe('real');
  });

  test('a channel error code is a real receiver error', () => {
    expect(classifyVendorError({ data: { code: 'MESSAGE_NOT_FOUND' } })).toBe('real');
    expect(classifyVendorError({ code: 'INVALID_JID' })).toBe('real');
  });

  test('connection problems are transport errors', () => {
    expect(classifyVendorError(new Error('not connected'))).toBe('transport');
    expect(classifyVendorError({ code: 'ETIMEDOUT' })).toBe('transport');
    expect(classifyVendorError({ code: 'ECONNRESET' })).toBe('transport');
    expect(classifyVendorError(null)).toBe('transport');
    expect(classifyVendorError(undefined)).toBe('transport');
    // A non-HTTP numeric status is not a verdict.
    expect(classifyVendorError({ statusCode: 0 })).toBe('transport');
  });
});

describe('helpers', () => {
  test('providerIdOf reads the id each channel returns', () => {
    expect(providerIdOf({ key: { id: 'wamid.x' } })).toBe('wamid.x');
    expect(providerIdOf({ messageId: 'line.x' })).toBe('line.x');
    expect(providerIdOf({ id: 'plain' })).toBe('plain');
    expect(providerIdOf({})).toBeNull();
    expect(providerIdOf(null)).toBeNull();
  });

  test('eventFor wraps whatsapp in a notify upsert', () => {
    const row = {
      rawIn: { key: { id: 'wamid.1' } },
    } as unknown as QueuedMessage;
    expect(eventFor('whatsapp', row)).toEqual({
      name: 'messages.upsert',
      data: { messages: [{ key: { id: 'wamid.1' } }], type: 'notify' },
    });
    expect(eventFor('line', row)).toEqual({ name: 'message', data: { key: { id: 'wamid.1' } } });
  });

  test('binary survives the JSON round-trip so media still frames as $bin', () => {
    const store = tempStore();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    insertInbound(store, {
      rawIn: { key: { id: 'wamid.1' }, message: { imageMessage: { jpegThumbnail: bytes } } },
    });
    const row = store.nextPending('wa-1', 'in')!;
    const revived = (row.rawIn as { message: { imageMessage: { jpegThumbnail: unknown } } }).message
      .imageMessage.jpegThumbnail;
    expect(revived).toBeInstanceOf(Uint8Array);
    expect([...(revived as Uint8Array)]).toEqual([1, 2, 3, 4]);
    // The stored detail view keeps the plain JSON tags, so REST is unchanged.
    expect(store.get('wa-1', 1)?.rawIn).toEqual({
      key: { id: 'wamid.1' },
      message: { imageMessage: { jpegThumbnail: { type: 'Uint8Array', data: 'AQIDBA==' } } },
    });
  });

  test('reviveStoredBinary leaves ordinary values alone', () => {
    expect(reviveStoredBinary({ a: 1, b: 'x' })).toEqual({ a: 1, b: 'x' });
    expect(reviveStoredBinary({ type: 'not-binary', data: 'AQ==' })).toEqual({
      type: 'not-binary',
      data: 'AQ==',
    });
  });
});

describe('end to end through the manager', () => {
  test('an inbound message is queued, then forwarded once the link is up', async () => {
    const received: Array<{ type: string; name?: string; data?: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response('no', { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.send(JSON.stringify({ v: 1, type: 'hello', data: { ok: true } }));
        },
        message(_ws, raw) {
          received.push(JSON.parse(String(raw)) as { type: string; name?: string; data?: unknown });
        },
      },
    });

    try {
      const root = tempDir();
      const messages = new MessageStore(join(root, 'messages.sqlite'));
      const sessions = new Map<string, FakeSession>();
      const manager = new ConnectionManager(
        new ConnectionStore(root),
        fakeFactory(sessions),
        fetch,
        fakeLineFactory(new Map()),
        messages,
      );
      manager.store.add('wa-1', null, 'Home', 'whatsapp');
      await manager.enable('wa-1');
      await manager.setCloud('wa-1', `ws://127.0.0.1:${server.port}/`, 'tok');
      await until(() => manager.view('wa-1').cloudStatus === 'connected');

      sessions.get('wa-1')!.hooks.onInboundMessage?.({
        id: 'wamid.e2e',
        from: '6591111111',
        to: '6592222222',
        text: 'hello cloud',
        type: 'text',
        timestamp: Date.now(),
        raw: { key: { id: 'wamid.e2e' }, message: { conversation: 'hello cloud' } },
      });

      await until(() => messages.list('wa-1', { direction: 'in' }, 1, 10).messages[0]?.status === 'sent');
      const event = received.find((frame) => frame.type === 'event' && frame.name === 'messages.upsert');
      expect(event).toBeDefined();
      expect(event?.data).toEqual({
        messages: [{ key: { id: 'wamid.e2e' }, message: { conversation: 'hello cloud' } }],
        type: 'notify',
      });
    } finally {
      server.stop(true);
    }
  }, 20_000);

  test('a cloud reply is queued, delivered, and counted as sent', async () => {
    let socket: { send(data: string): void } | null = null;
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response('no', { status: 400 });
      },
      websocket: {
        open(ws) {
          socket = ws;
          ws.send(JSON.stringify({ v: 1, type: 'hello', data: { ok: true } }));
        },
        message() {},
      },
    });

    try {
      const root = tempDir();
      const messages = new MessageStore(join(root, 'messages.sqlite'));
      const sessions = new Map<string, FakeSession>();
      const manager = new ConnectionManager(
        new ConnectionStore(root),
        fakeFactory(sessions),
        fetch,
        fakeLineFactory(new Map()),
        messages,
      );
      manager.store.add('wa-1', null, 'Home', 'whatsapp');
      await manager.enable('wa-1');
      await manager.setCloud('wa-1', `ws://127.0.0.1:${server.port}/`, 'tok');
      await until(() => manager.view('wa-1').cloudStatus === 'connected');
      expect(manager.view('wa-1').outgoingCount).toBe(0);

      // The cloud replies the way SM3 does: an `invoke` frame on the link.
      socket!.send(
        JSON.stringify({
          v: 1,
          type: 'invoke',
          id: 'inv-1',
          name: 'sendMessage',
          data: ['6591111111@s.whatsapp.net', { text: 'reply' }],
          connectionId: 'wa-1',
          channel: 'whatsapp',
        }),
      );

      await until(
        () => messages.list('wa-1', { direction: 'out' }, 1, 10).messages[0]?.status === 'sent',
      );
      // The queued reply must move the Sent counter, not just the history row.
      expect(manager.view('wa-1').outgoingCount).toBe(1);

      // A local REST send counts too, and neither path double-counts.
      await manager.send('wa-1', '6592222222', 'local reply');
      expect(manager.view('wa-1').outgoingCount).toBe(2);
      expect(messages.list('wa-1', { direction: 'out' }, 1, 10).total).toBe(2);
    } finally {
      server.stop(true);
    }
  }, 20_000);
});
