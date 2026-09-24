import makeWASocket, {
  downloadMediaMessage,
  prepareWAMessageMedia,
  useMultiFileAuthState,
  type BaileysEventMap,
  type CacheStore,
  type proto,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import { createHash } from 'node:crypto';
import type { ChannelFactory, ChannelSession, SessionHooks } from './channel';
import { mapDisconnect } from './disconnect';
import { compactProfile, DEDUPE_MAX, LOGOUT_TIMEOUT_MS, type ChannelProfile } from './types';
import { logJson } from './log';
import { encodeMediaProto, type SessionMediaCache } from './media/cache';
import { whatsappMediaExpiryMs } from './media/expiry';
import {
  MEDIA_CACHE_FETCH_TIMEOUT_MS,
  MEDIA_CACHE_MAX_FETCH_BYTES,
  resolveOutboundContent,
} from './media/outbound';
import { normalizeSha256, sha256Base64Url } from './media/sha';

export type { ChannelFactory, ChannelSession, SessionHooks };

/** Message kinds whose plaintext the cloud needs; every other kind stays vendor-only. */
const MEDIA_KINDS = new Set(['image', 'video', 'audio', 'document']);

/** Largest plaintext file attached to one message. */
export const COMPANION_MEDIA_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Largest plaintext total attached to one `messages.upsert` frame. An album
 * shares a frame, and the server's websocket payload limit applies per frame,
 * so the per-file cap alone cannot bound it.
 */
export const COMPANION_FRAME_MEDIA_BUDGET_BYTES = 6 * 1024 * 1024;

/** Decrypted plaintext for one media message, attached beside `key` / `message`. */
export interface CompanionMediaBlock {
  /** Decrypted plaintext, when it travels inline (1A). */
  bytes?: Uint8Array;
  /** Stored object url, when the Companion uploaded it itself (1B). */
  url?: string;
  mimetype?: string;
  /** SHA-256 of `bytes`, base64url without padding. */
  sha256: string;
  /** Plaintext byte count. */
  length: number;
}

interface SocketEntry {
  sock: WASocket;
  connected: boolean;
}

function capWait<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function phoneOf(jid: string | null | undefined): string | undefined {
  if (jid == null || jid === '') return undefined;
  const digits = (jid.split('@')[0]?.split(':')[0] ?? '').replace(/\D/g, '');
  return digits === '' ? undefined : digits;
}

/**
 * The single channel user a batch concerns, or undefined when it mixes senders.
 * Keeps a frame's top-level `userId` honest for batched `messages.upsert` events.
 */
function singleSenderId(messages: readonly WAMessage[]): string | undefined {
  const ids = new Set<string>();
  for (const msg of messages) {
    const id = senderPhoneFromKey(msg.key) ?? msg.key?.remoteJid ?? '';
    if (id !== '') ids.add(id);
  }
  return ids.size === 1 ? [...ids][0] : undefined;
}

function isPnJid(jid: string): boolean {
  const host = jid.split('@')[1] ?? '';
  return host === 's.whatsapp.net' || host.startsWith('s.whatsapp.net');
}

/** Prefer the phone JID (PN) over LID addressing used on newer WhatsApp keys. */
export function senderPhoneFromKey(key: {
  participant?: string | null;
  participantAlt?: string | null;
  remoteJid?: string | null;
  remoteJidAlt?: string | null;
} | null | undefined): string | undefined {
  if (key == null) return undefined;
  const candidates = [key.participantAlt, key.remoteJidAlt, key.participant, key.remoteJid];
  for (const jid of candidates) {
    if (typeof jid !== 'string' || jid === '' || !isPnJid(jid)) continue;
    const phone = phoneOf(jid);
    if (phone != null) return phone;
  }
  for (const jid of candidates) {
    if (typeof jid !== 'string' || jid === '') continue;
    const phone = phoneOf(jid);
    if (phone != null) return phone;
  }
  return undefined;
}

function displayNameOf(
  user: { name?: string; notify?: string; verifiedName?: string; username?: string } | undefined,
): string | undefined {
  for (const value of [user?.notify, user?.name, user?.verifiedName, user?.username]) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/**
 * WhatsApp chat id for a recipient. A bare phone (`+852…`, digits) becomes the
 * user JID; a value that already carries a server — a group `…@g.us`, or any
 * addressed jid — is passed through, because stripping its suffix would rewrite
 * it into a phone-shaped address no conversation answers to.
 */
export function toJid(to: string): string {
  const trimmed = to.trim();
  if (trimmed.includes('@')) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}

function unwrapConversation(msg: WAMessage): string | null {
  const raw = msg.message as Record<string, unknown> | null | undefined;
  if (raw == null) return null;
  const inner = unwrapContent(raw);
  if (inner.conversation != null) return String(inner.conversation);
  const extended = inner.extendedTextMessage;
  if (extended != null && typeof extended === 'object') {
    const text = (extended as { text?: string }).text;
    if (typeof text === 'string' && text !== '') return text;
  }
  return null;
}

function unwrapContent(message: Record<string, unknown>): Record<string, unknown> {
  const ephemeral = message.ephemeralMessage as { message?: Record<string, unknown> } | undefined;
  if (ephemeral?.message != null) return unwrapContent(ephemeral.message);
  const viewOnce = message.viewOnceMessage as { message?: Record<string, unknown> } | undefined;
  if (viewOnce?.message != null) return unwrapContent(viewOnce.message);
  const viewOnceV2 = message.viewOnceMessageV2 as { message?: Record<string, unknown> } | undefined;
  if (viewOnceV2?.message != null) return unwrapContent(viewOnceV2.message);
  return message;
}

export function messageType(msg: WAMessage): string {
  const raw = msg.message as Record<string, unknown> | null | undefined;
  if (raw == null) return 'unknown';
  const content = unwrapContent(raw);
  // `conversation` is the bare protobuf field used for ordinary text. It is
  // not a `*Message` key, and messageContextInfo is metadata, not a message.
  if (content.conversation != null) return 'text';
  if (content.extendedTextMessage != null) return 'text';
  const key = Object.keys(content).find((name) => name.endsWith('Message'));
  if (key == null) return 'unknown';
  return key.replace(/Message$/, '').toLowerCase();
}

/** Payload names a decrypted media block can come from, in proto order. */
const MEDIA_PROTO_KEYS = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'];

/** The inner proto of a media message, or null when the kind carries none. */
function mediaProto(msg: WAMessage): Record<string, unknown> | null {
  const raw = msg.message as Record<string, unknown> | null | undefined;
  if (raw == null) return null;
  const inner = unwrapContent(raw);
  for (const key of MEDIA_PROTO_KEYS) {
    const value = inner[key];
    if (value != null && typeof value === 'object') return value as Record<string, unknown>;
  }
  return null;
}

/** Inner proto `mimetype`; it is what the cloud turns into a file extension. */
function mediaMimetype(msg: WAMessage): string | undefined {
  const mimetype = mediaProto(msg)?.['mimetype'];
  return typeof mimetype === 'string' && mimetype !== '' ? mimetype : undefined;
}

/** Proto numbers arrive as `number`, a numeric string, or a Long. */
function protoNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value != null && typeof value === 'object') {
    const toNumber = (value as { toNumber?: unknown }).toNumber;
    if (typeof toNumber === 'function') {
      const parsed = (toNumber as () => number).call(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

/** Declared plaintext length of a media message, known before decrypting it. */
function declaredMediaLength(msg: WAMessage): number | null {
  return protoNumber(mediaProto(msg)?.['fileLength']);
}

/**
 * Fetches and decrypts one media message's plaintext.
 *
 * Null means "no media to ship": the blob could not be fetched or decrypted (an
 * expired CDN url is recovered through `reuploadRequest`, which only the live
 * socket can ask for) or it came back empty. The caller then forwards the
 * message without a block and the cloud skips it.
 */
async function downloadMediaBytes(sock: WASocket, msg: WAMessage): Promise<Uint8Array | null> {
  try {
    const ctx: DownloadContext = {
      logger: baileysLogger() as unknown as DownloadContext['logger'],
      reuploadRequest: (message) => sock.updateMediaMessage(message),
    };
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, ctx);
    if (buffer == null || buffer.byteLength === 0) return null;
    return new Uint8Array(buffer);
  } catch (error) {
    console.warn('[companion][websocket][error] WhatsApp media decrypt failed', {
      id: msg.key?.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export interface CompanionMediaPlan {
  /** The block to attach, or null when this message ships without its media. */
  block: CompanionMediaBlock | null;
  /** Frame budget left after this message. */
  remaining: number;
  /**
   * Plaintext that was decrypted, when one was.
   *
   * Kept beside the block rather than inside it because a 1B block carries the
   * uploaded url and no bytes, and those bytes are still worth caching so the
   * next copy of the same file costs neither a download nor an upload.
   */
  plaintext?: Uint8Array;
}

/**
 * Decides whether one message's media ships with the frame, and builds its block.
 *
 * Two ways it can ship:
 * - `upload` (1B): the bytes go straight to the cloud's storage and the block
 *   carries a url. The frame budget is untouched, since nothing rides the frame.
 * - inline (1A): the bytes ride in the block, bounded by the per-file cap and the
 *   frame budget.
 *
 * The caps are checked smallest-first so a huge album cannot be pulled down just
 * to be discarded: the declared proto length is known before any download, then
 * the real length after it. `decrypt` and `upload` are injected so these rules
 * are testable without a live WhatsApp session.
 */
export async function attachCompanionMedia(options: {
  kind: string;
  /** Proto `fileLength`, known before the download. */
  declaredLength: number | null;
  /** Plaintext bytes still allowed in this frame. */
  remaining: number;
  mimetype?: string;
  decrypt: () => Promise<Uint8Array | null>;
  /** Direct-to-storage upload; absent when the link has no presign endpoint. */
  upload?: (bytes: Uint8Array, mimetype: string) => Promise<{ url: string } | null>;
}): Promise<CompanionMediaPlan> {
  const { kind, declaredLength, remaining, decrypt, upload } = options;
  if (!MEDIA_KINDS.has(kind)) return { block: null, remaining };
  // Without an uploader the budget is spent by the bytes themselves, so a batch
  // that cannot fit can be rejected before the download.
  if (upload == null) {
    if (remaining <= 0) return { block: null, remaining };
    if (declaredLength != null && declaredLength > remaining) {
      console.warn('[companion][websocket] WhatsApp media over the frame budget, not decrypted', {
        kind,
        length: declaredLength,
        remaining,
      });
      return { block: null, remaining };
    }
  }

  const bytes = await decrypt();
  if (bytes == null || bytes.byteLength === 0) return { block: null, remaining };
  if (bytes.byteLength > COMPANION_MEDIA_MAX_BYTES) {
    console.warn('[companion][websocket] WhatsApp media over the per-file cap, not attached', {
      kind,
      length: bytes.byteLength,
    });
    return { block: null, remaining };
  }

  const mimetype = options.mimetype ?? 'application/octet-stream';
  const sha256 = createHash('sha256').update(bytes).digest('base64url');
  if (upload != null) {
    const uploaded = await upload(bytes, mimetype);
    if (uploaded != null && uploaded.url !== '') {
      return {
        block: { url: uploaded.url, mimetype, sha256, length: bytes.byteLength },
        remaining,
        plaintext: bytes,
      };
    }
    // Fall through to inline: an upload that failed must not cost the message.
  }

  if (bytes.byteLength > remaining) {
    console.warn('[companion][websocket] WhatsApp media over the frame budget, not attached', {
      kind,
      length: bytes.byteLength,
      remaining,
    });
    return { block: null, remaining };
  }
  return {
    block: {
      bytes,
      mimetype,
      sha256,
      length: bytes.byteLength,
    },
    remaining: remaining - bytes.byteLength,
    plaintext: bytes,
  };
}

/** The digest a media proto declares, canonicalized, or null when it declares none. */
function declaredMediaSha(msg: WAMessage): string | null {
  return normalizeSha256(mediaProto(msg)?.['fileSha256']);
}

/** The vendor url a media proto carries. Encrypted, so only ever a lookup key. */
function inboundMediaUrl(msg: WAMessage): string {
  const url = mediaProto(msg)?.['url'];
  return typeof url === 'string' ? url.trim() : '';
}

/**
 * The received media submessage, reduced to what re-sending it needs.
 *
 * Null when the proto cannot be resolved by WhatsApp at all — no `url` or
 * `directPath` to fetch, or no `mediaKey` to decrypt — because caching something
 * unusable would turn a later miss into a broken message rather than a re-upload.
 *
 * `contextInfo` is dropped: it describes the reply/mention context of *this*
 * inbound message, and carrying it into a new send would echo the sender's
 * metadata back at them.
 */
function resendableMediaProto(msg: WAMessage): Record<string, unknown> | null {
  const submessage = mediaProto(msg);
  if (submessage == null) return null;
  const url = submessage['url'];
  const directPath = submessage['directPath'];
  const located =
    (typeof url === 'string' && url !== '') ||
    (typeof directPath === 'string' && directPath !== '');
  if (!located || submessage['mediaKey'] == null) return null;
  const { contextInfo: _contextInfo, ...rest } = submessage;
  return rest;
}

/** When WhatsApp stops serving this message's blob, or null when it declared none. */
function inboundProtoExpiry(msg: WAMessage): number | null {
  const submessage = mediaProto(msg);
  if (submessage == null) return null;
  const url = submessage['url'];
  return whatsappMediaExpiryMs({
    url: typeof url === 'string' ? url : undefined,
    mediaKeyTimestamp: submessage['mediaKeyTimestamp'],
  });
}

/**
 * Serves one inbound media message from the local cache, or null to fall through
 * to a real download.
 *
 * Null means nothing usable is cached: no digest is known, or a row exists
 * without its plaintext (a proto captured on the outbound path, say). A hit pays
 * off in one of three ways, cheapest first:
 *
 * - a **stored url** the cloud can still fetch, so nothing leaves this machine;
 * - the **uploader**, so the cloud gets the url a fresh decrypt would have
 *   produced without touching the WhatsApp CDN;
 * - **inline bytes**, bounded by the same per-file cap and frame budget every
 *   other media block obeys.
 */
export async function cachedCompanionMedia(options: {
  cache: SessionMediaCache;
  kind: string;
  /** Digest from the proto, or a digest the vendor url is already known to carry. */
  sha256: string | null;
  mimetype?: string;
  /** Plaintext bytes still allowed in this frame. */
  remaining: number;
  upload?: (bytes: Uint8Array, mimetype: string) => Promise<{ url: string } | null>;
}): Promise<CompanionMediaPlan | null> {
  const { cache, kind, remaining } = options;
  // Normalized here rather than at the call site: the digest in the block goes on
  // the wire, so it must be canonical whatever spelling arrived.
  const sha256 = normalizeSha256(options.sha256);
  if (sha256 == null) return null;
  const bytes = cache.readBytes(sha256);
  if (bytes == null) return null;
  const mimetype = options.mimetype ?? cache.mimeFor(sha256) ?? 'application/octet-stream';
  const length = bytes.byteLength;

  const stored = cache.storedUrl(sha256);
  if (stored != null) {
    logJson('incoming', 'websocket', 'media cache url reused', { kind, length });
    return { block: { url: stored, mimetype, sha256, length }, remaining };
  }
  if (options.upload != null) {
    const uploaded = await options.upload(bytes, mimetype);
    if (uploaded != null && uploaded.url !== '') {
      cache.rememberUrl({ url: uploaded.url, sha256, role: 'stored', kind });
      logJson('incoming', 'websocket', 'media cache bytes uploaded', { kind, length });
      return { block: { url: uploaded.url, mimetype, sha256, length }, remaining };
    }
  }
  if (length > COMPANION_MEDIA_MAX_BYTES || length > remaining) {
    logJson('incoming', 'websocket', 'media cache hit over the frame budget, not attached', {
      kind,
      length,
      remaining,
    });
    return { block: null, remaining };
  }
  logJson('incoming', 'websocket', 'media cache bytes reused', { kind, length });
  return {
    block: { bytes, mimetype, sha256, length },
    remaining: remaining - length,
  };
}

/**
 * Fetches a media url into memory, bounded twice: by a byte ceiling and by a
 * timeout.
 *
 * Null on anything unexpected, because every caller's fallback is to let Baileys
 * do the download itself — a failure here only means the send is no cheaper than
 * it used to be, never that it fails.
 */
async function fetchMediaBytes(url: string): Promise<Uint8Array | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(MEDIA_CACHE_FETCH_TIMEOUT_MS) });
    if (!response.ok) return null;
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MEDIA_CACHE_MAX_FETCH_BYTES) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > MEDIA_CACHE_MAX_FETCH_BYTES) return null;
    return new Uint8Array(buffer);
  } catch (error) {
    console.warn('[companion][media] outbound fetch failed', {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

type DownloadContext = NonNullable<Parameters<typeof downloadMediaMessage>[3]>;

const silent = (): void => undefined;

function baileysLogger() {
  const logger = {
    level: 'silent',
    trace: silent,
    debug: silent,
    info: silent,
    warn: silent,
    error: silent,
    fatal: silent,
    child: () => logger,
  };
  return logger;
}

/**
 * Uploads one interactive header media item to WhatsApp and returns its proto.
 *
 * `args` are `[kind, url, mimetype?, fileName?, sha256?]`. The mimetype matters:
 * Baileys falls back to a per-type default (`image/jpeg` and friends), so a PNG
 * header would be declared JPEG without it. The caller knows the stored object's
 * mime, so it passes it through. `sha256` is the digest of the plaintext when the
 * caller knows it.
 *
 * `mediaCache` is Baileys' own media cache. Supplying it is what makes a repeated
 * header image free: a url whose digest the cache has a proto for is answered
 * without a download or an upload, exactly as on the `sendMessage` path.
 *
 * Exported for tests: it is the one invoke whose argument shape is positional.
 */
export async function prepareMediaContent(
  sock: WASocket,
  args: unknown[],
  upload: WASocket['waUploadToServer'] = sock.waUploadToServer,
  mediaCache?: CacheStore,
): Promise<proto.IMessage> {
  const kind = typeof args[0] === 'string' ? args[0] : '';
  const url = typeof args[1] === 'string' ? args[1] : '';
  const mimetype = typeof args[2] === 'string' && args[2] !== '' ? args[2] : undefined;
  const fileName = typeof args[3] === 'string' && args[3] !== '' ? args[3] : undefined;
  if (url === '') throw new Error('prepareMedia requires a url');
  const options = mediaCache == null ? { upload } : { upload, mediaCache };

  if (kind === 'video') {
    return prepareWAMessageMedia({ video: { url }, ...(mimetype != null ? { mimetype } : {}) }, options);
  }
  if (kind === 'document') {
    return prepareWAMessageMedia(
      { document: { url }, fileName: fileName ?? 'file', mimetype: mimetype ?? 'application/octet-stream' },
      options,
    );
  }
  if (kind !== 'image') throw new Error(`unsupported media kind ${kind}`);
  return prepareWAMessageMedia({ image: { url }, ...(mimetype != null ? { mimetype } : {}) }, options);
}

class BaileysSession implements ChannelSession {
  private entry: SocketEntry | null = null;
  private currentQr: string | null = null;
  private currentPhone: string | undefined;
  private currentUser: string | undefined;
  private epoch = 0;
  private manualClose = false;
  private readonly seen = new Set<string>();

  constructor(
    readonly id: string,
    readonly authFolder: string,
    readonly hooks: SessionHooks,
  ) {}

  qr(): string | null {
    return this.currentQr;
  }

  pin(): string | null {
    return null;
  }

  isConnected(): boolean {
    return this.entry?.connected === true;
  }

  account(): string | undefined {
    return this.currentPhone ?? phoneOf(this.entry?.sock.user?.id);
  }

  user(): string | undefined {
    return this.currentUser ?? displayNameOf(this.entry?.sock.user);
  }

  /**
   * What WhatsApp exposes the moment the session opens (and on every restore):
   * the phone digits, the device jid, the push name and the @handle when set.
   * This is the payload the cloud turns into `phone` / `channelId` / `name`.
   */
  profile(): ChannelProfile | undefined {
    const user = this.entry?.sock.user;
    const rawUsername = (user as { username?: unknown } | undefined)?.username;
    // WhatsApp privacy addressing: the account's own @-mentions and quoted
    // authors arrive as `@lid`, so the cloud needs our lid to recognise itself.
    const rawLid = (user as { lid?: unknown } | undefined)?.lid;
    return compactProfile({
      account: this.account() ?? '',
      userId: user?.id ?? '',
      lid: typeof rawLid === 'string' ? rawLid : '',
      phone: this.account() ?? '',
      username: typeof rawUsername === 'string' ? rawUsername : '',
      displayName: this.user() ?? '',
    });
  }

  async connect(_options: { restore: boolean }): Promise<void> {
    await this.openSocket();
  }

  async disconnect(options: { logout: boolean }): Promise<void> {
    this.epoch += 1;
    const entry = this.entry;
    this.entry = null;
    this.currentQr = null;
    this.manualClose = true;
    if (entry == null) return;
    const linked = options.logout && (entry.connected || entry.sock.user != null);
    try {
      if (linked) await capWait(entry.sock.logout(), LOGOUT_TIMEOUT_MS);
      else entry.sock.end(undefined);
    } catch {
      try {
        entry.sock.end(undefined);
      } catch {
        /* already closed */
      }
    }
  }

  async sendText(to: string, text: string): Promise<{ id: string }> {
    const entry = this.entry;
    if (entry == null || !entry.connected) {
      throw new Error('not connected');
    }
    const payload = { text };
    logJson('outgoing', 'websocket', 'whatsapp.sendMessage', {
      connectionId: this.id,
      to: toJid(to),
      payload,
    });
    try {
      const sent = await entry.sock.sendMessage(toJid(to), payload);
      const result = { id: sent?.key?.id ?? '' };
      logJson('incoming', 'websocket', 'whatsapp.sendMessage.result', {
        connectionId: this.id,
        result,
      });
      return result;
    } catch (error) {
      console.error('[companion][websocket][error] WhatsApp sendMessage failed', error);
      throw error;
    }
  }

  async invoke(name: string, args: unknown[]): Promise<unknown> {
    const entry = this.entry;
    if (entry == null || !entry.connected) {
      throw new Error('not connected');
    }
    // `prepareMedia` is a module-level Baileys helper, not a socket method, so
    // it cannot go through the generic `sock[name]` dispatch below. It exists
    // because only the process holding the socket can upload media to WhatsApp,
    // which an interactive header needs before the relay.
    if (name === 'prepareMedia') {
      return this.prepareMedia(entry, args);
    }
    if (name === 'sendMessage') {
      return this.sendMessage(entry, args);
    }
    return this.dispatch(entry, name, args);
  }

  /**
   * Prepares interactive header media, reusing cached media when a cache is wired.
   *
   * The cloud sends the digest alongside the url when it has one (the fifth
   * positional arg). Recording it here is what makes the url a usable cache key,
   * so the header upload can be answered from the proto WhatsApp already accepted
   * instead of being downloaded and uploaded again.
   *
   * Logged at both ends because this path is otherwise silent: a slow header
   * upload and a pure cache hit look identical from the cloud side, and telling
   * them apart is what a "the reply arrived without its buttons" report needs.
   */
  private async prepareMedia(entry: SocketEntry, args: unknown[]): Promise<unknown> {
    const cache = this.hooks.mediaCache;
    const sha256 = normalizeSha256(args[4]);
    const url = typeof args[1] === 'string' ? args[1].trim() : '';
    const kind = typeof args[0] === 'string' ? args[0] : '';
    if (cache != null && sha256 != null && url !== '') {
      cache.rememberUrl({ url, sha256, role: 'stored', kind });
    }
    const startedAt = Date.now();
    const reusable = cache != null && sha256 != null && cache.hasProto(sha256);
    logJson('incoming', 'websocket', 'prepareMedia started', {
      kind,
      sha256: sha256 ?? null,
      reusable,
      expiresAt: cache != null && sha256 != null ? cache.protoExpiry(sha256) : null,
    });
    const media = await prepareMediaContent(
      entry.sock,
      args,
      entry.sock.waUploadToServer,
      cache?.baileys,
    );
    logJson('incoming', 'websocket', 'prepareMedia finished', {
      kind,
      sha256: sha256 ?? null,
      reusable,
      elapsedMs: Date.now() - startedAt,
    });
    return media;
  }

  /**
   * Sends one message, reusing cached media when the host wired a cache.
   *
   * The cache can hand Baileys a local file, or the proto WhatsApp already
   * accepted, so the same picture sent twice is neither downloaded twice nor
   * uploaded twice. It cannot make a send worse: content it cannot improve on is
   * passed through untouched, and a resolution failure keeps the original url.
   */
  private async sendMessage(entry: SocketEntry, args: unknown[]): Promise<unknown> {
    const cache = this.hooks.mediaCache;
    if (cache == null) return this.dispatch(entry, 'sendMessage', args);
    let content = args[1];
    try {
      content = await resolveOutboundContent({
        content: args[1],
        cache,
        fetchBytes: (url) => fetchMediaBytes(url),
        blobPath: (sha256) => cache.blobPath(sha256),
      });
    } catch (error) {
      // The cache is an optimisation; a bug in it must never cost the message.
      console.warn('[companion][media] outbound media resolution failed', error);
    }
    return this.dispatch(entry, 'sendMessage', content === args[1] ? args : [args[0], content, ...args.slice(2)]);
  }

  /** Applies `args` to the named socket method. Shared by both send paths. */
  private dispatch(entry: SocketEntry, name: string, args: unknown[]): unknown {
    const sock = entry.sock as unknown as Record<string, unknown>;
    const method = sock[name];
    if (typeof method !== 'function') {
      throw new Error(`method ${name} is not available`);
    }
    return (method as (...params: unknown[]) => unknown).apply(entry.sock, args);
  }

  private async openSocket(): Promise<void> {
    if (this.entry != null) await this.disconnect({ logout: false });
    this.manualClose = false;
    const epoch = this.epoch;
    const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);
    if (this.epoch !== epoch) return;
    const sock = makeWASocket({
      auth: state,
      logger: baileysLogger() as unknown as Parameters<typeof makeWASocket>[0]['logger'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      browser: ['AI Companion', 'Chrome', '120.0.0'],
      getMessage: async () => undefined,
      // Baileys asks this before uploading media: a hit reuses the proto WhatsApp
      // already accepted, so a repeat send is neither downloaded nor uploaded.
      ...(this.hooks.mediaCache == null ? {} : { mediaCache: this.hooks.mediaCache.baileys }),
    });
    if (this.epoch !== epoch) {
      try {
        sock.end(undefined);
      } catch {
        /* replaced */
      }
      return;
    }
    const entry: SocketEntry = { sock, connected: false };
    this.entry = entry;

    sock.ev.on('creds.update', () => {
      if (this.entry !== entry) return;
      void saveCreds().catch(() => undefined);
    });

    sock.ev.on('connection.update', (update) => {
      if (this.entry !== entry) return;
      this.hooks.onVendorEvent?.('connection.update', update);
      if (update.qr != null && update.qr !== '') {
        this.currentQr = update.qr;
        this.hooks.onQr(update.qr);
      }
      if (update.connection === 'open') {
        entry.connected = true;
        this.currentQr = null;
        this.currentPhone = phoneOf(entry.sock.user?.id);
        this.currentUser =
          displayNameOf(entry.sock.user) ?? displayNameOf(entry.sock.authState.creds.me);
        this.hooks.onConnected(this.currentPhone, this.currentUser);
        return;
      }
      if (update.connection !== 'close') return;
      const reason = mapDisconnect(update.lastDisconnect?.error);
      entry.connected = false;
      this.entry = null;
      this.currentQr = null;
      if (this.manualClose) {
        this.manualClose = false;
        return;
      }
      this.hooks.onDisconnected(reason);
    });

    sock.ev.on('messages.upsert', (upsert) => {
      if (this.entry !== entry) return;
      logJson('incoming', 'websocket', 'whatsapp.messages.upsert', {
        connectionId: this.id,
        type: upsert.type,
        messages: upsert.messages,
      });
      this.hooks.onVendorEvent?.('messages.upsert', upsert, singleSenderId(upsert.messages));
      if (upsert.type !== 'notify') return;
      // Decrypting is async and can be slow, so the batch is handled off the
      // socket callback; each message keeps its own try/catch below.
      void this.forwardUpsert(entry, upsert);
    });
  }

  /**
   * Decrypts any media and forwards one upsert batch to the hooks.
   *
   * Media is decrypted in arrival order so the frame budget is deterministic: a
   * batch is one frame, and the server's payload limit applies to the frame
   * rather than to each file. A message that does not fit the budget — or whose
   * blob cannot be decrypted — ships without a block, and the cloud skips it
   * exactly as it did before.
   */
  private async forwardUpsert(
    entry: SocketEntry,
    upsert: BaileysEventMap['messages.upsert'],
  ): Promise<void> {
    let mediaBudget = COMPANION_FRAME_MEDIA_BUDGET_BYTES;
    for (const msg of upsert.messages) {
      if (this.entry !== entry) return;
      try {
        if (msg.key?.fromMe === true) continue;
        const remote = msg.key?.remoteJid ?? '';
        if (remote === 'status@broadcast') continue;
        const id = msg.key?.id ?? '';
        if (id === '') {
          console.error('[companion][websocket][unexpected] WhatsApp message has no id', msg);
          continue;
        }
        if (this.seen.has(id)) continue;
        this.seen.add(id);
        if (this.seen.size > DEDUPE_MAX) {
          const first = this.seen.values().next().value;
          if (first != null) this.seen.delete(first);
        }
        const text = unwrapConversation(msg);
        const type = messageType(msg);
        const from = senderPhoneFromKey(msg.key) ?? '';
        const to = this.currentPhone ?? '';
        const timestamp = Number(msg.messageTimestamp ?? 0) * 1000;
        if (type === 'unknown') {
          console.error('[companion][websocket][unexpected] Unsupported WhatsApp message', {
            id,
            keys: Object.keys((msg.message as Record<string, unknown> | null) ?? {}),
          });
        }
        if (MEDIA_KINDS.has(type)) {
          const mimetype = mediaMimetype(msg);
          const vendorUrl = inboundMediaUrl(msg);
          const cache = this.hooks.mediaCache;
          const declared = declaredMediaSha(msg) ?? cache?.shaForUrl(vendorUrl) ?? null;
          const cached =
            cache == null
              ? null
              : await cachedCompanionMedia({
                  cache,
                  kind: type,
                  sha256: declared,
                  remaining: mediaBudget,
                  ...(mimetype == null ? {} : { mimetype }),
                  ...(this.hooks.uploadMedia == null ? {} : { upload: this.hooks.uploadMedia }),
                });
          const plan =
            cached ??
            (await attachCompanionMedia({
              kind: type,
              declaredLength: declaredMediaLength(msg),
              remaining: mediaBudget,
              ...(mimetype == null ? {} : { mimetype }),
              decrypt: () => downloadMediaBytes(entry.sock, msg),
              ...(this.hooks.uploadMedia == null ? {} : { upload: this.hooks.uploadMedia }),
            }));
          mediaBudget = plan.remaining;
          if (plan.block != null) {
            (msg as unknown as Record<string, unknown>)['media'] = plan.block;
          }
          // Only a download teaches the cache anything; a hit has nothing to add.
          if (cache != null && cached == null) {
            this.rememberInboundMedia(cache, {
              declared,
              vendorUrl,
              kind: type,
              mimetype,
              plan,
              submessage: resendableMediaProto(msg),
              waExpiresAt: inboundProtoExpiry(msg),
            });
          }
        }
        const inbound = {
          id,
          from,
          to,
          ...(text == null ? {} : { text }),
          type,
          timestamp,
          raw: msg,
        };
        if (this.hooks.onInboundMessage != null) {
          this.hooks.onInboundMessage(inbound);
        } else if (text != null) {
          this.hooks.onInboundText({ ...inbound, text });
        }
      } catch (error) {
        console.error('[companion][websocket][error] Failed to process WhatsApp message', error);
      }
    }
  }

  /**
   * Caches what an inbound media download taught us: the plaintext, every url
   * that points at it, and the received proto that lets it be re-sent as-is.
   *
   * The digest is recomputed from the bytes whenever both are in hand, because a
   * wrong declared digest is not a cosmetic problem — it would key the entry
   * another file's bytes are served from. So the bytes win, and a disagreement is
   * only logged.
   *
   * The two urls are kept apart on purpose: a vendor url is encrypted and can
   * never be handed to the cloud, while a stored url is exactly what the cloud
   * wants. Recording the vendor url still pays, because the next copy of the same
   * media can be recognised by url alone when the client declares no digest.
   */
  private rememberInboundMedia(
    cache: SessionMediaCache,
    input: {
      declared: string | null;
      vendorUrl: string;
      kind: string;
      mimetype?: string;
      plan: CompanionMediaPlan;
      /** The received proto, when it still resolves to a live WhatsApp blob. */
      submessage?: Record<string, unknown> | null;
      /** When WhatsApp stops serving that blob, or null when it declared none. */
      waExpiresAt?: number | null;
    },
  ): void {
    const plaintext = input.plan.plaintext;
    if (plaintext == null) return;
    const computed = sha256Base64Url(plaintext);
    if (input.declared != null && input.declared !== computed) {
      console.warn('[companion][media] inbound sha256 mismatch', {
        declaredSha256: input.declared,
        computedSha256: computed,
        kind: input.kind,
      });
    }
    cache.putBytes({
      sha256: computed,
      bytes: plaintext,
      source: 'in',
      ...(input.mimetype == null ? {} : { mime: input.mimetype }),
    });
    if (input.vendorUrl !== '') {
      cache.rememberUrl({ url: input.vendorUrl, sha256: computed, role: 'vendor', kind: input.kind });
    }
    const stored = input.plan.block?.url;
    if (stored != null && stored !== '') {
      cache.rememberUrl({ url: stored, sha256: computed, role: 'stored', kind: input.kind });
      // The reply's url and this one are the same object (content-addressed), so
      // the stored url is what makes a later `{ image: { url } }` from the cloud
      // resolve back to this digest.
    }
    // Stored last, on the row `putBytes` just wrote, so the row keeps its `in`
    // source and the blob name it already decided.
    this.rememberInboundProto(cache, computed, input);
  }

  /**
   * Keeps the received proto, which is what WhatsApp will accept again.
   *
   * This is the whole point of the cache on the inbound side: a reply naming this
   * digest can then reference the blob WhatsApp already holds, costing neither a
   * download nor an upload. A proto that declared no expiry is still stored — it
   * is genuinely reusable — and `getProto` applies its own conservative TTL.
   */
  private rememberInboundProto(
    cache: SessionMediaCache,
    computed: string,
    input: { kind: string; submessage?: Record<string, unknown> | null; waExpiresAt?: number | null },
  ): void {
    const submessage = input.submessage;
    if (submessage == null) return;
    const encoded = encodeMediaProto(input.kind, submessage);
    if (encoded == null) return;
    const waExpiresAt = input.waExpiresAt ?? null;
    cache.putProto(computed, encoded, { waExpiresAt });
    logJson('incoming', 'websocket', 'media proto cached for reuse', {
      kind: input.kind,
      sha256: computed,
      length: encoded.byteLength,
      expiresAt: waExpiresAt,
    });
  }
}

export const baileysFactory: ChannelFactory = {
  create(id, authFolder, hooks) {
    return new BaileysSession(id, authFolder, hooks);
  },
};
