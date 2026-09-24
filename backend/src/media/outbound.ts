/**
 * @fileoverview Outbound media resolution — how a cloud `sendMessage` reuses
 * what the cache already holds.
 *
 * Baileys turns `{ image: { url } }` into an encrypted upload: it downloads the
 * url, encrypts, and PUTs to WhatsApp. Both halves are avoidable once the bytes
 * or the accepted proto are local, and this module picks the cheapest of the
 * three ways to get there without ever breaking the send:
 *
 * - **proto hit** — WhatsApp already accepted this content under a url we know,
 *   so the content is handed back untouched and Baileys' own `mediaCache` answers
 *   with the stored proto: no download, no upload.
 * - **local bytes** — the plaintext is on disk (it arrived inbound, or an earlier
 *   send fetched it), so the media is pointed at that file. Baileys reads it from
 *   disk instead of the network and uploads once, and the upload's proto is
 *   captured for next time.
 * - **pass-through** — nothing is known and the bytes cannot be pulled in
 *   (oversized, non-http, fetch failed). The original content is returned
 *   unchanged, so the send behaves exactly as it did before the cache existed.
 */
import { logJson } from '../log';
import type { SessionMediaCache } from './cache';
import { normalizeSha256, sha256Base64Url } from './sha';

/**
 * Media children of a Baileys content object, in Baileys' own precedence order.
 * Baileys picks the *last* matching key, so the scan below does too.
 */
const MEDIA_KEYS = ['image', 'video', 'document', 'audio', 'sticker'] as const;

/** How large a file the cache will pull in to make the next send free. */
export const MEDIA_CACHE_MAX_FETCH_BYTES = 16 * 1024 * 1024;

/** A fetch that outlasts this is not worth blocking a send on. */
export const MEDIA_CACHE_FETCH_TIMEOUT_MS = 30_000;

export interface OutboundMediaOptions {
  /** The Baileys content object (`args[1]` of `sendMessage`). */
  content: unknown;
  cache: SessionMediaCache;
  /**
   * Bytes for a url, or null. Injected because the rule being tested is which
   * source wins, not whether `fetch` works.
   */
  fetchBytes: (url: string) => Promise<Uint8Array | null>;
  /** Absolute path of cached plaintext, for handing Baileys a file to read. */
  blobPath: (sha256: string) => string | null;
}

interface MediaEntry {
  /** Cache-key prefix Baileys uses, e.g. `image`. */
  kind: string;
  /** The content key it was found under, e.g. `image`. */
  key: string;
  inner: Record<string, unknown>;
  url: string;
}

/**
 * Rewrites one content object so Baileys reuses cached media, or returns it
 * unchanged when there is nothing to reuse.
 */
export async function resolveOutboundContent(options: OutboundMediaOptions): Promise<unknown> {
  const { content, cache, fetchBytes, blobPath } = options;
  const media = mediaEntry(content);
  if (media == null) return content;
  const { kind, key, inner, url } = media;

  const declared = normalizeSha256(inner['sha256']);
  let sha256 = declared ?? cache.shaForUrl(url);

  /**
   * Bytes pulled off the wire, at most once.
   *
   * Every digest that comes from the network is recomputed from those bytes
   * before it is used, so a wrong hint can never key one file's content under
   * another file's identity.
   */
  let fetched: Uint8Array | null = null;
  const fetchOnce = async (): Promise<Uint8Array | null> => {
    if (fetched != null || url === '') return fetched;
    fetched = await fetchBytes(url);
    return fetched;
  };

  if (sha256 == null) {
    // Nothing identifies this content yet, so the only way a repeat can be free
    // is to take the bytes now. Failing here is not an error: the content goes
    // out untouched and Baileys downloads it exactly as it did before.
    const bytes = await fetchOnce();
    if (bytes == null) return content;
    sha256 = sha256Base64Url(bytes);
  }

  if (cache.hasProto(sha256)) {
    rememberStoredUrl(cache, url, sha256, kind);
    logJson('outgoing', 'websocket', 'media cache proto reused', {
      connectionId: cache.connectionId,
      kind,
    });
    return content;
  }

  let bytes = cache.readBytes(sha256);
  if (bytes == null) {
    bytes = await fetchOnce();
    if (bytes == null) return content;
    const computed = sha256Base64Url(bytes);
    if (computed !== sha256) {
      warnOnIdentityMismatch(sha256, computed);
      sha256 = computed;
      if (cache.hasProto(sha256)) {
        rememberStoredUrl(cache, url, sha256, kind);
        return content;
      }
    }
    const mime = mimeOf(inner) ?? cache.mimeFor(sha256);
    cache.putBytes({ sha256, bytes, source: 'out', ...(mime != null ? { mime } : {}) });
  }

  rememberStoredUrl(cache, url, sha256, kind);
  const path = blobPath(sha256);
  if (path == null) return content;
  logJson('outgoing', 'websocket', 'media cache file reused', {
    connectionId: cache.connectionId,
    kind,
    length: bytes.byteLength,
  });
  return withLocalFile(content, key, inner, path, mimeOf(inner) ?? cache.mimeFor(sha256));
}

