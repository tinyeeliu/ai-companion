/**
 * @fileoverview Talks to the resident mlx-audio process on Apple Silicon.
 *
 * The process stays up and holds one Kokoro checkpoint. stdin commands are
 * JSON lines; stdout replies are JSON lines. A dead process is started again
 * on the next command.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError } from '../types';
import { configTtsModel } from '../token';
import { TtsFailedError, TtsTimeoutError, TTS_TIMEOUT_MS } from './engine';
import { modelForKokoroVoice } from './catalog';
import { mlxModelReady, pythonBin, workerEnv } from './layout';
import { parseTtsModel, speechLang, type TtsModelId } from './models';
import type { SpeechJob } from './parse';
import type { SpeechResult, SpeechRunner } from './queue';
import { wavToPcm } from './wav';

const LOAD_TIMEOUT_MS = 10 * 60 * 1000;

export interface WorkerReply {
  ok?: boolean;
  error?: string;
  progress?: boolean;
  received?: number;
  total?: number;
}

export function workerScriptPath(): string {
  return join(import.meta.dir, 'mlx_worker.py');
}

export class MlxSession {
  private readonly root: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private loaded: TtsModelId | null = null;
  private waiters: ((reply: WorkerReply) => void)[] = [];

  constructor(root: string) {
    this.root = root;
  }

  runner(): SpeechRunner {
    return {
      run: (job) => this.speak(job),
    };
  }

  load(model: TtsModelId): Promise<void> {
    return this.enqueue(async () => {
      await this.ensure();
      if (this.loaded === model) return;
      await this.request({ cmd: 'load', model }, LOAD_TIMEOUT_MS);
      this.loaded = model;
    });
  }

  unload(): Promise<void> {
    return this.enqueue(async () => {
      if (this.child == null) {
        this.loaded = null;
        return;
      }
      await this.request({ cmd: 'unload' }, TTS_TIMEOUT_MS);
      this.loaded = null;
    });
  }

  private async speak(job: SpeechJob): Promise<SpeechResult> {
    return this.enqueue(async () => {
      const selected = parseTtsModel(configTtsModel(this.root)) ?? 'en';
      const model = (await modelForKokoroVoice(this.root, job.voice.id)) ?? selected;
      if (!mlxModelReady(this.root, model)) {
        throw new HttpError(503, 'TTS_NOT_READY', 'Speech model is not downloaded');
      }
      if (this.loaded !== model) {
        await this.ensure();
        await this.request({ cmd: 'load', model }, LOAD_TIMEOUT_MS);
        this.loaded = model;
      }
      const dir = await mkdtemp(join(tmpdir(), 'companion-tts-'));
      const outputPath = join(dir, 'speech.wav');
      try {
        const reply = await this.request({
          cmd: 'speak',
          text: job.input,
          voice: job.voice.id,
          speed: job.speed,
          lang: speechLang(model, job.voice.id),
          output: outputPath,
        }, TTS_TIMEOUT_MS);
        if (reply.ok !== true) {
          throw new TtsFailedError(reply.error ?? 'mlx-audio failed');
        }
        let wav: Uint8Array;
        try {
          wav = new Uint8Array(await readFile(outputPath));
        } catch {
          throw new TtsFailedError('mlx-audio wrote no audio');
        }
        if (job.format === 'pcm') {
          return { audio: wavToPcm(wav), contentType: 'audio/pcm' };
        }
        return { audio: wav, contentType: 'audio/wav' };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async ensure(): Promise<void> {
    if (this.child != null && this.child.exitCode == null && !this.child.killed) return;
    const bin = pythonBin(this.root);
    const child = spawn(bin, [workerScriptPath()], {
      env: workerEnv(this.root),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.loaded = null;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let reply: WorkerReply;
      try {
        reply = JSON.parse(line) as WorkerReply;
      } catch {
        reply = { ok: false, error: line };
      }
      const waiter = this.waiters.shift();
      waiter?.(reply);
    });
    child.stderr.on('data', () => {
      // Library logs. The protocol lives on stdout.
    });
    child.on('close', () => {
      if (this.child === child) this.child = null;
      this.loaded = null;
      const pending = this.waiters.splice(0);
      for (const waiter of pending) waiter({ ok: false, error: 'speech process exited' });
    });
  }

  private request(cmd: Record<string, unknown>, timeoutMs: number): Promise<WorkerReply> {
    const child = this.child;
    if (child == null) return Promise.reject(new TtsFailedError('speech process is not running'));
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const onReply = (reply: WorkerReply) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (reply.ok === false) {
          const message = reply.error ?? 'mlx-audio failed';
          if (message.includes('not found') || message.includes('Voice')) {
            reject(new HttpError(400, 'INVALID_PARAM', message));
            return;
          }
          reject(new TtsFailedError(message));
          return;
        }
        resolve(reply);
      };
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const index = this.waiters.indexOf(onReply);
        if (index >= 0) this.waiters.splice(index, 1);
        child.kill('SIGKILL');
        reject(new TtsTimeoutError(timeoutMs));
      }, timeoutMs);
      this.waiters.push(onReply);
      child.stdin.write(`${JSON.stringify(cmd)}\n`);
    });
  }
}

/** One-shot download of a checkpoint into the Hugging Face cache. */
export function downloadMlxModel(
  root: string,
  model: TtsModelId,
  onProgress: (received: number, total: number) => void,
): Promise<void> {
  const bin = pythonBin(root);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [workerScriptPath()], {
      env: workerEnv(root),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let failed: string | null = null;
    let done = false;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try {
        const reply = JSON.parse(line) as WorkerReply;
        if (reply.progress) {
          onProgress(reply.received ?? 0, reply.total ?? 0);
          return;
        }
        if (reply.ok === false) failed = reply.error ?? 'download failed';
        if (reply.ok === true) done = true;
      } catch {
        stderr += line;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (failed != null) reject(new Error(failed));
      else if (code === 0 && done) resolve();
      else reject(new Error(stderr.trim().split('\n').at(-1) || `download exited ${code}`));
    });
    child.stdin.end(`${JSON.stringify({ cmd: 'download', model })}\n`);
  });
}
