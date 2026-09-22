import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { MESSAGE_RETENTION_MS, MessageStore, summarize } from '../src/messages';
import { QUEUE_MAX_AGE_MS } from '../src/types';

const dirs: string[] = [];

function tempStore(): MessageStore {
  const dir = mkdtempSync(join(tmpdir(), 'companion-msg-'));
  dirs.push(dir);
  return new MessageStore(join(dir, 'messages.sqlite'));
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir != null) rmSync(dir, { recursive: true, force: true });
  }
});

describe('MessageStore', () => {
  test('inserts, lists newest first, and paginates', () => {
    const store = tempStore();
    const base = Date.now();
    for (let i = 0; i < 12; i += 1) {
      store.insert({
        connectionId: 'home',
        channel: 'whatsapp',
        direction: 'out',
        providerId: `wamid.${i}`,
        type: 'text',
        fromId: '6591',
        toId: '6592',
        summary: `msg ${i}`,
        timestamp: base + i,
        rawIn: { to: '6592', text: `msg ${i}` },
        rawOut: { id: `wamid.${i}` },
      });
    }
    store.insert({
      connectionId: 'home',
      channel: 'whatsapp',
      direction: 'in',
      type: 'text',
      fromId: '6592',
      toId: '6591',
      summary: 'hello',
      timestamp: base + 100,
      rawIn: { text: 'hello' },
    });

    const page1 = store.list('home', { direction: 'out' }, 1, 10);
    expect(page1.total).toBe(12);
    expect(page1.messages).toHaveLength(10);
    expect(page1.messages[0]?.summary).toBe('msg 11');
    expect(Object.prototype.hasOwnProperty.call(page1.messages[0] ?? {}, 'rawIn')).toBe(false);

    const page2 = store.list('home', { direction: 'out' }, 2, 10);
    expect(page2.messages).toHaveLength(2);
    expect(page2.messages[1]?.summary).toBe('msg 0');

    const inbound = store.list('home', { direction: 'in' }, 1, 10);
    expect(inbound.total).toBe(1);
    expect(inbound.messages[0]?.summary).toBe('hello');

    const detail = store.get('home', page1.messages[0]!.id);
    expect(detail?.rawIn).toEqual({ to: '6592', text: 'msg 11' });
    expect(detail?.rawOut).toEqual({ id: 'wamid.11' });
    expect(store.get('other', page1.messages[0]!.id)).toBeUndefined();
    store.close();
  });

  test('filters by direction, type, and status, with a total that matches', () => {
    const store = tempStore();
    const base = Date.now();
    const add = (
      n: number,
      fields: { direction: 'in' | 'out'; type: string; status: 'na' | 'pending' | 'sent' | 'failed' },
    ): number =>
      store.insert({
        connectionId: 'home',
        channel: 'whatsapp',
        direction: fields.direction,
        type: fields.type,
        fromId: '6591',
        toId: '6592',
        summary: `msg ${n}`,
        timestamp: base + n,
        status: fields.status,
      });
    // One of each shape, interleaved so ordering is exercised across directions.
    add(1, { direction: 'in', type: 'text', status: 'sent' });
    add(2, { direction: 'out', type: 'text', status: 'sent' });
    add(3, { direction: 'in', type: 'unknown', status: 'na' });
    add(4, { direction: 'out', type: 'text', status: 'failed' });
    add(5, { direction: 'in', type: 'text', status: 'failed' });

    // No direction means both, still newest first.
    const all = store.list('home', {}, 1, 10);
    expect(all.total).toBe(5);
    expect(all.messages.map((row) => row.summary)).toEqual([
      'msg 5', 'msg 4', 'msg 3', 'msg 2', 'msg 1',
    ]);
    expect(store.list('home', { direction: 'all' }, 1, 10).total).toBe(5);

    expect(store.list('home', { direction: 'in' }, 1, 10).total).toBe(3);
    expect(store.list('home', { type: 'text' }, 1, 10).total).toBe(4);
    expect(store.list('home', { type: 'unknown' }, 1, 10).total).toBe(1);
    expect(store.list('home', { status: 'failed' }, 1, 10).total).toBe(2);
    expect(store.list('home', { status: 'na' }, 1, 10).total).toBe(1);

    // Filters combine, and the total follows them rather than the whole table.
    const combined = store.list('home', { direction: 'out', type: 'text', status: 'failed' }, 1, 10);
    expect(combined.total).toBe(1);
    expect(combined.messages[0]?.summary).toBe('msg 4');

    // A filter that matches nothing is a clean empty page, not an error.
    const empty = store.list('home', { type: 'image' }, 1, 10);
    expect(empty.total).toBe(0);
    expect(empty.messages).toEqual([]);

    // Pagination counts the filtered set: 4 text rows, 2 per page.
    const first = store.list('home', { type: 'text' }, 1, 2);
    expect(first.total).toBe(4);
    expect(first.messages.map((row) => row.summary)).toEqual(['msg 5', 'msg 4']);
    const second = store.list('home', { type: 'text' }, 2, 2);
    expect(second.messages.map((row) => row.summary)).toEqual(['msg 2', 'msg 1']);
    store.close();
  });

  test('prunes rows older than 7 days and deletes by connection', () => {
    const store = tempStore();
    const now = Date.now();
    store.insert(
      {
        connectionId: 'home',
        channel: 'whatsapp',
        direction: 'in',
        type: 'text',
        fromId: 'a',
        toId: 'b',
        summary: 'old',
        timestamp: now - MESSAGE_RETENTION_MS - 1000,
      },
      now,
    );
    store.insert(
      {
        connectionId: 'home',
        channel: 'whatsapp',
        direction: 'in',
        type: 'text',
        fromId: 'a',
        toId: 'b',
        summary: 'new',
        timestamp: now,
      },
      now,
    );
    store.insert(
      {
        connectionId: 'desk',
        channel: 'line',
        direction: 'in',
        type: 'text',
        fromId: 'u1',
        toId: 'u2',
        summary: 'line',
        timestamp: now,
      },
      now,
    );
    expect(store.prune(now)).toBe(1);
    expect(store.list('home', { direction: 'in' }, 1, 10).total).toBe(1);
    expect(store.list('home', { direction: 'in' }, 1, 10).messages[0]?.summary).toBe('new');
    store.deleteForConnection('home');
    expect(store.list('home', { direction: 'in' }, 1, 10).total).toBe(0);
    expect(store.list('desk', { direction: 'in' }, 1, 10).total).toBe(1);
    store.close();
  });

  test('summarize trims and caps length', () => {
    expect(summarize('  hello\nworld  ')).toBe('hello world');
    expect(summarize('x'.repeat(200)).length).toBe(120);
  });
});

