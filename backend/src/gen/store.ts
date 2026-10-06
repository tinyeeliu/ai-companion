/**
 * @fileoverview Persisted PNGs for `response_format: "url"`.
 *
 * Plain files, deliberately no SQLite — contrast with `media/store.ts`, which
 * needs a database for WhatsApp proto metadata and reverse url lookups. A
 * generated image has neither: the id in the url *is* the filename, and there is
 * nothing to reconcile. So the store is `data/gen/{id}.png` plus a prune, and
 * clearing it is one `rm -rf data/gen`.
 *
 * It is still a cache, not storage: the bytes are reproducible from the prompt
 * and seed, so pruning them by age and count is safe and self-limiting.
 */
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir } from '../paths';

/**
 * A generation is worth keeping about as long as a link to it plausibly lives.
 * Same horizon as the media cache's url TTL, so a url handed out cannot expire
 * sooner than the object behind it.
 */
export const GEN_RETENTION_MS = 24 * 60 * 60 * 1000;
/** How often the folder is swept. */
export const GEN_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** Hard ceiling on stored images, oldest evicted first. */
export const GEN_MAX_OBJECTS = 200;

export interface GenStore {
  save(png: Uint8Array): string;
  read(id: string): Uint8Array | null;
  has(id: string): boolean;
  prune(now?: number): void;
}

export function genStore(dir: string): GenStore {
  ensureDir(dir);

  return {
    save(png: Uint8Array): string {
      const id = Bun.randomUUIDv7();
      writeFileSync(join(dir, `${id}.png`), png);
      return id;
    },

    read(id: string): Uint8Array | null {
      const path = pathFor(dir, id);
      if (path == null) return null;
      try {
        return new Uint8Array(readFileSync(path));
      } catch {
        return null;
      }
    },

    has(id: string): boolean {
      const path = pathFor(dir, id);
      return path != null && existsSync(path);
    },

    prune(now = Date.now()): void {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      const live: Array<{ path: string; mtimeMs: number }> = [];
      for (const entry of entries) {
        const path = join(dir, entry);
        try {
          const stat = statSync(path);
          if (!stat.isFile()) continue;
          if (now - stat.mtimeMs > GEN_RETENTION_MS) {
            unlinkSync(path);
            continue;
          }
          live.push({ path, mtimeMs: stat.mtimeMs });
        } catch {
          // Raced with a delete; nothing to do.
        }
      }
      if (live.length <= GEN_MAX_OBJECTS) return;
      // Oldest first, so the cap evicts the least recently written.
      live.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const entry of live.slice(0, live.length - GEN_MAX_OBJECTS)) {
        try {
          unlinkSync(entry.path);
        } catch {
          // Best effort; the next sweep will try again.
        }
      }
    },
  };
}

/**
 * Reject anything that is not a bare uuid, so a crafted `:id` cannot walk out of
 * the folder with `..` or an absolute path.
 */
function pathFor(dir: string, id: string): string | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  return join(dir, `${id}.png`);
}