import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import type { Channel } from './channel';
import { HttpError } from './types';

export const MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MESSAGE_PAGE_DEFAULT = 10;
export const MESSAGE_PAGE_MAX = 50;
export const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const SUMMARY_MAX = 120;

export type MessageDirection = 'in' | 'out';

/** `all` merges both directions into one listing. */
export type MessageDirectionFilter = MessageDirection | 'all';

/**
 * Delivery state of a row. A row is only ever forwarded when it is `pending`:
 * `na` is history / a connection with no cloud link, `sent` is done, `failed` is
 * terminal (a real receiver error, too many attempts, or expired).
 */
export type MessageStatus = 'na' | 'pending' | 'sent' | 'failed';

const MESSAGE_STATUSES: readonly MessageStatus[] = ['na', 'pending', 'sent', 'failed'];

export function isMessageStatus(value: unknown): value is MessageStatus {
  return typeof value === 'string' && (MESSAGE_STATUSES as readonly string[]).includes(value);
}

export interface ChatMessageInsert {
  connectionId: string;
  channel: Channel;
  direction: MessageDirection;
  /** Stable id handed to the caller/cloud. Defaults to the provider id. */
  messageId?: string;
  providerId?: string;
  type: string;
  fromId: string;
  toId: string;
  summary: string;
  timestamp: number;
  status?: MessageStatus;
  rawIn?: unknown;
  rawOut?: unknown;
}

export interface ChatMessageListItem {
  id: number;
  messageId: string | null;
  connectionId: string;
  channel: Channel;
  direction: MessageDirection;
  providerId: string | null;
  type: string;
  from: string;
  to: string;
  summary: string;
  timestamp: number;
  status: MessageStatus;
  errorCount: number;
}

export interface ChatMessageDetail extends ChatMessageListItem {
  createdAt: number;
  lastError: string | null;
  rawIn: unknown;
  rawOut: unknown;
}

export interface ChatMessageList {
  messages: ChatMessageListItem[];
  page: number;
  limit: number;
  total: number;
}

/** Listing filters. Omitted fields match everything. */
export interface MessageQuery {
  direction?: MessageDirectionFilter;
  type?: string;
  status?: MessageStatus;
}

export function isDirectionFilter(value: unknown): value is MessageDirectionFilter {
  return value === 'in' || value === 'out' || value === 'all';
}

interface ChatMessageRow {
  id: number;
  message_id: string | null;
  connection_id: string;
  channel: string;
  direction: string;
  provider_id: string | null;
  type: string;
  from_id: string;
  to_id: string;
  summary: string;
  timestamp: number;
  created_at: number;
  status: string;
  error_count: number;
  last_error: string | null;
  raw_in: string | null;
  raw_out: string | null;
}

const SELECT_COLUMNS = `id, message_id, connection_id, channel, direction, provider_id, type,
                from_id, to_id, summary, timestamp, created_at, status, error_count, last_error,
                raw_in, raw_out`;

export function messagesPath(root: string): string {
  return join(root, 'messages.sqlite');
}

