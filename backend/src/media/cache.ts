/**
 * @fileoverview The media cache as one connection sees it.
 *
 * Two roles in one object:
 * - It is the `CacheStore` Baileys calls for `mediaCache`. On a `get` hit
 *   Baileys skips downloading and re-uploading the media entirely, and on the
 *   way out it hands us the proto the upload produced, which is the only thing
 *   that makes the next send free.
 * - It is the lookup the WhatsApp session uses for its own decisions: which
 *   digest a url carries, whether the plaintext is already local, and which
 *   cloud-reachable url may be handed out again.
 *
 * Everything is scoped to one connection so a url learned on one linked account
 * can never be handed to another. The blob folder underneath is shared, because
 * a file addressed by its own digest is the same file whoever fetched it.
 */
import { proto, type CacheStore } from '@whiskeysockets/baileys';
import { logJson } from '../log';
import { whatsappMediaExpiryMs } from './expiry';
import { normalizeSha256 } from './sha';
import type { MediaCacheStore, MediaObjectRow, MediaSource, MediaUrlRole } from './store';
import { mimeForExtension } from './store';

/** Media kinds the cache knows how to read a proto back from. */
export const PROTO_KEY_BY_KIND: Record<string, string> = {
  image: 'imageMessage',
  video: 'videoMessage',
  audio: 'audioMessage',
  document: 'documentMessage',
  sticker: 'stickerMessage',
};

/** The proto field a media kind's payload lives under, or null when unknown. */
export function protoKeyForKind(kind: string): string | null {
  return PROTO_KEY_BY_KIND[kind] ?? null;
}

/**
 * Wraps one media submessage in an encoded `proto.Message` — the exact shape
 * Baileys' `mediaCache` hands back on a hit.
 *
 * The submessage is taken from the received vendor proto, so the result is a
 * self-contained message whose body is layout-identical to what the socket sends:
 * a proto that still points at WhatsApp's blob and still carries its `mediaKey`
 * is what lets a reply reuse that blob instead of uploading a new one.
 */
export function encodeMediaProto(
  kind: string,
  submessage: Record<string, unknown>,
): Uint8Array | null {
  const key = PROTO_KEY_BY_KIND[kind];
  if (key == null) return null;
  try {
    return proto.Message.encode(proto.Message.fromObject({ [key]: submessage })).finish();
  } catch (error) {
    console.warn('[companion][media] proto encode failed', kind, error);
    return null;
  }
}

/** Splits Baileys' `{mediaType}:{url}` cache key. The url keeps its own colons. */
export function parseMediaCacheKey(key: string): { kind: string; url: string } | null {
  const colon = key.indexOf(':');
  if (colon <= 0) return null;
  const url = key.slice(colon + 1);
  if (url === '') return null;
  return { kind: key.slice(0, colon), url };
}

export function mediaCacheKey(kind: string, url: string): string {
  return `${kind}:${url}`;
}

/** Protobuf numbers arrive as `number`, a numeric string, or a Long. */
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

interface ProtoIdentity {
  sha256: string | null;
  length: number | null;
  mime: string | null;
  /** When the blob inside the proto dies, or null when it declared no expiry. */
  expiresAt: number | null;
}

const NO_IDENTITY: ProtoIdentity = { sha256: null, length: null, mime: null, expiresAt: null };

export class ConnectionMediaCache {
  constructor(
    private readonly store: MediaCacheStore,
    readonly connectionId: string,
  ) {}

  /** The `CacheStore` Baileys sees. */
  get baileys(): CacheStore {
    return {
      get: <T>(key: string) => this.cachedProto(key) as T | undefined,
      set: (key: string, value: unknown) => this.rememberProto(key, value),
      del: (key: string) => this.dropProto(key),
      flushAll: () => undefined,
      close: () => undefined,
    };
  }

  // ── Baileys CacheStore ────────────────────────────────────────────────────

  /**
   * The stored proto for a `{kind}:{url}` key, or undefined.
   *
   * Returning the proto is what makes a repeat send free: Baileys decodes it and
   * reuses the upload WhatsApp already accepted, then re-applies the caller's own
   * fields (so a new caption still lands). A key whose url is unknown, or whose
   * proto has aged past its TTL, is a miss and Baileys falls back to a real
   * download and upload.
   */
  cachedProto(key: string): Uint8Array | undefined {
    const parsed = parseMediaCacheKey(key);
    if (parsed == null) return undefined;
    const sha256 = this.store.shaForUrl(this.connectionId, parsed.url);
    if (sha256 == null) return undefined;
    const stored = this.store.getProto(this.connectionId, sha256);
    if (stored == null) return undefined;
    this.store.touch(this.connectionId, sha256);
    logJson('outgoing', 'websocket', 'media cache proto hit', {
      connectionId: this.connectionId,
      kind: parsed.kind,
    });
    return stored;
  }

