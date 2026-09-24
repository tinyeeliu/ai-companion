/**
 * @fileoverview MediaCacheStore — the Companion's local media cache.
 *
 * Phone sessions run on this laptop, so the same bytes cross it twice: inbound
 * WhatsApp media is decrypted from the CDN, and outbound cloud media is
 * downloaded from object storage and re-encrypted up to WhatsApp. A repeat send
 * should cost nothing, so plaintext is kept locally, addressed by its SHA-256.
 *
 * Two halves:
 * - `data/media/{sha256}.{ext}` — the plaintext bytes, content-addressed, so the
 *   same file stored twice is one file on disk.
 * - `data/media.sqlite` — the meta: length, mime, the WhatsApp proto an upload
 *   produced, and the urls that map onto the content (a url-only lookup is what
 *   lets a repeat of an unhashed url still hit).
 *
 * **A separate SQLite file from `messages.sqlite` on purpose.** That file holds
 * the durable delivery queue, whose rows must outlive an offline phone and are
 * not disposable; the cache is the opposite, so clearing it has to be one safe
 * operation (`rm -rf data/media data/media.sqlite`) that can never touch queued
 * messages. Two connections to one file would also add `SQLITE_BUSY` as a new
 * failure mode on a path that has none today.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { normalizeSha256 } from './sha';

/**
 * Disuse retires an object only after a year.
 *
 * A cached proto is worth keeping exactly as long as WhatsApp still serves the
 * blob it points at, so the object behind it must outlive the blob. The folder is
 * disposable and regenerable, so the caps below — not this — are what bound disk.
 */
export const MEDIA_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
/** How often the cache is swept. Media churns faster than chat history does. */
export const MEDIA_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** Hard ceiling on cached objects, evicted least-recently-used first. */
export const MEDIA_MAX_OBJECTS = 2_000;
/** Hard ceiling on cached plaintext, evicted least-recently-used first. */
export const MEDIA_MAX_BYTES = 512 * 1024 * 1024;
/**
 * How long a WhatsApp media proto stays reusable when it declared no expiry.
 *
 * The proto carries the CDN url WhatsApp minted for one upload, and those expire.
 * Past this the proto is dropped and the media is re-uploaded from local bytes —
 * which still costs no download.
 *
 * Only a fallback: a received proto carries the expiry WhatsApp itself declared,
 * and that is preferred. Deliberately shorter than `MEDIA_RETENTION_MS`, so the
 * fallback can still fire before the object ages out.
 */
export const MEDIA_PROTO_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * How long a stored (cloud-reachable) url may be handed out again.
 *
 * Uploads land under the bucket's `temp/` prefix, which is lifecycle-eligible,
 * so a url old enough to have been collected must not be reused or the cloud's
 * fetch fails. One hour matches the delivery queue's own horizon and still
 * covers the repeat-send case the cache exists for.
 */
export const MEDIA_STORED_URL_TTL_MS = 60 * 60 * 1000;

/** Eviction walk guard: a file bigger than the whole budget cannot be evicted. */
const EVICT_GUARD = 64;

/** Which side of the wire first stored the object. */
export type MediaSource = 'in' | 'out';

/**
 * What a url is good for. `vendor` is a WhatsApp CDN url — encrypted, so only
 * useful as a lookup key. `stored` is a cloud-reachable object url the cloud can
 * actually fetch, and it is the one worth handing back.
 */
export type MediaUrlRole = 'vendor' | 'stored';

export interface MediaObjectRow {
  connectionId: string;
  sha256: string;
  /** Plaintext byte count (`fileLength` on the vendor wire). */
  length: number;
  mime: string | null;
  /** Extension the blob file carries, e.g. `jpeg`. */
  ext: string | null;
  fileName: string | null;
  source: MediaSource;
  /** Blob file name inside `blobsDir`. Null when only meta was recorded. */
  blob: string | null;
  hasProto: boolean;
  /**
   * When WhatsApp stops serving the blob inside `proto`, or null when the proto
   * declared no expiry. Set alongside the proto, never on its own.
   */
  waExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
  hits: number;
}

export interface MediaUrlRow {
  url: string;
  connectionId: string;
  sha256: string;
  role: MediaUrlRole;
  kind: string | null;
  /** When this url was minted; a stored url past its TTL must not be reused. */
  urlAt: number;
  createdAt: number;
  lastUsedAt: number;
}