/** A row in the queue, with sane defaults for the fields a test does not care about. */
function pending(
  store: MessageStore,
  overrides: Partial<Parameters<MessageStore['insert']>[0]> = {},
  now?: number,
): number {
  return store.insert(
    {
      connectionId: 'home',
      channel: 'whatsapp',
      direction: 'out',
      messageId: 'm1',
      type: 'text',
      fromId: '6591',
      toId: '6592',
      summary: 'hello',
      timestamp: now ?? Date.now(),
      status: 'pending',
      rawOut: { kind: 'sendText', to: '6592', text: 'hello' },
      ...overrides,
    },
    now,
  );
}

describe('MessageStore queue columns', () => {
  test('migrates a pre-queue table and keeps old history out of the queue', () => {
    const dir = mkdtempSync(join(tmpdir(), 'companion-legacy-'));
    dirs.push(dir);
    const path = join(dir, 'messages.sqlite');
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE "ChatMessage" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('in','out')),
        provider_id TEXT,
        type TEXT NOT NULL,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        raw_in TEXT,
        raw_out TEXT
      );
    `);
    legacy
      .query(
        `INSERT INTO "ChatMessage" (
          connection_id, channel, direction, provider_id, type,
          from_id, to_id, summary, timestamp, created_at
        ) VALUES ('home', 'whatsapp', 'in', 'wamid.old', 'text', 'a', 'b', 'old', 1, 1)`,
      )
      .run();
    legacy.close();

    const store = new MessageStore(path);
    const row = store.get('home', 1);
    // Old history is backfilled and marked `na`, so an upgrade cannot replay it.
    expect(row?.status).toBe('na');
    expect(row?.errorCount).toBe(0);
    expect(row?.messageId).toBe('wamid.old');
    expect(store.nextPending('home', 'in')).toBeUndefined();
    store.close();
  });

  test('defaults to na and takes the provider id as the message id', () => {
    const store = tempStore();
    const id = store.insert({
      connectionId: 'home',
      channel: 'whatsapp',
      direction: 'in',
      providerId: 'wamid.9',
      type: 'text',
      fromId: 'a',
      toId: 'b',
      summary: 'hi',
      timestamp: Date.now(),
    });
    const row = store.get('home', id);
    expect(row?.status).toBe('na');
    expect(row?.messageId).toBe('wamid.9');
    expect(row?.errorCount).toBe(0);
    expect(row?.lastError).toBeNull();
    store.close();
  });

  test('nextPending returns the oldest row per connection and direction', () => {
    const store = tempStore();
    pending(store, { messageId: 'first', direction: 'out' });
    pending(store, { messageId: 'second', direction: 'out' });
    pending(store, { messageId: 'inbound', direction: 'in' });
    pending(store, { messageId: 'other', connectionId: 'desk', direction: 'out' });
    pending(store, { messageId: 'done', direction: 'out', status: 'sent' });

    expect(store.nextPending('home', 'out')?.messageId).toBe('first');
    expect(store.nextPending('home', 'in')?.messageId).toBe('inbound');
    expect(store.nextPending('desk', 'out')?.messageId).toBe('other');
    expect(store.nextPending('desk', 'in')).toBeUndefined();

    // The revived payload comes back ready for the wire.
    expect(store.nextPending('home', 'out')?.rawOut).toEqual({
      kind: 'sendText',
      to: '6592',
      text: 'hello',
    });
    store.close();
  });

  test('markSent records the vendor id and clears the error state', () => {
    const store = tempStore();
    const id = pending(store);
    expect(store.markRetry(id, 'down')).toBe(1);
    store.markSent(id, 'wamid.ok');
    const row = store.get('home', id);
    expect(row?.status).toBe('sent');
    expect(row?.providerId).toBe('wamid.ok');
    expect(row?.errorCount).toBe(0);
    expect(row?.lastError).toBeNull();
    store.close();
  });

  test('markRetry counts up and markFailed latches the error', () => {
    const store = tempStore();
    const id = pending(store);
    expect(store.markRetry(id, 'down')).toBe(1);
    expect(store.markRetry(id, 'down')).toBe(2);
    expect(store.get('home', id)?.status).toBe('pending');
    store.markFailed(id, 'bad number');
    const row = store.get('home', id);
    expect(row?.status).toBe('failed');
    expect(row?.errorCount).toBe(2);
    expect(row?.lastError).toBe('bad number');
    store.close();
  });

  test('failAllPending only touches one connection and direction', () => {
    const store = tempStore();
    const a = pending(store, { messageId: 'a', direction: 'out' });
    const b = pending(store, { messageId: 'b', direction: 'out' });
    const c = pending(store, { messageId: 'c', direction: 'in' });
    const d = pending(store, { messageId: 'd', connectionId: 'desk', direction: 'out' });
    pending(store, { messageId: 'e', direction: 'out', status: 'sent' });

    expect(store.failAllPending('home', 'out', 'link rejected')).toBe(2);
    expect(store.get('home', c)?.status).toBe('pending');
    expect(store.get('desk', d)?.status).toBe('pending');
    expect(store.get('home', a)?.lastError).toBe('link rejected');
    expect(store.get('home', b)?.status).toBe('failed');
    store.close();
  });

  test('expireStale fails only pending rows older than the window', () => {
    const store = tempStore();
    const now = Date.now();
    const old = now - QUEUE_MAX_AGE_MS - 1_000;
    pending(store, { messageId: 'old-pending' }, old);
    pending(store, { messageId: 'fresh' }, now);
    // Already-sent work is not resurrected into `failed`.
    pending(store, { messageId: 'old-sent', status: 'sent' }, old);

    expect(store.expireStale(QUEUE_MAX_AGE_MS, now)).toBe(1);
    expect(store.get('home', 1)?.status).toBe('failed');
    expect(store.get('home', 1)?.lastError).toBe('expired');
    expect(store.get('home', 2)?.status).toBe('pending');
    expect(store.get('home', 3)?.status).toBe('sent');
    store.close();
  });
});