  /**
   * Records the proto an upload produced, keyed by the digest inside it.
   *
   * The digest is read from the proto rather than from a url mapping, because the
   * proto is the authoritative record: WhatsApp stamped it with the `fileSha256`
   * of the exact plaintext it accepted. That also means this works for an upload
   * the cache never saw the bytes for.
   *
   * No url is remembered here: only the caller knows whether a url is a
   * cloud-reachable object or an encrypted vendor url, and guessing wrong would
   * be how an unreadable url gets handed out.
   */
  rememberProto(key: string, value: unknown): void {
    const parsed = parseMediaCacheKey(key);
    if (parsed == null) return;
    const bytes = asBytes(value);
    if (bytes == null) return;
    const identity = this.protoIdentity(parsed.kind, bytes);
    if (identity.sha256 == null) return;
    this.store.putProto(this.connectionId, identity.sha256, bytes, {
      waExpiresAt: identity.expiresAt,
    });
    const row = this.row(identity.sha256);
    if (row != null && (row.length <= 0 || row.mime == null)) {
      // Backfill the meta the proto knows, so a later bytes-only hit can still
      // declare the length and mime an upload needs.
      this.store.put({
        connectionId: this.connectionId,
        sha256: identity.sha256,
        length: identity.length ?? row.length,
        ...(identity.mime != null ? { mime: identity.mime } : {}),
        source: 'out',
      });
    }
    logJson('outgoing', 'websocket', 'media cache proto stored', {
      connectionId: this.connectionId,
      kind: parsed.kind,
      length: identity.length ?? null,
      expiresAt: identity.expiresAt ?? null,
    });
  }

  /**
   * Stores an already-encoded proto under a digest known from the bytes.
   *
   * The inbound path has the plaintext, so it knows the content digest without a
   * url mapping existing first — and the received proto is exactly what WhatsApp
   * will accept again. Storing it is what turns a later reply naming that digest
   * into a pure cache hit, with neither a download nor an upload.
   */
  putProto(
    sha256: unknown,
    protoBytes: Uint8Array,
    options: { waExpiresAt?: number | null } = {},
  ): void {
    const normalized = normalizeSha256(sha256);
    if (normalized == null || protoBytes.byteLength === 0) return;
    this.store.putProto(this.connectionId, normalized, protoBytes, options);
  }

  /** Drops the proto for a key. Bytes and urls are left alone. */
  dropProto(key: string): void {
    const parsed = parseMediaCacheKey(key);
    if (parsed == null) return;
    const sha256 = this.store.shaForUrl(this.connectionId, parsed.url);
    if (sha256 != null) this.store.clearProto(this.connectionId, sha256);
  }

  // ── session lookups ───────────────────────────────────────────────────────

  /** The digest a url is known to carry, or null. */
  shaForUrl(url: unknown): string | null {
    if (typeof url !== 'string' || url.trim() === '') return null;
    return this.store.shaForUrl(this.connectionId, url);
  }

  /** The meta row for a digest, or undefined. */
  row(sha256: unknown): MediaObjectRow | undefined {
    const normalized = normalizeSha256(sha256);
    return normalized == null ? undefined : this.store.get(this.connectionId, normalized);
  }

  /** Plaintext already on disk for a digest, or null. */
  readBytes(sha256: unknown): Uint8Array | null {
    const normalized = normalizeSha256(sha256);
    if (normalized == null) return null;
    const bytes = this.store.readBytes(this.connectionId, normalized);
    if (bytes != null) this.store.touch(this.connectionId, normalized);
    return bytes;
  }

  /** A cloud-reachable url for a digest that is still fresh, or null. */
  storedUrl(sha256: unknown): string | null {
    return this.store.storedUrl(this.connectionId, sha256);
  }

  /** True when a fresh proto is available, which makes a send free of both. */
  hasProto(sha256: unknown): boolean {
    return this.store.getProto(this.connectionId, sha256) != null;
  }

  /**
   * When the cached proto's blob stops being served, or null when none is cached
   * or the proto declared no expiry. Lets a caller decide whether reuse is still
   * worth attempting before it tries.
   */
  protoExpiry(sha256: unknown): number | null {
    return this.store.protoExpiry(this.connectionId, sha256);
  }

