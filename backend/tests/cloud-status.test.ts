/**
 * @fileoverview Cloud link state surfaced on the connection view. The dashboard
 * has to answer "is the WebSocket up?" without guessing from `cloudUrl`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { CloudFrame } from '../src/cloud/protocol';
import { CloudLink, type CloudLinkHooks } from '../src/cloud/link';
import { ConnectionManager } from '../src/manager';
import { ConnectionStore } from '../src/store';
import { fakeFactory } from './fake-whatsapp';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'companion-cloud-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir != null) rmSync(dir, { recursive: true, force: true });
  }
});

/** Drives the CloudLink without a real socket, so `state()` is testable. */
function linkWith(hooks: Partial<CloudLinkHooks> = {}): CloudLink {
  return new CloudLink({
    connectionId: 'wa-1',
    channel: 'whatsapp',
    url: 'wss://cloud.example/v1/companion',
    token: 'tok',
    account: () => '15551367394',
    session: () => undefined,
    ...hooks,
  });
}

/**
 * Installs a fake dialler through the documented `socketFactory` seam so a test
 * can drive `open` / `message` / `close` without reaching the network.
 */
function captureSockets(): {
  last: () => FakeSocket | null;
  count: () => number;
  factory: CloudLinkHooks['socketFactory'];
} {
  const created: FakeSocket[] = [];
  return {
    last: () => created.at(-1) ?? null,
    count: () => created.length,
    factory: (url) => {
      const socket = new FakeSocket(url);
      created.push(socket);
      return socket as unknown as ReturnType<NonNullable<CloudLinkHooks['socketFactory']>>;
    },
  };
}

class FakeSocket {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly handlers = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly url: string) {}

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
    this.emit('close', { code: 1000, reason: '' });
  }

  emit(type: string, event: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  /** Server greeting, which is what promotes the link to `connected`. */
  hello(): void {
    this.emit('message', { data: JSON.stringify({ v: 1, type: 'hello', data: { ok: true } }) });
  }

  serverClose(code: number): void {
    this.readyState = 3;
    this.emit('close', { code, reason: '' });
  }

  /** A refused upgrade (HTTP 401): Bun fires `error` and never `close`. */
  refuseUpgrade(): void {
    this.readyState = 3;
    this.emit('error', {});
  }
}

/** Dials a fake socket; call `captureSockets()` first to get the factory. */
function dialing(hooks: Partial<CloudLinkHooks>, factory: CloudLinkHooks['socketFactory']): CloudLink {
  return linkWith({ ...hooks, socketFactory: factory });
}

describe('CloudLink state', () => {
  test('a link that has not dialled yet is connecting', () => {
    const link = linkWith();
    expect(link.state()).toBe('connecting');
    link.stop();
  });

  test('a dial in flight is connecting, and only a server hello promotes it', () => {
    const sockets = captureSockets();
    const link = dialing({}, sockets.factory);
    link.start();
    const socket = sockets.last()!;
    expect(link.state()).toBe('connecting');
    socket.open();
    expect(link.state()).not.toBe('connected');
    socket.hello();
    expect(link.state()).toBe('connected');
    link.stop();
  });

  test('a terminal close is rejected and never becomes retrying', () => {
    const sockets = captureSockets();
    const closes: number[] = [];
    const link = dialing({ onTerminalClose: (code) => closes.push(code) }, sockets.factory);
    link.start();
    const socket = sockets.last()!;
    socket.open();
    socket.hello();
    socket.serverClose(4401);
    expect(closes).toEqual([4401]);
    expect(link.state()).toBe('rejected');
    // A rejected link must not have a retry timer armed.
    expect((link as unknown as { retryTimer: unknown }).retryTimer).toBeNull();
    link.stop();
  });

  test('a transport drop goes to retrying, not rejected', () => {
    const sockets = captureSockets();
    const link = dialing({}, sockets.factory);
    link.start();
    const socket = sockets.last()!;
    socket.open();
    socket.hello();
    socket.serverClose(1006);
    expect(link.state()).toBe('retrying');
    link.stop();
  });

  test('a single refused upgrade retries instead of latching', async () => {
    const sockets = captureSockets();
    const closes: number[] = [];
    const link = dialing({ onTerminalClose: (code) => closes.push(code) }, sockets.factory);
    link.start();
    // SM3 answers an unknown/rotated token with HTTP 401 before the upgrade — but
    // it answers the same way while it is still booting, so one refusal is not a
    // verdict. It must retry rather than park the link.
    sockets.last()!.refuseUpgrade();
    expect(closes).toEqual([]);
    expect(link.state()).toBe('retrying');
    expect((link as unknown as { retryTimer: unknown }).retryTimer).not.toBeNull();
    link.stop();
  });

  test('a refusal that never clears latches after the grace window', async () => {
    const sockets = captureSockets();
    const closes: number[] = [];
    const link = dialing({ onTerminalClose: (code) => closes.push(code) }, sockets.factory);
    link.start();
    // Every dial is refused, as with a permanently rotated token. Backoff doubles
    // per attempt, so six refusals span roughly 31s.
    const refused = new Set<FakeSocket>();
    const deadline = Date.now() + 45_000;
    while (closes.length === 0 && Date.now() < deadline) {
      const socket = sockets.last();
      if (socket != null && !refused.has(socket)) {
        refused.add(socket);
        socket.refuseUpgrade();
      }
      await Bun.sleep(100);
    }
    expect(closes).toEqual([0]);
    expect(link.state()).toBe('rejected');
    // It gave up rather than dialing forever.
    expect(sockets.count()).toBeLessThanOrEqual(7);
    link.stop();
  }, 60_000);

  test('an error on an already-open socket still retries', () => {
    const sockets = captureSockets();
    const closes: number[] = [];
    const link = dialing({ onTerminalClose: (code) => closes.push(code) }, sockets.factory);
    link.start();
    const socket = sockets.last()!;
    socket.open();
    socket.hello();
    socket.refuseUpgrade();
    expect(closes).toEqual([]);
    link.stop();
  });
});

