import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { CHANNELS, type Channel } from './channel';
import { authDir, channelRoot, connectionDir, ensureDir, indexPath, metaPath } from './paths';
import { HttpError, ID_PATTERN, pruneDisconnectAt, type ConnectionIndexEntry, type ConnectionMeta } from './types';

const emptyMeta = (): ConnectionMeta => ({
  incomingCount: 0,
  outgoingCount: 0,
  connectedAt: null,
  lastError: null,
  disconnectAt: [],
  cloudRejectedAt: null,
});

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeRow(row: ConnectionIndexEntry, channel: Channel): ConnectionIndexEntry {
  return {
    ...row,
    channel,
    name: row.name != null && row.name !== '' ? row.name : row.id,
    cloudUrl: row.cloudUrl ?? null,
    cloudToken: row.cloudToken ?? null,
    webhookUrl: row.webhookUrl ?? null,
    webhookToken: row.webhookToken ?? null,
  };
}

export class ConnectionStore {
  constructor(readonly root: string) {
    for (const channel of CHANNELS) {
      ensureDir(channelRoot(this.root, channel));
      if (!existsSync(indexPath(this.root, channel))) writeJson(indexPath(this.root, channel), []);
    }
  }

  private readIndex(channel: Channel): ConnectionIndexEntry[] {
    return readJson<ConnectionIndexEntry[]>(indexPath(this.root, channel), []).map((row) =>
      normalizeRow(row, channel),
    );
  }

  private writeIndex(channel: Channel, rows: ConnectionIndexEntry[]): void {
    writeJson(
      indexPath(this.root, channel),
      rows.map((row) => normalizeRow(row, channel)),
    );
  }

  list(): ConnectionIndexEntry[] {
    return CHANNELS.flatMap((channel) => this.readIndex(channel));
  }

  get(id: string): ConnectionIndexEntry | undefined {
    return this.list().find((row) => row.id === id);
  }

  require(id: string): ConnectionIndexEntry {
    const row = this.get(id);
    if (row == null) throw new HttpError(404, 'NOT_FOUND', `Connection ${id} not found`);
    return row;
  }

  meta(id: string): ConnectionMeta {
    const row = this.require(id);
    const stored = { ...emptyMeta(), ...readJson<Partial<ConnectionMeta>>(metaPath(this.root, row.channel, id), {}) };
    stored.disconnectAt = pruneDisconnectAt(stored.disconnectAt);
    return stored;
  }

  saveMeta(id: string, meta: ConnectionMeta): void {
    const row = this.require(id);
    writeJson(metaPath(this.root, row.channel, id), { ...meta, disconnectAt: pruneDisconnectAt(meta.disconnectAt) });
  }

  add(
    id: string,
    webhookUrl: string | null = null,
    name?: string,
    channel: Channel = 'whatsapp',
  ): ConnectionIndexEntry {
    assertId(id);
    if (this.get(id) != null) throw new HttpError(409, 'CONFLICT', `Connection ${id} already exists`);
    mkdirSync(authDir(this.root, channel, id), { recursive: true });
    const row: ConnectionIndexEntry = {
      id,
      name: name != null && name.trim() !== '' ? name.trim() : id,
      channel,
      enabled: true,
      webhookUrl,
      webhookToken: null,
      cloudUrl: null,
      cloudToken: null,
      createdAt: Date.now(),
    };
    this.writeIndex(channel, [...this.readIndex(channel), row]);
    writeJson(metaPath(this.root, channel, id), emptyMeta());
    return row;
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        ConnectionIndexEntry,
        'enabled' | 'webhookUrl' | 'webhookToken' | 'cloudUrl' | 'cloudToken' | 'name'
      >
    >,
  ): ConnectionIndexEntry {
    const current = this.require(id);
    const rows = this.readIndex(current.channel);
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) throw new HttpError(404, 'NOT_FOUND', `Connection ${id} not found`);
    const next = { ...rows[index]!, ...patch, channel: current.channel };
    rows[index] = next;
    this.writeIndex(current.channel, rows);
    return next;
  }

  remove(id: string): void {
    const current = this.require(id);
    this.writeIndex(
      current.channel,
      this.readIndex(current.channel).filter((row) => row.id !== id),
    );
    rmSync(connectionDir(this.root, current.channel, id), { recursive: true, force: true });
  }
}

export function assertId(id: string): void {
  if (!ID_PATTERN.test(id) || id.length > 64) {
    throw new HttpError(400, 'INVALID_PARAM', 'id must be 1–64 letters, numbers, hyphen, or underscore');
  }
}

export function newConnectionId(channel: Channel = 'whatsapp'): string {
  const prefix = channel === 'line' ? 'line' : 'wa';
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