  /** Absolute path of the cached plaintext, for handing Baileys a local file. */
  blobPath(sha256: unknown): string | null {
    return this.store.blobPathFor(sha256);
  }

  /** Stores plaintext, keyed by its own digest. Returns the row, or null. */
  putBytes(input: {
    sha256: unknown;
    bytes: Uint8Array;
    mime?: string;
    fileName?: string;
    source: MediaSource;
  }): MediaObjectRow | null {
    const sha256 = normalizeSha256(input.sha256);
    if (sha256 == null || input.bytes.byteLength === 0) return null;
    return this.store.put({
      connectionId: this.connectionId,
      sha256,
      bytes: input.bytes,
      length: input.bytes.byteLength,
      ...(input.mime != null && input.mime !== '' ? { mime: input.mime } : {}),
      ...(input.fileName != null && input.fileName !== '' ? { fileName: input.fileName } : {}),
      source: input.source,
    });
  }

  /** Points a url at a digest. `role` says whether the cloud can fetch it. */
  rememberUrl(input: {
    url: string;
    sha256: unknown;
    role: MediaUrlRole;
    kind?: string;
    urlAt?: number;
  }): void {
    this.store.rememberUrl({
      connectionId: this.connectionId,
      url: input.url,
      sha256: input.sha256,
      role: input.role,
      ...(input.kind != null ? { kind: input.kind } : {}),
      ...(input.urlAt != null ? { urlAt: input.urlAt } : {}),
    });
  }

  /** Mime a caller should declare for a digest, from its row. */
  mimeFor(sha256: unknown): string | undefined {
    const row = this.row(sha256);
    if (row?.mime != null && row.mime !== '') return row.mime;
    return mimeForExtension(row?.ext);
  }

  /** Length a caller should declare for a digest, from its row. */
  lengthFor(sha256: unknown): number | undefined {
    const row = this.row(sha256);
    return row == null || row.length <= 0 ? undefined : row.length;
  }

  /** Drops every row this connection owns, leaving other connections intact. */
  forget(): number {
    return this.store.deleteForConnection(this.connectionId);
  }

  /**
   * The digest, length and mime inside an encoded WhatsApp proto.
   *
   * `fileSha256` is the plaintext digest WhatsApp itself computed, which is the
   * same quantity the rest of the system calls `sha256` once normalized.
   */
  private protoIdentity(kind: string, bytes: Uint8Array): ProtoIdentity {
    const key = PROTO_KEY_BY_KIND[kind];
    if (key == null) return NO_IDENTITY;
    try {
      const message = proto.Message.decode(bytes);
      const inner = (message as unknown as Record<string, unknown>)[key];
      if (inner == null || typeof inner !== 'object') return NO_IDENTITY;
      const rec = inner as Record<string, unknown>;
      const mime = rec['mimetype'];
      const url = rec['url'];
      return {
        sha256: normalizeSha256(rec['fileSha256']),
        length: protoNumber(rec['fileLength']),
        mime: typeof mime === 'string' && mime !== '' ? mime : null,
        // The proto's own url states the CDN expiry; `mediaKeyTimestamp` is the
        // fallback when it does not.
        expiresAt: whatsappMediaExpiryMs({
          url: typeof url === 'string' ? url : undefined,
          mediaKeyTimestamp: rec['mediaKeyTimestamp'],
        }),
      };
    } catch (error) {
      console.warn('[companion][media] proto decode failed', kind, error);
      return NO_IDENTITY;
    }
  }
}

/** A cache value as bytes, or null when it is not binary. */
function asBytes(value: unknown): Buffer | null {
  return value instanceof Uint8Array ? Buffer.from(value) : null;
}

/**
 * The slice of a connection's media cache a channel session may use.
 *
 * A channel holds this rather than the store, so it can only ever read and write
 * its own connection's rows and cannot prune the cache out from under a live
 * send.
 */
export type SessionMediaCache = Pick<
  ConnectionMediaCache,
  | 'connectionId'
  | 'baileys'
  | 'shaForUrl'
  | 'row'
  | 'readBytes'
  | 'storedUrl'
  | 'hasProto'
  | 'protoExpiry'
  | 'blobPath'
  | 'putBytes'
  | 'putProto'
  | 'rememberUrl'
  | 'mimeFor'
  | 'lengthFor'
  | 'forget'
>;