describe('connection view cloud status', () => {
  function managerWith(): { manager: ConnectionManager; id: string } {
    const root = tempDir();
    const manager = new ConnectionManager(new ConnectionStore(root), fakeFactory(new Map()));
    const id = 'wa-cloud';
    manager.store.add(id, null, 'Cloud', 'whatsapp');
    return { manager, id };
  }

  test('no url or token reports off', async () => {
    const { manager, id } = managerWith();
    expect(manager.view(id).cloudStatus).toBe('off');
  });

  test('a saved link that the phone has not started reports off', async () => {
    const { manager, id } = managerWith();
    // The phone itself is disabled, so there is no live session to attach a link to.
    await manager.disable(id);
    await manager.setCloud(id, 'wss://cloud.example/v1/companion', 'tok');
    expect(manager.view(id).cloudStatus).toBe('off');
  });

  test('a saved link on an enabled phone dials and reports connecting', async () => {
    const { manager, id } = managerWith();
    await manager.setCloud(id, 'wss://cloud.example/v1/companion', 'tok');
    // No live socket in a test process, but a CloudLink now exists for the row.
    expect(['connecting', 'retrying']).toContain(manager.view(id).cloudStatus);
  });

  test('clearing the url goes back to off', async () => {
    const { manager, id } = managerWith();
    await manager.setCloud(id, 'wss://cloud.example/v1/companion', 'tok');
    await manager.setCloud(id, null, null);
    const view = manager.view(id);
    expect(view.cloudStatus).toBe('off');
    expect(view.cloudUrl).toBeNull();
  });

  test('a stored rejection survives without a live link and clears on save', async () => {
    const { manager, id } = managerWith();
    await manager.setCloud(id, 'wss://cloud.example/v1/companion', 'stale');
    manager.store.saveMeta(id, { ...manager.store.meta(id), cloudRejectedAt: Date.now() });
    // Drop the link so the stored rejection is the only evidence left, which is
    // exactly the state after a restart.
    await manager.disable(id);
    const rejected = manager.view(id);
    expect(rejected.cloudStatus).toBe('rejected');
    expect(rejected.cloudError).toContain('token');

    await manager.setCloud(id, 'wss://cloud.example/v1/companion', 'fresh');
    manager.store.saveMeta(id, { ...manager.store.meta(id), cloudRejectedAt: null });
    expect(manager.view(id).cloudStatus).not.toBe('rejected');
    expect(manager.view(id).cloudError).toBeUndefined();
  });
});

describe('CloudLink event frames', () => {
  test('an event carries userId when the adapter knows the sender', () => {
    const sockets = captureSockets();
    const link = dialing({}, sockets.factory);
    link.start();
    const socket = sockets.last()!;
    socket.open();
    socket.hello();
    link.sendEvent('messages.upsert', { raw: true }, '85265862165');
    link.sendEvent('connection.update', { raw: true });
    const frames = socket.sent
      .map((raw) => JSON.parse(raw) as CloudFrame)
      .filter((frame) => frame.type === 'event');
    expect(frames[0]?.userId).toBe('85265862165');
    expect(frames[1]?.userId).toBeUndefined();
    link.stop();
  });

  test('hello carries the account and the whole channel profile', () => {
    const sockets = captureSockets();
    const link = dialing(
      {
        profile: () => ({
          account: '15551367394',
          userId: '15551367394:7@s.whatsapp.net',
          lid: '12799723978969:7@lid',
          phone: '15551367394',
          displayName: 'Pete Liu',
        }),
      },
      sockets.factory,
    );
    link.start();
    const socket = sockets.last()!;
    socket.open();
    const hello = JSON.parse(socket.sent[0]!) as CloudFrame;
    expect(hello.type).toBe('hello');
    expect(hello.channel).toBe('whatsapp');
    // `account` stays for servers that only read the legacy field.
    expect(hello.data).toEqual({
      account: '15551367394',
      profile: {
        account: '15551367394',
        userId: '15551367394:7@s.whatsapp.net',
        // The account's own LID rides the hello so the cloud can recognise an
        // `@lid` mention of the linked account (WhatsApp privacy addressing).
        lid: '12799723978969:7@lid',
        phone: '15551367394',
        displayName: 'Pete Liu',
      },
    });
    link.stop();
  });

  test('a channel with nothing to report still sends an empty hello data', () => {
    const sockets = captureSockets();
    const link = dialing({ account: () => undefined, profile: () => undefined }, sockets.factory);
    link.start();
    const socket = sockets.last()!;
    socket.open();
    const hello = JSON.parse(socket.sent[0]!) as CloudFrame;
    expect(hello.type).toBe('hello');
    expect(hello.data).toEqual({});
    link.stop();
  });
});
