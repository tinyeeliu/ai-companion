/**
 * Wires the speech queue to the engine under `data/tts`.
 * Apple Silicon keeps one mlx-audio process. Windows spawns sherpa per request.
 * A download that finishes while the process is up is picked up by the next load.
 */
import { configTtsEnabled, configTtsModel } from '../token';
import { sherpaRunner } from './engine';
import { findEngineBinary, kokoroPaths, libraryDirs, mlxModelReady, pythonReady, usesMlxEngine } from './layout';
import { MlxSession } from './mlx';
import { TtsQueue } from './queue';
import { TtsSetup } from './setup';
import type { TtsRoutesOptions } from './index';

export function createSpeech(root: string): TtsRoutesOptions {
  if (usesMlxEngine()) {
    const session = new MlxSession(root);
    const setup = new TtsSetup({ root, session });
    const model = configTtsModel(root);
    if (configTtsEnabled(root) && pythonReady(root) && mlxModelReady(root, model)) {
      void session.load(model).catch((error: unknown) => {
        console.warn('[companion] speech load failed', error);
      });
    }
    return { queue: new TtsQueue(session.runner()), setup };
  }
  const setup = new TtsSetup({ root });
  const queue = new TtsQueue(
    sherpaRunner(async () => {
      const bin = await findEngineBinary(root);
      if (bin == null) return null;
      return { bin, libDirs: await libraryDirs(root) };
    }, () => kokoroPaths(root)),
  );
  return { queue, setup };
}
