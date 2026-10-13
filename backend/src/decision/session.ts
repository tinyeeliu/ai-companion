/**
 * @fileoverview Talks to the resident mlx-decision process on Apple Silicon.
 *
 * The process stays up and holds laya-multilingual. stdin commands are JSON
 * lines; stdout replies are JSON lines. A dead process is started again on
 * the next command.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { HttpError } from '../types';
import { pythonBin, workerEnv } from './layout';
import type { DecisionJob } from './parse';
import type { DecisionResult, DecisionRunner } from './queue';

export const DECISION_TIMEOUT_MS = 2 * 60 * 1000;
const LOAD_TIMEOUT_MS = 10 * 60 * 1000;

export class DecisionFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionFailedError';
  }
}

export class DecisionTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`mlx-decision timed out after ${timeoutMs}ms`);
    this.name = 'DecisionTimeoutError';
  }
}

export interface WorkerReply {
  ok?: boolean;
  error?: string;
  invalid?: boolean;
  progress?: boolean;
  received?: number;
  total?: number;
  body?: DecisionResult;
}

export interface DecisionEngine {
  load(): Promise<void>;
  unload(): Promise<void>;
  runner(): DecisionRunner;
}

export function workerScriptPath(): string {
  return join(import.meta.dir, 'worker.py');
}

export class DecisionSession implements DecisionEngine {
  private readonly root: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private waiters: ((reply: WorkerReply) => void)[] = [];

  constructor(root: string) {
    this.root = root;
  }

  runner(): DecisionRunner {
    return {
      run: (job) => this.decide(job),
    };
  }

  load(): Promise<void> {
    return this.enqueue(async () => {
      await this.ensure();
      if (this.loaded) return;
      await this.request({ cmd: 'load' }, LOAD_TIMEOUT_MS);
      this.loaded = true;
    });
  }

  unload(): Promise<void> {
    return this.enqueue(async () => {
      if (this.child == null) {
        this.loaded = false;
        return;
      }
      await this.request({ cmd: 'unload' }, DECISION_TIMEOUT_MS);
      this.loaded = false;
    });
  }

  stop(): void {
    this.child?.kill('SIGKILL');
    this.child = null;
    this.loaded = false;
  }

  private async decide(job: DecisionJob): Promise<DecisionResult> {
    return this.enqueue(async () => {
      if (!this.loaded) {
        await this.ensure();
        await this.request({ cmd: 'load' }, LOAD_TIMEOUT_MS);
        this.loaded = true;
      }
      const reply = await this.request({
        cmd: 'decide',
        state: job.state,
        questions: job.questions,
      }, DECISION_TIMEOUT_MS);
      const body = reply.body;
      if (body == null || typeof body !== 'object') {
        throw new DecisionFailedError('mlx-decision wrote no answer');
      }
      return body;
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
    this.loaded = false;
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
      this.loaded = false;
      const pending = this.waiters.splice(0);
      for (const waiter of pending) waiter({ ok: false, error: 'decision process exited' });
    });
  }

  private request(cmd: Record<string, unknown>, timeoutMs: number): Promise<WorkerReply> {
    const child = this.child;
    if (child == null) return Promise.reject(new DecisionFailedError('decision process is not running'));
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const onReply = (reply: WorkerReply) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (reply.ok === false) {
          const message = reply.error ?? 'mlx-decision failed';
          if (reply.invalid === true) {
            reject(new HttpError(400, 'INVALID_PARAM', message));
            return;
          }
          reject(new DecisionFailedError(message));
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
        reject(new DecisionTimeoutError(timeoutMs));
      }, timeoutMs);
      this.waiters.push(onReply);
      child.stdin.write(`${JSON.stringify(cmd)}\n`);
    });
  }
}

/** One-shot download of laya-multilingual into the Hugging Face cache. */
export function downloadDecisionModel(
  root: string,
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
    child.stdin.end(`${JSON.stringify({ cmd: 'download' })}\n`);
  });
}
