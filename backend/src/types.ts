import type { Channel } from './channel';

export const DEFAULT_PORT = 38888;
export const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
export const MAX_RESTARTS = 3;
export const LOGOUT_TIMEOUT_MS = 5_000;
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_RETRIES = 3;
export const DEDUPE_MAX = 1000;
export const DISCONNECT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Queue delivery caps, shared by both directions. */
export const QUEUE_MAX_ATTEMPTS = 3;
export const QUEUE_MAX_AGE_MS = 60 * 60 * 1000;
/** How often the queue is nudged even with no new activity (expiry, missed wakes). */
export const QUEUE_TICK_MS = 15_000;

export type ConnectionStatus =
  | 'disconnected'
  | 'qr'
  | 'connecting'
  | 'connected'
  | 'disabled'
  | 'error';

/**
 * Live state of the cloud reverse-WSS link. Derived only from this process's
 * `CloudLink`, so it says nothing about the server's view of the session — just
 * whether we are on the wire, waiting to be, or told to stay away.
 */
export type CloudStatus =
  | 'off'
  | 'connecting'
  | 'connected'
  | 'retrying'
  | 'rejected';

export const cloudRejectedHint =
  'cloud refused the link — save the url and a current token again';

/** `code === 0` is an upgrade refusal (HTTP 401), not a post-open 4401 close. */
export function cloudRejectedMessage(code: number): string {
  return code === 0 ? 'cloud refused the upgrade (401)' : `cloud rejected (${code})`;
}

export type DisconnectReasonName =
  | 'logout'
  | 'replaced'
  | 'rate_limited'
  | 'restart'
  | 'auth_corrupt'
  | 'transient';

export type { Channel } from './channel';

/**
 * Everything a paired device can name about the account it just linked. Sent on
 * the reverse-WSS `hello` so the cloud can fill its connection row (phone/mid →
 * `channelId`, phone → `phone`, handle → `username`, display name → `name`)
 * without a second round trip. Every field is optional: WhatsApp has a phone and
 * a push name, LINE has a mid and a displayName, and an unlinked session has
 * nothing.
 */
export interface ChannelProfile {
  /** Channel account id the device itself uses: WhatsApp phone digits, LINE mid. */
  account?: string;
  /** Raw vendor user id when it differs (WhatsApp device jid `123:12@s.whatsapp.net`). */
  userId?: string;
  /** Digits-only phone number. WhatsApp only — LINE profiles carry no phone. */
  phone?: string;
  /** Public @handle when the channel has one (WhatsApp). */
  username?: string;
  /** Display name other users see: WhatsApp push name, LINE displayName. */
  displayName?: string;
}

/** Drops empty values so `profile: {}` never travels on the wire. */
export function compactProfile(input: ChannelProfile): ChannelProfile | undefined {
  const profile: ChannelProfile = {};
  for (const [key, raw] of Object.entries(input)) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value !== '') (profile as Record<string, string>)[key] = value;
  }
  return Object.keys(profile).length > 0 ? profile : undefined;
}

export interface ConnectionIndexEntry {
  id: string;
  name: string;
  channel: Channel;
  enabled: boolean;
  webhookUrl: string | null;
  webhookToken: string | null;
  cloudUrl: string | null;
  cloudToken: string | null;
  /**
   * Media presign endpoint the cloud advertised on its last `hello`. Learned,
   * not configured: the Companion posts here to get an R2 PUT url and uploads
   * media directly, and falls back to sending bytes inline while it is absent.
   */
  uploadUrl: string | null;
  createdAt: number;
}

export interface ConnectionMeta {
  phone?: string;
  /** Display name when the channel provides one. */
  user?: string;
  incomingCount: number;
  outgoingCount: number;
  connectedAt: number | null;
  lastError: string | null;
  /** Epoch millis of unexpected disconnects. Pruned to the last 24 hours. */
  disconnectAt: number[];
  /**
   * Set when the cloud server closed the link with `4401`. Survives a restart
   * (the link stays broken until someone saves a new url/token), so the list can
   * keep saying "rejected" instead of looking merely offline.
   */
  cloudRejectedAt?: number | null;
}

export interface ConnectionView {
  id: string;
  name: string;
  channel: Channel;
  status: ConnectionStatus;
  phone?: string;
  user?: string;
  enabled: boolean;
  webhookUrl: string | null;
  /** Sent as `Authorization: Bearer` on every webhook POST. */
  webhookToken: string | null;
  cloudUrl: string | null;
  cloudToken: string | null;
  /**
   * Media presign endpoint learned from the cloud's `hello`, or null when it
   * advertised none (the link then uploads media inline).
   */
  uploadUrl: string | null;
  /** Live cloud-link state; `off` when no url/token is configured. */
  cloudStatus: CloudStatus;
  /** Set only after a `4401` rejection, until the link is saved again. */
  cloudError?: string;
  uptimeMs?: number;
  incomingCount: number;
  outgoingCount: number;
  /** Unexpected disconnects in the last 24 hours. */
  disconnectCount: number;
  /** LINE pairing PIN while linking; always null for WhatsApp. */
  pin: string | null;
  lastError?: string;
}

export function pruneDisconnectAt(at: number[] | undefined, now = Date.now()): number[] {
  const cutoff = now - DISCONNECT_WINDOW_MS;
  return (at ?? []).filter((t) => Number.isFinite(t) && t > cutoff);
}

export function recordDisconnectAt(at: number[] | undefined, now = Date.now()): number[] {
  return pruneDisconnectAt([...(at ?? []), now], now);
}

export interface AppConfig {
  token: string;
  port: number;
}

export interface InboundText {
  connectionId: string;
  channel: Channel;
  id: string;
  from: string;
  to: string;
  text: string;
  timestamp: number;
  type: 'text';
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function jsonError(error: HttpError): { error: string; message: string } {
  return { error: error.code, message: error.message };
}
