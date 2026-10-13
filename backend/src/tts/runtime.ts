/**
 * Wires the speech queue to the sherpa-onnx binary under `data/tts`.
 * The binary is resolved on each run, so a download that finishes while the
 * process is up is picked up by the next request without a restart.
 */
import { sherpaRunner } from './engine';
import { findEngineBinary, findMlxBinary, kokoroPaths, libraryDirs, mlxDir, mlxLibraryDirs, usesMlxEngine } from './layout';
import { mlxRunner } from './mlx';
import { TtsQueue } from './queue';
import { TtsSetup } from './setup';
import type { TtsRoutesOptions } from './index';

export function createSpeech(root: string): TtsRoutesOptions {
  const setup = new TtsSetup({ root });
  const queue = new TtsQueue(
    usesMlxEngine()
      ? mlxRunner(async () => {
        const bin = await findMlxBinary(root);
        if (bin == null) return null;
        return { bin, libDirs: await mlxLibraryDirs(root) };
      }, () => mlxDir(root))
      : sherpaRunner(async () => {
        const bin = await findEngineBinary(root);
        if (bin == null) return null;
        return { bin, libDirs: await libraryDirs(root) };
      }, () => kokoroPaths(root)),
  );
  return { queue, setup };
}
