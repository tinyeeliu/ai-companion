/**
 * Stream a URL to disk and keep it only when the SHA-256 matches.
 * The partial name is never the installed name, so a failed download cannot
 * be mistaken for the archive we meant to fetch.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';

export async function downloadVerified(
  url: string,
  partialPath: string,
  finalPath: string,
  expectedSha256: string,
  onProgress: (received: number) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(url);
  if (!res.ok || res.body == null) {
    throw new Error(`download failed (${res.status})`);
  }
  const hash = createHash('sha256');
  const out = createWriteStream(partialPath);
  const reader = res.body.getReader();
  try {
    let received = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const value = next.value;
      if (value == null) continue;
      hash.update(value);
      received += value.byteLength;
      onProgress(received);
      if (!out.write(value)) {
        await new Promise<void>((resolve) => {
          out.once('drain', () => resolve());
        });
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.once('error', reject);
      out.end(() => resolve());
    });
  } catch (error) {
    out.destroy();
    await rm(partialPath, { force: true });
    throw error;
  }
  if (hash.digest('hex') !== expectedSha256) {
    await rm(partialPath, { force: true });
    throw new Error('downloaded file did not match its checksum');
  }
  await rename(partialPath, finalPath);
}
