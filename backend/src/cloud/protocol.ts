/**
 * @fileoverview Channel-agnostic cloud WebSocket frames. Vendor payloads live in `data`.
 */

export const PROTOCOL_VERSION = 1 as const;

export type CloudFrameType = 'hello' | 'event' | 'invoke' | 'result' | 'error' | 'ping' | 'pong';

export type CloudErrorCode =
  | 'NOT_CONNECTED'
  | 'METHOD_NOT_ALLOWED'
  | 'INVOKE_FAILED'
  | 'UNSUPPORTED_VERSION'
  | 'UNAUTHORIZED';

export interface CloudError {
  code: CloudErrorCode;
  message: string;
}

export interface CloudFrame {
  v: typeof PROTOCOL_VERSION;
  type: CloudFrameType;
  id?: string;
  connectionId?: string;
  channel?: string;
  name?: string;
  /**
   * Channel-scoped user this event concerns, when the adapter knows it
   * (a WhatsApp JID / phone, a LINE user id). Generic: the server never has to
   * parse a vendor payload to find the sender, and it is never a tenant id.
   */
  userId?: string;
  /**
   * Debug-log folder name for this turn. When set, the cloud uses it instead of
   * generating a timestamp. Omitted on ordinary traffic.
   */
  traceId?: string;
  data?: unknown;
  error?: CloudError;
}

/**
 * The single terminal close code. Any server-side rejection — unknown token,
 * disabled link, revoked, replaced — closes with this and no reason string, so a
 * companion can implement "server said no, do not retry" in one line. Transport
 * drops and the 4408 hello timeout are recoverable and keep the backoff.
 */
export const TERMINAL_CLOSE_CODE = 4401;

const BIN_KEY = '$bin';

export const CHANNEL_INVOKE: Record<string, readonly string[]> = {
  whatsapp: ['sendMessage', 'relayMessage', 'readMessages', 'sendPresenceUpdate', 'prepareMedia'],
  line: ['sendCompactMessage'],
};

export function allowedInvoke(channel: string, name: string): boolean {
  return (CHANNEL_INVOKE[channel] ?? []).includes(name);
}

export function encodeBin(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { [BIN_KEY]: Buffer.from(value).toString('base64') };
  }
  if (ArrayBuffer.isView(value) && value instanceof Object.getPrototypeOf(Uint8Array)) {
    return { [BIN_KEY]: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
  }
  if (Array.isArray(value)) return value.map(encodeBin);
  if (value != null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = encodeBin(item);
    }
    return out;
  }
  return value;
}

export function reviveBin(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveBin);
  if (value != null && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (keys.length === 1 && keys[0] === BIN_KEY && typeof rec[BIN_KEY] === 'string') {
      return Buffer.from(rec[BIN_KEY], 'base64');
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(rec)) {
      out[key] = reviveBin(item);
    }
    return out;
  }
  return value;
}

export function parseFrame(raw: string): CloudFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  if (rec.v !== PROTOCOL_VERSION) return null;
  const type = rec.type;
  if (
    type !== 'hello' &&
    type !== 'event' &&
    type !== 'invoke' &&
    type !== 'result' &&
    type !== 'error' &&
    type !== 'ping' &&
    type !== 'pong'
  ) {
    return null;
  }
  const frame: CloudFrame = { v: PROTOCOL_VERSION, type };
  if (typeof rec.id === 'string' && rec.id !== '') frame.id = rec.id;
  if (typeof rec.connectionId === 'string' && rec.connectionId !== '') frame.connectionId = rec.connectionId;
  if (typeof rec.channel === 'string' && rec.channel !== '') frame.channel = rec.channel;
  if (typeof rec.name === 'string' && rec.name !== '') frame.name = rec.name;
  if (typeof rec.userId === 'string' && rec.userId !== '') frame.userId = rec.userId;
  if (typeof rec.traceId === 'string' && rec.traceId !== '') frame.traceId = rec.traceId;
  if ('data' in rec) frame.data = reviveBin(rec.data);
  if (rec.error != null && typeof rec.error === 'object' && !Array.isArray(rec.error)) {
    const err = rec.error as Record<string, unknown>;
    if (typeof err.code === 'string' && typeof err.message === 'string') {
      frame.error = { code: err.code as CloudErrorCode, message: err.message };
    }
  }
  return frame;
}

export function stringifyFrame(frame: CloudFrame): string {
  const body: Record<string, unknown> = { v: PROTOCOL_VERSION, type: frame.type };
  if (frame.id != null) body.id = frame.id;
  if (frame.connectionId != null) body.connectionId = frame.connectionId;
  if (frame.channel != null) body.channel = frame.channel;
  if (frame.name != null) body.name = frame.name;
  if (frame.userId != null && frame.userId !== '') body.userId = frame.userId;
  if (frame.traceId != null && frame.traceId !== '') body.traceId = frame.traceId;
  if (frame.data !== undefined) body.data = encodeBin(frame.data);
  if (frame.error != null) body.error = frame.error;
  return JSON.stringify(body);
}