/**
 * Points a cloud url at a digest.
 *
 * The url came from the cloud, which serves it from its own bucket, so it is a
 * url the cloud can fetch again — the only kind worth handing back out later.
 * Written only once the digest is settled, so a hint that the bytes later
 * contradicted cannot leave a url pointing at the wrong content.
 */
function rememberStoredUrl(cache: SessionMediaCache, url: string, sha256: string, kind: string): void {
  if (url === '') return;
  cache.rememberUrl({ url, sha256, role: 'stored', kind });
}

/**
 * The media child of a content object, or null when there is none.
 *
 * Buffer / stream children are skipped: they are already local, and Baileys
 * needs no help with them. Skipping keeps the walk from mistaking binary for a
 * media descriptor with a url.
 */
function mediaEntry(content: unknown): MediaEntry | null {
  if (content == null || typeof content !== 'object' || Array.isArray(content)) return null;
  const rec = content as Record<string, unknown>;
  let found: MediaEntry | null = null;
  for (const kind of MEDIA_KEYS) {
    const inner = rec[kind];
    if (inner == null || typeof inner !== 'object' || Array.isArray(inner)) continue;
    if (inner instanceof Uint8Array) continue;
    const child = inner as Record<string, unknown>;
    const raw = child['url'];
    const url = typeof raw === 'string' ? raw.trim() : '';
    // Later keys win, matching Baileys' own scan over MEDIA_KEYS.
    found = { kind, key: kind, inner: child, url };
  }
  return found;
}

/** The declared mime of a media child, when it has one. */
function mimeOf(inner: Record<string, unknown>): string | undefined {
  const mime = inner['mimetype'];
  return typeof mime === 'string' && mime !== '' ? mime : undefined;
}

/**
 * Rebuilds the content with the media pointed at a local file.
 *
 * A plain filesystem path is a url `getStream` understands (`createReadStream`),
 * and unlike a Buffer it keeps Baileys' cache key populated — which is what lets
 * the upload's proto be captured for the next send. The caller's own fields ride
 * along, so a caption or a document name still lands, and the declared `sha256`
 * is dropped because only the bytes are authoritative.
 */
function withLocalFile(
  content: unknown,
  key: string,
  inner: Record<string, unknown>,
  path: string,
  mime: string | undefined,
): unknown {
  const next: Record<string, unknown> = { ...inner, url: path };
  delete next['sha256'];
  if (mime != null) next['mimetype'] = mime;
  return { ...(content as Record<string, unknown>), [key]: next };
}

/**
 * Warns when a digest disagreeing with the bytes was discarded.
 *
 * The computed value has already won; this only makes the bad hint visible, since
 * the value it carried would have keyed another file's cache entry.
 */
function warnOnIdentityMismatch(declared: string, computed: string): void {
  if (declared === computed) return;
  console.warn('[companion][media] outbound sha256 mismatch', {
    declaredSha256: declared,
    computedSha256: computed,
  });
}
