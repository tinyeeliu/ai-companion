/**
 * @fileoverview The only place that spawns `KokoroCLI` on Apple Silicon.
 *
 * The binary is one-shot: it loads the MLX weights, writes one wav, and exits.
 * `--speed` is OpenAI's speed (larger is faster). Sherpa's inverse length scale
 * does not apply. A voice with no `.npy` is a 400 rather than a download.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError } from '../types';
import { engineEnv, runWithDeadline, TtsFailedError, TtsTimeoutError, TTS_TIMEOUT_MS } from './engine';
import type { SpeechJob } from './parse';
import type { SpeechResult, SpeechRunner } from './queue';
import { wavToPcm } from './wav';

/** British voices use the British lexicon. Everything else is American English. */
export function mlxLangCode(voiceId: string): string {
  return voiceId.startsWith('bf_') || voiceId.startsWith('bm_') ? 'en-gb' : 'en-us';
}

export function buildMlxArgs(weightsDir: string, job: SpeechJob, outputPath: string): string[] {
  return [
    '--text', job.input,
    '--voice', job.voice.id,
    '--output', outputPath,
    '--weights-dir', weightsDir,
    '--backend', 'mlx',
    '--speed', String(job.speed),
    '--lang-code', mlxLangCode(job.voice.id),
  ];
}

export function mlxRunner(
  launch: () => Promise<{ bin: string; libDirs: string[] } | null>,
  weightsDir: () => string,
): SpeechRunner {
  return {
    async run(job: SpeechJob): Promise<SpeechResult> {
      const engine = await launch();
      if (engine == null) throw new TtsFailedError('KokoroCLI is not installed');
      const voiceFile = join(weightsDir(), 'voices', `${job.voice.id}.npy`);
      if (!existsSync(voiceFile)) {
        throw new HttpError(400, 'INVALID_PARAM', `voice ${job.voice.id} is not downloaded`);
      }
      const dir = await mkdtemp(join(tmpdir(), 'companion-tts-'));
      const outputPath = join(dir, 'speech.wav');
      const args = buildMlxArgs(weightsDir(), job, outputPath);
      try {
        const outcome = await runWithDeadline(engine.bin, args, engineEnv(engine.libDirs), TTS_TIMEOUT_MS);
        if (outcome.timedOut) throw new TtsTimeoutError(TTS_TIMEOUT_MS);
        if (outcome.code !== 0) {
          const detail = outcome.stderr.trim() || outcome.stdout.trim() || `exited ${outcome.code}`;
          throw new TtsFailedError(detail.split('\n').at(-1) ?? detail);
        }
        let wav: Uint8Array;
        try {
          wav = new Uint8Array(await readFile(outputPath));
        } catch {
          throw new TtsFailedError('KokoroCLI wrote no audio');
        }
        if (job.format === 'pcm') {
          return { audio: wavToPcm(wav), contentType: 'audio/pcm' };
        }
        return { audio: wav, contentType: 'audio/wav' };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