export function summarize(text: string, max = SUMMARY_MAX): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, Math.max(1, max - 1))}…`;
}

export function safeJson(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value, (_key, nested: unknown) => {
      if (typeof Buffer !== 'undefined' && Buffer.isBuffer(nested)) {
        return { type: 'Buffer', data: nested.toString('base64') };
      }
      if (nested instanceof Uint8Array) {
        return { type: 'Uint8Array', data: Buffer.from(nested).toString('base64') };
      }
      if (typeof nested === 'bigint') return nested.toString();
      return nested;
    });
  } catch {
    return JSON.stringify({ error: 'unserializable' });
  }
}

/**
 * Reverse `safeJson`: a row read back from disk has its binary fields tagged as
 * `{ type: 'Buffer' | 'Uint8Array', data }`. Cloud frames encode binary as
 * `{ $bin }`, so a raw vendor payload must be revived before it is put on a frame
 * or the media would be sent as a plain object.
 */
export function reviveStoredBinary(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveStoredBinary);
  if (value != null && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const tag = rec.type;
    if ((tag === 'Buffer' || tag === 'Uint8Array') && typeof rec.data === 'string') {
      const bytes = Buffer.from(rec.data, 'base64');
      return tag === 'Buffer' ? bytes : new Uint8Array(bytes);
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(rec)) {
      out[key] = reviveStoredBinary(item);
    }
    return out;
  }
  return value;
}

function parseJson(raw: string | null): unknown {
  if (raw == null || raw === '') return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * Stored JSON for delivery. `raw_in` / `raw_out` keep the binary tags so the
 * public REST payload is unchanged, but a revived copy is handed back separately
 * for anything that goes back onto the wire.
 */
function parseRevived(raw: string | null): unknown {
  return reviveStoredBinary(parseJson(raw));
}

function toStatus(value: string): MessageStatus {
  return isMessageStatus(value) ? value : 'na';
}

function toListItem(row: ChatMessageRow): ChatMessageListItem {
  return {
    id: row.id,
    messageId: row.message_id,
    connectionId: row.connection_id,
    channel: row.channel as Channel,
    direction: row.direction as MessageDirection,
    providerId: row.provider_id,
    type: row.type,
    from: row.from_id,
    to: row.to_id,
    summary: row.summary,
    timestamp: row.timestamp,
    status: toStatus(row.status),
    errorCount: row.error_count,
  };
}

function toDetail(row: ChatMessageRow): ChatMessageDetail {
  return {
    ...toListItem(row),
    createdAt: row.created_at,
    lastError: row.last_error,
    rawIn: parseJson(row.raw_in),
    rawOut: parseJson(row.raw_out),
  };
}

/** A row read back for delivery: public view plus the wire-ready revived payloads. */
export interface QueuedMessage extends ChatMessageListItem {
  createdAt: number;
  lastError: string | null;
  rawIn: unknown;
  rawOut: unknown;
}

function toQueued(row: ChatMessageRow): QueuedMessage {
  return {
    ...toListItem(row),
    createdAt: row.created_at,
    lastError: row.last_error,
    rawIn: parseRevived(row.raw_in),
    rawOut: parseRevived(row.raw_out),
  };
}

export function parsePage(raw: string | undefined, fallback = 1): number {
  const n = Number(raw ?? fallback);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return n;
}

export function parseLimit(raw: string | undefined, fallback = MESSAGE_PAGE_DEFAULT): number {
  const n = Number(raw ?? fallback);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, MESSAGE_PAGE_MAX);
}

export class MessageStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA foreign_keys = ON');
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS "ChatMessage" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT,
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
        status TEXT NOT NULL DEFAULT 'na',
        error_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        raw_in TEXT,
        raw_out TEXT
      );
      CREATE INDEX IF NOT EXISTS ChatMessage_list
        ON "ChatMessage" (connection_id, direction, timestamp DESC, id DESC);
    `);
    this.migrate();
  }

  /**
   * Older installs predate the queue columns. SQLite has no `ADD COLUMN IF NOT
   * EXISTS`, so add only what `PRAGMA table_info` says is missing. Existing rows
   * default to `status='na'`, which keeps the 7-day history out of the queue.
   */
  private migrate(): void {
    const columns = new Set(
      (this.db.query(`PRAGMA table_info("ChatMessage")`).all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    const additions: Array<[string, string]> = [
      ['message_id', 'TEXT'],
      ['status', `TEXT NOT NULL DEFAULT 'na'`],
      ['error_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['last_error', 'TEXT'],
    ];
    for (const [name, definition] of additions) {
      if (columns.has(name)) continue;
      this.db.exec(`ALTER TABLE "ChatMessage" ADD COLUMN ${name} ${definition}`);
    }
    // A row's public id is its provider id when we have one; anything else is a
    // generated id that was never backfilled.
    this.db.exec(`UPDATE "ChatMessage" SET message_id = provider_id WHERE message_id IS NULL AND provider_id IS NOT NULL`);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS ChatMessage_pending
        ON "ChatMessage" (connection_id, direction, id)
        WHERE status = 'pending'
    `);
    // The merged listing has no direction predicate, so it cannot use
    // ChatMessage_list, which leads with direction.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS ChatMessage_all
        ON "ChatMessage" (connection_id, timestamp DESC, id DESC)
    `);
  }

  static memory(): MessageStore {
    return new MessageStore(':memory:');
  }

  insert(row: ChatMessageInsert, now = Date.now()): number {
    const status: MessageStatus = row.status ?? 'na';
    const result = this.db
      .query(
        `INSERT INTO "ChatMessage" (
          message_id, connection_id, channel, direction, provider_id, type,
          from_id, to_id, summary, timestamp, created_at, status, error_count, raw_in, raw_out
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        row.messageId ?? row.providerId ?? null,
        row.connectionId,
        row.channel,
        row.direction,
        row.providerId ?? null,
        row.type,
        row.fromId,
        row.toId,
        row.summary,
        row.timestamp,
        now,
        status,
        safeJson(row.rawIn),
        safeJson(row.rawOut),
      );
    return Number(result.lastInsertRowid);
  }

  /**
   * One page of history, newest first. Filters are AND-ed, and the same clause
   * backs the `COUNT(*)` so `total` and the page always agree.
   */
  list(connectionId: string, query: MessageQuery, page: number, limit: number): ChatMessageList {
    const direction = query.direction ?? 'all';
    if (!isDirectionFilter(direction)) {
      throw new HttpError(400, 'INVALID_PARAM', 'direction must be in, out, or all');
    }
    if (query.status != null && !isMessageStatus(query.status)) {
      throw new HttpError(400, 'INVALID_PARAM', 'status is invalid');
    }
    const safePage = page < 1 ? 1 : page;
    const safeLimit = Math.min(Math.max(limit, 1), MESSAGE_PAGE_MAX);

    // Values are bound, never interpolated, so the clause stays injection-safe.
    const where = ['connection_id = ?'];
    const params: Array<string | number> = [connectionId];
    if (direction !== 'all') {
      where.push('direction = ?');
      params.push(direction);
    }
    const type = query.type?.trim();
    if (type != null && type !== '') {
      where.push('type = ?');
      params.push(type);
    }
    if (query.status != null) {
      where.push('status = ?');
      params.push(query.status);
    }
    const clause = where.join(' AND ');

    const totalRow = this.db
      .query(`SELECT COUNT(*) AS total FROM "ChatMessage" WHERE ${clause}`)
      .get(...params) as { total: number };
    const total = Number(totalRow.total);
    const offset = (safePage - 1) * safeLimit;
    const rows = this.db
      .query(
        `SELECT ${SELECT_COLUMNS}
           FROM "ChatMessage"
          WHERE ${clause}
          ORDER BY timestamp DESC, id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, safeLimit, offset) as ChatMessageRow[];
    return {
      messages: rows.map(toListItem),
      page: safePage,
      limit: safeLimit,
      total,
    };
  }

  get(connectionId: string, id: number): ChatMessageDetail | undefined {
    const row = this.db
      .query(
        `SELECT ${SELECT_COLUMNS}
           FROM "ChatMessage"
          WHERE connection_id = ? AND id = ?`,
      )
      .get(connectionId, id) as ChatMessageRow | null;
    return row == null ? undefined : toDetail(row);
  }

  /**
   * Oldest still-queued row for one direction. Ordering by `id` (insert order)
   * is what makes the worker serial: it is the row that must go out first.
   */
  nextPending(connectionId: string, direction: MessageDirection): QueuedMessage | undefined {
    const row = this.db
      .query(
        `SELECT ${SELECT_COLUMNS}
           FROM "ChatMessage"
          WHERE connection_id = ? AND direction = ? AND status = 'pending'
          ORDER BY id ASC
          LIMIT 1`,
      )
      .get(connectionId, direction) as ChatMessageRow | null;
    return row == null ? undefined : toQueued(row);
  }

  markSent(id: number, providerId?: string | null): void {
    if (providerId != null && providerId !== '') {
      this.db
        .query(`UPDATE "ChatMessage" SET status = 'sent', error_count = 0, last_error = NULL, provider_id = ? WHERE id = ?`)
        .run(providerId, id);
      return;
    }
    this.db
      .query(`UPDATE "ChatMessage" SET status = 'sent', error_count = 0, last_error = NULL WHERE id = ?`)
      .run(id);
  }

  /** Counts a transport failure and returns the new count so the caller can cap it. */
  markRetry(id: number, error: string): number {
    this.db
      .query(
        `UPDATE "ChatMessage"
            SET error_count = error_count + 1, last_error = ?
          WHERE id = ?`,
      )
      .run(error, id);
    const row = this.db.query(`SELECT error_count FROM "ChatMessage" WHERE id = ?`).get(id) as
      | { error_count: number }
      | null;
    return row == null ? 0 : Number(row.error_count);
  }

  markFailed(id: number, error: string): void {
    this.db
      .query(`UPDATE "ChatMessage" SET status = 'failed', last_error = ? WHERE id = ?`)
      .run(error, id);
  }

  /** A real receiver error or a dropped link: everything queued for it is dead. */
  failAllPending(connectionId: string, direction: MessageDirection, error: string): number {
    const result = this.db
      .query(
        `UPDATE "ChatMessage"
            SET status = 'failed', last_error = ?
          WHERE connection_id = ? AND direction = ? AND status = 'pending'`,
      )
      .run(error, connectionId, direction);
    return Number(result.changes);
  }

  /**
   * Fails anything that has waited too long, using `created_at` (when it landed
   * locally) rather than the vendor timestamp, which can be skewed or zero.
   */
  expireStale(maxAgeMs: number, now = Date.now()): number {
    const cutoff = now - maxAgeMs;
    const result = this.db
      .query(
        `UPDATE "ChatMessage"
            SET status = 'failed', last_error = 'expired'
          WHERE status = 'pending' AND created_at < ?`,
      )
      .run(cutoff);
    return Number(result.changes);
  }

  deleteForConnection(connectionId: string): void {
    this.db.query(`DELETE FROM "ChatMessage" WHERE connection_id = ?`).run(connectionId);
  }

  prune(now = Date.now()): number {
    const cutoff = now - MESSAGE_RETENTION_MS;
    const result = this.db.query(`DELETE FROM "ChatMessage" WHERE timestamp < ?`).run(cutoff);
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}
