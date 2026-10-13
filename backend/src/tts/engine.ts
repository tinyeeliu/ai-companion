/**
 * @fileoverview The only place that spawns `sherpa-onnx-offline-tts`.
 *
 * The binary is one-shot: it loads Kokoro, writes one wav, and exits. A missing
 * `--output-filename` makes it try to play audio, which a server has no device
 * for, so the path is always passed. The child is killed when it overruns,
 * because a wedged load would hold the single speech slot until restart.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpeechJob } from './parse';
import type { SpeechResult, SpeechRunner } from './queue';
import type { KokoroPaths } from './layout';
import { wavToPcm } from './wav';

export const TTS_TIMEOUT_MS = 2 * 60 * 1000;

export class TtsFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TtsFailedError';
  }
}

export class TtsTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`sherpa-onnx-offline-tts timed out after ${timeoutMs}ms`);
    this.name = 'TtsTimeoutError';
  }
}

export interface EngineLaunch {
  bin: string;
  /** Directories holding the dylibs or DLLs the binary was linked against. */
  libDirs: string[];
}

/** OpenAI speed 1 is natural. Kokoro's length scale is 1/speed, and larger means slower. */
export function kokoroLengthScale(speed: number): string {
  return (1 / speed).toFixed(4);
}

export function buildTtsArgs(paths: KokoroPaths, job: SpeechJob, outputPath: string): string[] {
  const english = job.voice.id.startsWith('bf_') || job.voice.id.startsWith('bm_')
    ? paths.lexiconGb
    : paths.lexiconUs;
  return [
    `--kokoro-model=${paths.model}`,
    `--kokoro-voices=${paths.voices}`,
    `--kokoro-tokens=${paths.tokens}`,
    `--kokoro-data-dir=${paths.espeak}`,
    `--kokoro-lexicon=${english},${paths.lexiconZh}`,
    `--sid=${job.voice.sid}`,
    // Kokoro's own scale is the inverse of OpenAI's speed: a larger scale is slower.
    `--kokoro-length-scale=${kokoroLengthScale(job.speed)}`,
    '--num-threads=2',
    `--output-filename=${outputPath}`,
    job.input,
  ];
}

/** Child env that can load the engine's shared libraries without a system install. */
export function engineEnv(libDirs: string[]): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const joined = libDirs.join(process.platform === 'win32' ? ';' : ':');
  if (joined === '') return env;
  if (process.platform === 'darwin') {
    env.DYLD_LIBRARY_PATH = joined;
    env.DYLD_FALLBACK_LIBRARY_PATH = joined;
  } else if (process.platform === 'win32') {
    env.PATH = `${joined};${env.PATH ?? ''}`;
  } else {
    env.LD_LIBRARY_PATH = joined;
  }
  return env;
}

export function sherpaRunner(
  launch: () => Promise<EngineLaunch | null>,
  paths: () => KokoroPaths,
): SpeechRunner {
  return {
    async run(job: SpeechJob): Promise<SpeechResult> {
      const engine = await launch();
      if (engine == null) throw new TtsFailedError('sherpa-onnx-offline-tts is not installed');
      const dir = await mkdtemp(join(tmpdir(), 'companion-tts-'));
      const outputPath = join(dir, 'speech.wav');
      const args = buildTtsArgs(paths(), job, outputPath);
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
          throw new TtsFailedError('sherpa-onnx-offline-tts wrote no audio');
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

export interface DeadlineOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runWithDeadline(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<DeadlineOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone; close still resolves.
      }
    }, timeoutMs);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => finish(() => resolve({ code, stdout, stderr, timedOut })));
  });
}
