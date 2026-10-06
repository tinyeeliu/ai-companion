/**
 * @fileoverview `draw-things-cli` adapter — the only place that spawns a
 * Draw Things process.
 *
 * The CLI is one-shot and synchronous: it loads weights, samples, writes a PNG,
 * and exits. Everything awkward about embedding it lives here, so the route and
 * the queue above can stay ordinary async code.
 *
 * Flags that are not optional, and why:
 * - `--output` — with no output path *and* no TTY the CLI writes no file and
 *   shows no preview, so a piped/server invocation would produce nothing at all.
 * - `--disable-preview` — live sampling preview is pure overhead off a TTY.
 * - `--offline` — never let a request silently start a multi-gigabyte download;
 *   models are ensured at boot instead, so a miss should fail fast here.
 *
 * There is no CLI-side timeout, so one is enforced here. On expiry the child is
 * killed: a wedged `generate` holds the single queue slot and, worse, holds the
 * machine's memory, so leaving it alive would stall every later request.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GenJob, GenResult, GenRunner } from './queue';

export const DEFAULT_CLI = 'draw-things-cli';

/**
 * Generous relative to a measured warm run (6 steps at 1024x1024 in ~83s on a
 * cold model load), because a first request pays the load cost and a busy
 * machine can stall a child for a long time without it being wedged.
 */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Non-zero exit from the CLI: the message is the useful part, not the code. */
export class GenFailedError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'GenFailedError';
  }
}

/** The child outlived its deadline and was killed. */
export class GenTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`draw-things-cli timed out after ${timeoutMs}ms`);
    this.name = 'GenTimeoutError';
  }
}

export interface DrawThingsOptions {
  /** Binary name or absolute path. */
  bin?: string;
  timeoutMs?: number;
  /**
   * Where PNGs are written before being read back. Defaults to a fresh
   * `mkdtemp` per call so a crash can never leave a half-written file where a
   * later run might find it.
   */
  workDir?: string;
  /** Extra args appended verbatim; last, so they can override the defaults. */
  extraArgs?: string[];
}

export interface DrawThings extends GenRunner {
  /** Resolve the model and download it if missing. Runs at boot, not per request. */
  ensureModel(model: string): Promise<void>;
  /** Model ids the catalog knows about, cached after the first call. */
  listModels(): Promise<string[]>;
  /** False when the binary is missing or not runnable on this machine. */
  available(): Promise<boolean>;
}

export function drawThingsRunner(options: DrawThingsOptions = {}): DrawThings {
  const bin = options.bin ?? process.env.COMPANION_DRAWTHINGS_BIN ?? DEFAULT_CLI;
  const envTimeout = Number(process.env.COMPANION_GEN_TIMEOUT_MS ?? '');
  const timeoutMs = options.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);
  let cachedModels: string[] | null = null;

  async function exec(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return await new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  }

  return {
    async available(): Promise<boolean> {
      try {
        const { code } = await exec(['--version']);
        return code === 0;
      } catch {
        return false;
      }
    },

    async listModels(): Promise<string[]> {
      if (cachedModels != null) return cachedModels;
      // `--offline` keeps this off the network; the catalog is cached on disk by
      // the CLI itself, and a cold cache still answers from the shipped list.
      const { code, stdout } = await exec(['models', 'list', '--offline']);
      if (code !== 0) return [];
      const models: string[] = [];
      for (const line of stdout.split('\n')) {
        // Fixed-width table: MODEL is the first column. Skip the header and rule.
        const first = line.trimStart().split(/\s{2,}/)[0];
        if (first == null || first === '' || first === 'MODEL') continue;
        if (first.startsWith('-')) continue;
        if (first === 'Models') continue;
        models.push(first);
      }
      cachedModels = models;
      return models;
    },

    async ensureModel(model: string): Promise<void> {
      const { code, stderr } = await exec(['models', 'ensure', '--model', model]);
      if (code !== 0) {
        throw new GenFailedError(firstLine(stderr) || `could not ensure model ${model}`, code);
      }
    },

    async run(job: GenJob): Promise<GenResult> {
      // A fresh directory per run: the CLI writes exactly the file named, and a
      // leftover from a killed run must never be mistaken for a fresh result.
      const dir = options.workDir != null ? options.workDir : await mkdtemp(join(tmpdir(), 'companion-gen-'));
      const outputPath = join(dir, `${Bun.randomUUIDv7()}.png`);
      const args = buildArgs(job, outputPath);
      try {
        const outcome = await runWithDeadline(bin, args, timeoutMs);
        if (outcome.timedOut) throw new GenTimeoutError(timeoutMs);
        if (outcome.code !== 0) {
          throw new GenFailedError(
            firstLine(outcome.stderr) || `draw-things-cli exited ${outcome.code}`,
            outcome.code,
          );
        }
        let png: Uint8Array;
        try {
          png = new Uint8Array(await readFile(outputPath));
        } catch {
          throw new GenFailedError('draw-things-cli wrote no output file', outcome.code);
        }
        return { png, durationMs: parseDurationMs(outcome.stdout) };
      } finally {
        if (options.workDir == null) {
          await rm(dir, { recursive: true, force: true });
        } else {
          await rm(outputPath, { force: true });
        }
      }
    },
  };
}

/**
 * `--output` and the non-TTY flags are mandatory (see the file header); the
 * rest are only passed when the caller resolved them.
 */
export function buildArgs(job: GenJob, outputPath: string): string[] {
  const args = ['generate', '--model', job.model, '--prompt', job.prompt, '--output', outputPath];
  if (job.width != null) args.push('--width', String(job.width));
  if (job.height != null) args.push('--height', String(job.height));
  if (job.steps != null) args.push('--steps', String(job.steps));
  args.push('--disable-preview', '--offline');
  return args;
}

interface DeadlineOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runWithDeadline(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<DeadlineOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    // Kill the whole group: the CLI spawns no children of its own today, but a
    // stray descendant holding the slot would outlive a plain `kill`.
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone; the close handler still resolves.
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

/** The CLI prints `Total generation time (including model loading): 83.21 s`. */
function parseDurationMs(stdout: string): number | undefined {
  const match = /Total generation time \(including model loading\):\s*([0-9.]+)\s*ms/i.exec(stdout);
  if (match?.[1] != null) return Math.round(Number(match[1]));
  const seconds = /Total generation time \(including model loading\):\s*([0-9.]+)\s*s/i.exec(stdout);
  if (seconds?.[1] != null) return Math.round(Number(seconds[1]) * 1000);
  return undefined;
}

/** CLI failures print a single `Error: ...` line; the rest is noise. */
function firstLine(stderr: string): string {
  for (const line of stderr.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return '';
}