export interface MediaPutInput {
  connectionId: string;
  sha256: string;
  length: number;
  mime?: string;
  fileName?: string;
  source: MediaSource;
  /** Plaintext to write into the blob folder; omitted for a meta-only row. */
  bytes?: Uint8Array;
}

export interface MediaPruneResult {
  /** Rows dropped by age or by the size caps. */
  objects: number;
  /** Blob files removed because no row references them any more. */
  files: number;
  /** Protos dropped past their TTL, or with the object they belonged to. */
  protos: number;
}

/** Extensions for the mimes this path actually sees, so a blob reads sensibly. */
const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'application/pdf': 'pdf',
};

/** Mime → blob extension. Unknown subtypes keep their name minus punctuation. */
export function extensionForMime(mime: string | undefined): string {
  const lowered = (mime ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  const known = MIME_EXTENSIONS[lowered];
  if (known != null) return known;
  const slash = lowered.indexOf('/');
  const subtype = slash < 0 ? lowered : lowered.slice(slash + 1);
  const cleaned = subtype.replace(/[^a-z0-9]/g, '');
  return cleaned === '' ? 'bin' : cleaned;
}

/** Mime for a blob extension, for the cases that need a mime back from a row. */
export function mimeForExtension(ext: string | null | undefined): string | undefined {
  if (ext == null || ext === '') return undefined;
  for (const [mime, known] of Object.entries(MIME_EXTENSIONS)) {
    if (known === ext.toLowerCase()) return mime;
  }
  return undefined;
}

export function mediaPath(root: string): string {
  return join(root, 'media.sqlite');
}

export function mediaDir(root: string): string {
  return join(root, 'media');
}

const SELECT_OBJECT = `connection_id, sha256, length, mime, ext, file_name, source, blob,
                      proto IS NOT NULL AS has_proto, wa_expires_at,
                      created_at, updated_at, last_used_at, hits`;

interface ObjectRowShape {
  connection_id: string;
  sha256: string;
  length: number;
  mime: string | null;
  ext: string | null;
  file_name: string | null;
  source: string;
  blob: string | null;
  has_proto: number;
  wa_expires_at: number | null;
  created_at: number;
  updated_at: number;
  last_used_at: number;
  hits: number;
}

interface UrlRowShape {
  url: string;
  connection_id: string;
  sha256: string;
  role: string;
  kind: string | null;
  url_at: number;
  created_at: number;
  last_used_at: number;
}

function toObject(row: ObjectRowShape): MediaObjectRow {
  return {
    connectionId: row.connection_id,
    sha256: row.sha256,
    length: Number(row.length),
    mime: row.mime,
    ext: row.ext,
    fileName: row.file_name,
    source: row.source === 'out' ? 'out' : 'in',
    blob: row.blob,
    hasProto: row.has_proto === 1,
    waExpiresAt: row.wa_expires_at == null ? null : Number(row.wa_expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastUsedAt: Number(row.last_used_at),
    hits: Number(row.hits),
  };
}

function toUrl(row: UrlRowShape): MediaUrlRow {
  return {
    url: row.url,
    connectionId: row.connection_id,
    sha256: row.sha256,
    role: row.role === 'stored' ? 'stored' : 'vendor',
    kind: row.kind,
    urlAt: Number(row.url_at),
    createdAt: Number(row.created_at),
    lastUsedAt: Number(row.last_used_at),
  };
}

export class MediaCacheStore {
  private readonly db: Database;
  /**
   * `sha256 → blob file name`. The name is recorded in SQLite, but a read would
   * otherwise hit the database again for a value that never changes; this only
   * spares the round trip, never the source of truth.
   */
  private readonly blobNames = new Map<string, string>();

  constructor(
    readonly path: string,
    readonly blobsDir: string,
  ) {
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA foreign_keys = ON');
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    mkdirSync(blobsDir, { recursive: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS "MediaObject" (
        connection_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        length INTEGER NOT NULL DEFAULT 0,
        mime TEXT,
        ext TEXT,
        file_name TEXT,
        source TEXT NOT NULL DEFAULT 'in',
        blob TEXT,
        proto BLOB,
        proto_at INTEGER,
        wa_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (connection_id, sha256)
      );
      CREATE INDEX IF NOT EXISTS MediaObject_lru ON "MediaObject" (last_used_at);
      CREATE INDEX IF NOT EXISTS MediaObject_blob ON "MediaObject" (sha256, blob);

      CREATE TABLE IF NOT EXISTS "MediaUrl" (
        connection_id TEXT NOT NULL,
        url TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'vendor',
        kind TEXT,
        url_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        PRIMARY KEY (connection_id, url)
      );
      CREATE INDEX IF NOT EXISTS MediaUrl_sha ON "MediaUrl" (connection_id, sha256, role);
    `);
    this.migrate();
  }

  /** In-memory meta plus a throwaway blob folder, for tests. */
  static memory(blobsDir: string): MediaCacheStore {
    return new MediaCacheStore(':memory:', blobsDir);
  }

  /**
   * Adds columns an older `media.sqlite` predates.
   *
   * `CREATE TABLE IF NOT EXISTS` never alters an existing table, so a database
   * written before `wa_expires_at` existed would fail every query that selects it.
   * SQLite has no `ADD COLUMN IF NOT EXISTS`, so add only what `PRAGMA table_info`
   * says is missing — the same approach `messages.ts` uses for its queue columns.
   */
  private migrate(): void {
    const columns = new Set(
      (this.db.query(`PRAGMA table_info("MediaObject")`).all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    const additions: Array<[string, string]> = [['wa_expires_at', 'INTEGER']];
    for (const [name, definition] of additions) {
      if (columns.has(name)) continue;
      this.db.exec(`ALTER TABLE "MediaObject" ADD COLUMN ${name} ${definition}`);
    }
  }

  // ── objects ───────────────────────────────────────────────────────────────

  /**
   * Records one plaintext, writing the blob when bytes are supplied.
   *
   * The blob file name is decided once and then reused from any row that already
   * recorded one for this digest, so the same content never lands on disk twice
   * under two extensions — and a connection that has no row yet still resolves
   * the file a sibling connection wrote.
   */
  put(input: MediaPutInput): MediaObjectRow {
    const sha256 = normalizeSha256(input.sha256);
    if (sha256 == null) throw new Error('media cache requires a sha256 digest');
    const now = Date.now();
    const ext = extensionForMime(input.mime);
    const existing = this.blobName(sha256);
    const blob =
      existing ?? (input.bytes != null && input.bytes.byteLength > 0 ? `${sha256}.${ext}` : null);
    if (blob != null && input.bytes != null && input.bytes.byteLength > 0) {
      this.writeBlob(blob, input.bytes);
      this.blobNames.set(sha256, blob);
    }
    this.db
      .query(
        `INSERT INTO "MediaObject" (
           connection_id, sha256, length, mime, ext, file_name, source, blob,
           created_at, updated_at, last_used_at, hits
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(connection_id, sha256) DO UPDATE SET
           length = excluded.length,
           mime = COALESCE(excluded.mime, mime),
           ext = COALESCE(ext, excluded.ext),
           file_name = COALESCE(excluded.file_name, file_name),
           blob = COALESCE(excluded.blob, blob),
           source = excluded.source,
           updated_at = excluded.updated_at,
           last_used_at = excluded.last_used_at`,
      )
      .run(
        input.connectionId,
        sha256,
        input.length,
        input.mime ?? null,
        ext,
        input.fileName ?? null,
        input.source,
        blob,
        now,
        now,
        now,
      );
    return this.get(input.connectionId, sha256)!;
  }

  get(connectionId: string, sha256: unknown): MediaObjectRow | undefined {
    const normalized = normalizeSha256(sha256);
    if (normalized == null) return undefined;
    const row = this.db
      .query(`SELECT ${SELECT_OBJECT} FROM "MediaObject" WHERE connection_id = ? AND sha256 = ?`)
      .get(connectionId, normalized) as ObjectRowShape | null;
    return row == null ? undefined : toObject(row);
  }

  /** Plaintext for a digest, or null when this connection has no usable copy. */
  readBytes(connectionId: string, sha256: unknown): Uint8Array | null {
    const row = this.get(connectionId, sha256);
    if (row == null) return null;
    const name = row.blob ?? this.blobName(row.sha256);
    if (name == null) return null;
    return this.readBlob(name);
  }

  /** Counts a use, which is what the LRU eviction orders by. */
  touch(connectionId: string, sha256: unknown, now = Date.now()): void {
    const normalized = normalizeSha256(sha256);
    if (normalized == null) return;
    this.db
      .query(
        `UPDATE "MediaObject"
            SET last_used_at = ?, hits = hits + 1
          WHERE connection_id = ? AND sha256 = ?`,
      )
      .run(now, connectionId, normalized);
  }

  // ── protos ────────────────────────────────────────────────────────────────

  /**
   * Stores the encoded WhatsApp proto an upload produced, and when its blob dies.
   *
   * A row is created when the digest is new: the proto carries `fileLength` and
   * `mimetype`, so meta is known even when the bytes never came back through this
   * process — which is exactly the inbound case, where the bytes and this proto
   * arrive together and `putBytes` has already written the row.
   *
   * `waExpiresAt` is the CDN expiry the proto declared. Null means unknown, and
   * `getProto` then falls back to its own conservative TTL. A new proto replaces
   * the whole reference, so it replaces the expiry too.
   */
  putProto(
    connectionId: string,
    sha256: unknown,
    proto: Uint8Array,
    options: { waExpiresAt?: number | null; now?: number } = {},
  ): void {
    const normalized = normalizeSha256(sha256);
    if (normalized == null) return;
    const now = options.now ?? Date.now();
    const waExpiresAt = options.waExpiresAt ?? null;
    const existing = this.get(connectionId, normalized);
    if (existing == null) {
      this.db
        .query(
          `INSERT INTO "MediaObject" (
             connection_id, sha256, length, source, created_at, updated_at, last_used_at, hits
           ) VALUES (?, ?, 0, 'out', ?, ?, ?, 0)`,
        )
        .run(connectionId, normalized, now, now, now);
    }
    this.db
      .query(
        `UPDATE "MediaObject" SET proto = ?, proto_at = ?, wa_expires_at = ?, updated_at = ?
          WHERE connection_id = ? AND sha256 = ?`,
      )
      .run(proto, now, waExpiresAt, now, connectionId, normalized);
  }

  /**
   * The stored proto while it is still usable, or null.
   *
   * WhatsApp's own expiry wins when the proto declared one: past it the CDN stops
   * serving the blob, and reusing the proto would produce a message the recipient
   * cannot download. Without one, `MEDIA_PROTO_TTL_MS` remains the fallback.
   */
  getProto(connectionId: string, sha256: unknown, now = Date.now()): Uint8Array | null {
    const normalized = normalizeSha256(sha256);
    if (normalized == null) return null;
    const row = this.db
      .query(
        `SELECT proto, proto_at, wa_expires_at FROM "MediaObject"
          WHERE connection_id = ? AND sha256 = ?`,
      )
      .get(connectionId, normalized) as {
      proto: Uint8Array | null;
      proto_at: number | null;
      wa_expires_at: number | null;
    } | null;
    if (row?.proto == null || row.proto_at == null) return null;
    if (row.wa_expires_at != null) {
      return now < Number(row.wa_expires_at) ? row.proto : null;
    }
    if (now - Number(row.proto_at) > MEDIA_PROTO_TTL_MS) return null;
    return row.proto;
  }

  /**
   * When the blob behind a stored proto stops being served, or null when none is
   * stored or the proto declared no expiry. Reported, never enforced — `getProto`
   * is what gates reuse.
   */
  protoExpiry(connectionId: string, sha256: unknown): number | null {
    const normalized = normalizeSha256(sha256);
    if (normalized == null) return null;
    const row = this.db
      .query(`SELECT wa_expires_at FROM "MediaObject" WHERE connection_id = ? AND sha256 = ?`)
      .get(connectionId, normalized) as { wa_expires_at: number | null } | null;
    return row?.wa_expires_at == null ? null : Number(row.wa_expires_at);
  }

  clearProto(connectionId: string, sha256: unknown): void {
    const normalized = normalizeSha256(sha256);
    if (normalized == null) return;
    this.db
      .query(
        `UPDATE "MediaObject" SET proto = NULL, proto_at = NULL, wa_expires_at = NULL
          WHERE connection_id = ? AND sha256 = ?`,
      )
      .run(connectionId, normalized);
  }

  // ── urls ──────────────────────────────────────────────────────────────────

  /** Points a url at a digest, which is what makes a url-only repeat a hit. */
  rememberUrl(input: {
    connectionId: string;
    url: string;
    sha256: unknown;
    role: MediaUrlRole;
    kind?: string;
    urlAt?: number;
    now?: number;
  }): void {
    const sha256 = normalizeSha256(input.sha256);
    const url = input.url.trim();
    if (sha256 == null || url === '') return;
    const now = input.now ?? Date.now();
    this.db
      .query(
        `INSERT INTO "MediaUrl" (
           connection_id, url, sha256, role, kind, url_at, created_at, last_used_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(connection_id, url) DO UPDATE SET
           sha256 = excluded.sha256,
           role = excluded.role,
           kind = COALESCE(excluded.kind, kind),
           url_at = excluded.url_at,
           last_used_at = excluded.last_used_at`,
      )
      .run(
        input.connectionId,
        url,
        sha256,
        input.role,
        input.kind ?? null,
        input.urlAt ?? now,
        now,
        now,
      );
  }

  findUrl(connectionId: string, url: string): MediaUrlRow | undefined {
    const trimmed = url.trim();
    if (trimmed === '') return undefined;
    const row = this.db
      .query(`SELECT * FROM "MediaUrl" WHERE connection_id = ? AND url = ?`)
      .get(connectionId, trimmed) as UrlRowShape | null;
    return row == null ? undefined : toUrl(row);
  }

  /** The digest a url is known to carry, or null when the url is unseen. */
  shaForUrl(connectionId: string, url: string): string | null {
    return this.findUrl(connectionId, url)?.sha256 ?? null;
  }

  /**
   * A cloud-reachable url for a digest that is still inside its TTL, preferring
   * the newest. A stale one is reported as "none" rather than handed out, since
   * the bucket may already have collected the object.
   */
  storedUrl(connectionId: string, sha256: unknown, now = Date.now()): string | null {
    const normalized = normalizeSha256(sha256);
    if (normalized == null) return null;
    const rows = this.db
      .query(
        `SELECT url, url_at FROM "MediaUrl"
          WHERE connection_id = ? AND sha256 = ? AND role = 'stored'
          ORDER BY url_at DESC`,
      )
      .all(connectionId, normalized) as Array<{ url: string; url_at: number }>;
    for (const row of rows) {
      if (now - Number(row.url_at) <= MEDIA_STORED_URL_TTL_MS) return row.url;
    }
    return null;
  }

  listUrls(connectionId: string, sha256: unknown): MediaUrlRow[] {
    const normalized = normalizeSha256(sha256);
    if (normalized == null) return [];
    const rows = this.db
      .query(
        `SELECT * FROM "MediaUrl" WHERE connection_id = ? AND sha256 = ? ORDER BY url_at DESC`,
      )
      .all(connectionId, normalized) as UrlRowShape[];
    return rows.map(toUrl);
  }

  // ── maintenance ───────────────────────────────────────────────────────────

  /**
   * Retires what has aged out, then evicts least-recently-used until both caps
   * hold, drops url rows whose object is gone, and unlinks blobs nothing points
   * at. Returns what was removed so the caller can log it.
   */
  prune(now = Date.now()): MediaPruneResult {
    let objects = Number(
      this.db.query(`DELETE FROM "MediaObject" WHERE last_used_at < ?`).run(now - MEDIA_RETENTION_MS)
        .changes,
    );
    // A proto is retired when its own WhatsApp expiry passes, or — for one that
    // declared none — when the conservative fallback TTL does.
    const protos = Number(
      this.db
        .query(
          `UPDATE "MediaObject" SET proto = NULL, proto_at = NULL, wa_expires_at = NULL
            WHERE proto_at IS NOT NULL
              AND ((wa_expires_at IS NOT NULL AND wa_expires_at <= ?)
                OR (wa_expires_at IS NULL AND proto_at < ?))`,
        )
        .run(now, now - MEDIA_PROTO_TTL_MS).changes,
    );

    const overCount = this.objectCount() - MEDIA_MAX_OBJECTS;
    if (overCount > 0) objects += this.evict(overCount);
    // The byte ceiling is walked one object at a time rather than estimated: a
    // single file larger than the whole budget must not spin the loop, so the
    // guard also stops an eviction that cannot change anything.
    for (let guard = 0; guard < EVICT_GUARD; guard += 1) {
      if (this.totalBytes() <= MEDIA_MAX_BYTES) break;
      const evicted = this.evict(1);
      if (evicted === 0) break;
      objects += evicted;
    }

    this.db.exec(
      `DELETE FROM "MediaUrl" WHERE NOT EXISTS (
         SELECT 1 FROM "MediaObject" m
          WHERE m.connection_id = "MediaUrl".connection_id AND m.sha256 = "MediaUrl".sha256
       )`,
    );
    const files = this.removeOrphanBlobs();
    return { objects, files, protos };
  }

  /** Drops every row for one connection and unlinks blobs nothing else uses. */
  deleteForConnection(connectionId: string): number {
    const removed = this.db
      .query(`DELETE FROM "MediaObject" WHERE connection_id = ?`)
      .run(connectionId);
    this.db.query(`DELETE FROM "MediaUrl" WHERE connection_id = ?`).run(connectionId);
    this.removeOrphanBlobs();
    return Number(removed.changes);
  }

  close(): void {
    this.db.close();
  }

  // ── blobs ─────────────────────────────────────────────────────────────────

  /**
   * The blob file name recorded for a digest by any connection, if one exists.
   * Off the in-memory map when possible; the database query is the fallback, not
   * the fast path.
   */
  private blobName(sha256: string): string | null {
    const cached = this.blobNames.get(sha256);
    if (cached != null && existsSync(join(this.blobsDir, cached))) return cached;
    const row = this.db
      .query(
        `SELECT blob FROM "MediaObject"
          WHERE sha256 = ? AND blob IS NOT NULL
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(sha256) as { blob: string | null } | null;
    const name = row?.blob ?? null;
    if (name != null && existsSync(join(this.blobsDir, name))) {
      this.blobNames.set(sha256, name);
      return name;
    }
    return null;
  }

  /** Absolute path of the blob recorded for a digest, or null when none is. */
  blobPathFor(sha256: unknown): string | null {
    const normalized = normalizeSha256(sha256);
    if (normalized == null) return null;
    const name = this.blobName(normalized);
    return name == null ? null : join(this.blobsDir, name);
  }

  private writeBlob(name: string, bytes: Uint8Array): void {
    const target = join(this.blobsDir, name);
    if (existsSync(target)) return;
    try {
      writeFileSync(target, bytes);
    } catch (error) {
      console.warn('[companion][media] blob write failed', name, error);
    }
  }

  private readBlob(name: string): Uint8Array | null {
    try {
      const target = join(this.blobsDir, name);
      if (!existsSync(target)) return null;
      return new Uint8Array(readFileSync(target));
    } catch (error) {
      console.warn('[companion][media] blob read failed', name, error);
      return null;
    }
  }

  /** Least-recently-used eviction; returns how many rows were dropped. */
  private evict(limit: number): number {
    if (limit <= 0) return 0;
    const result = this.db
      .query(
        `DELETE FROM "MediaObject" WHERE rowid IN (
           SELECT rowid FROM "MediaObject" ORDER BY last_used_at ASC LIMIT ?
         )`,
      )
      .run(limit);
    return Number(result.changes);
  }

  private objectCount(): number {
    const row = this.db.query(`SELECT COUNT(*) AS n FROM "MediaObject"`).get() as { n: number };
    return Number(row.n);
  }

  private totalBytes(): number {
    const row = this.db
      .query(`SELECT COALESCE(SUM(length), 0) AS bytes FROM "MediaObject"`)
      .get() as { bytes: number };
    return Number(row.bytes);
  }

  /** Unlinks any blob in the folder that no row references any more. */
  private removeOrphanBlobs(): number {
    let names: string[];
    try {
      names = readdirSync(this.blobsDir);
    } catch {
      return 0;
    }
    if (names.length === 0) return 0;
    const keep = new Set(
      (
        this.db.query(`SELECT DISTINCT blob FROM "MediaObject" WHERE blob IS NOT NULL`).all() as Array<{
          blob: string;
        }>
      ).map((row) => row.blob),
    );
    let removed = 0;
    for (const name of names) {
      if (keep.has(name)) continue;
      try {
        unlinkSync(join(this.blobsDir, name));
        removed += 1;
      } catch {
        /* already gone, or locked by a concurrent read */
      }
    }
    for (const [sha, name] of this.blobNames) {
      if (!keep.has(name)) this.blobNames.delete(sha);
    }
    return removed;
  }
}
