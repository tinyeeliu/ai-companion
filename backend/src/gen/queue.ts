/**
 * @fileoverview Serial queue in front of the local `draw-things-cli`.
 *
 * Draw Things binds roughly all of the machine's GPU/unified memory to whatever
 * it is loading, and the CLI is a one-shot process: there is no daemon to ask
 * for a second concurrent run. Two `generate` processes at once means two
 * multi-gigabyte model loads racing for the same memory, so the failure mode is
 * a swap storm or an OOM kill, not a slow response. Every Draw Things operation
 * therefore runs one at a time, and this queue is the only thing allowed to
 * start one.
 *
 * Unlike the durable delivery queue in `cloud/queue.ts`, nothing here is
 * persisted. A generation is worthless once the caller disconnects — there is no
 * row to retry, no phone to reconnect — so the unit of work is a promise held in
 * memory, and a Companion restart legitimately drops it.
 *
 * The invariant is one child process alive at any moment, and it holds because
 * `drain()` awaits each job to completion before it looks at the next one. The
 * `draining` / `again` / `stopped` shape is borrowed from `MessageQueue` so that
 * work arriving mid-drain collapses into one extra pass instead of a backlog.
 */
import { logJson } from '../log';

/** One generation request, already validated and resolved to CLI-shaped values. */
export interface GenJob {
  prompt: string;
  model: string;
  /** Omitted means "let the model's recommended settings decide". */
  width?: number;
  height?: number;
  steps?: number;
}

/** Raw PNG bytes plus whatever the adapter learned while producing them. */
export interface GenResult {
  png: Uint8Array;
  /** Wall-clock milliseconds the CLI reported for this run, when it said. */
  durationMs?: number;
}

/**
 * The CLI boundary. Injectable so tests can drive the queue without spawning a
 * real 3 GB model, and so a future HTTP or gRPC backend is a drop-in.
 *
 * `run` allocates and cleans up its own output path: the queue decides *when* a
 * generation happens, the runner decides *where* the bytes land.
 */
export interface GenRunner {
  run(job: GenJob): Promise<GenResult>;
}

interface Waiter {
  id: string;
  job: GenJob;
  resolve: (result: GenResult) => void;
  reject: (error: unknown) => void;
}

export interface GenQueueStats {
  /** Jobs waiting behind the active one. */
  queued: number;
  /** A generation is in flight right now. */
  active: boolean;
}

/** Refuse new work once the backlog is this deep, so a caller learns early. */
export const GEN_MAX_PENDING = 8;

export class GenQueueFullError extends Error {
  constructor(readonly limit: number) {
    super(`Image generation queue is full (${limit} waiting)`);
    this.name = 'GenQueueFullError';
  }
}

export class GenQueue {
  private readonly runner: GenRunner;
  private readonly pending: Waiter[] = [];
  private draining = false;
  private again = false;
  private active = false;
  private stopped = false;
  private served = 0;

  constructor(runner: GenRunner) {
    this.runner = runner;
  }

  /**
   * Enqueue one generation and wait for its bytes.
   *
   * Rejects with {@link GenQueueFullError} rather than growing the backlog
   * without bound: a caller that can get an error immediately is far better off
   * than one that waits behind a dozen multi-minute video jobs.
   */
  submit(job: GenJob): Promise<GenResult> {
    if (this.stopped) {
      return Promise.reject(new Error('Image generation queue is stopped'));
    }
    if (this.pending.length >= GEN_MAX_PENDING) {
      return Promise.reject(new GenQueueFullError(GEN_MAX_PENDING));
    }
    return new Promise<GenResult>((resolve, reject) => {
      this.pending.push({ id: Bun.randomUUIDv7(), job, resolve, reject });
      this.kick();
    });
  }

  stats(): GenQueueStats {
    return { queued: this.pending.length, active: this.active };
  }

  /** How many generations this process has completed. Not persisted. */
  completed(): number {
    return this.served;
  }

  /** Drop queued work and refuse new submits. Used on shutdown. */
  stop(reason = 'shutting down'): void {
    this.stopped = true;
    while (this.pending.length > 0) {
      this.pending.shift()?.reject(new Error(`Image generation cancelled: ${reason}`));
    }
  }

  /**
   * Fire-and-forget. Work queued while a drain is running sets `again`, so the
   * in-flight loop picks it up without a second concurrent pass.
   */
  private kick(): void {
    if (this.stopped) return;
    if (this.draining) {
      this.again = true;
      return;
    }
    void this.drain().catch((error: unknown) => {
      console.warn('[companion][gen] drain failed', error);
    });
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      do {
        this.again = false;
        await this.drainOnce();
      } while (this.again && !this.stopped);
    } finally {
      this.draining = false;
    }
  }

  private async drainOnce(): Promise<void> {
    while (!this.stopped) {
      const waiter = this.pending.shift();
      if (waiter == null) return;
      this.active = true;
      const startedAt = Date.now();
      try {
        // Sequential by construction: the next shift() cannot happen until this
        // await settles, so two `generate` processes never overlap.
        const result = await this.runner.run(waiter.job);
        this.served += 1;
        waiter.resolve(result);
        logJson('outgoing', 'http', 'gen.completed', {
          id: waiter.id,
          model: waiter.job.model,
          elapsedMs: Date.now() - startedAt,
          bytes: result.png.byteLength,
          queued: this.pending.length,
        });
      } catch (error) {
        // One failed generation must never wedge the queue: the caller gets the
        // error and the loop moves on to the next waiter.
        waiter.reject(error);
        logJson('outgoing', 'http', 'gen.failed', {
          id: waiter.id,
          model: waiter.job.model,
          elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.active = false;
      }
    }
  }
}