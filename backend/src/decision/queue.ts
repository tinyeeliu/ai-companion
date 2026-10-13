/**
 * Serial queue in front of the resident decision process.
 *
 * One model stays loaded. Two decisions at once would share that process, so
 * they run one at a time. The queue is in memory only and separate from speech,
 * so a sentence does not hold up an answer.
 */
import type { DecisionJob } from './parse';

export interface DecisionResult {
  model: string;
  answers: Record<string, unknown>;
  usage: { input_tokens: number; output_tokens: number };
}

export interface DecisionRunner {
  run(job: DecisionJob): Promise<DecisionResult>;
}

interface Waiter {
  job: DecisionJob;
  resolve: (result: DecisionResult) => void;
  reject: (error: unknown) => void;
}

export const DECISION_MAX_PENDING = 8;

export class DecisionQueueFullError extends Error {
  constructor(readonly limit: number) {
    super(`Decision queue is full (${limit} waiting)`);
    this.name = 'DecisionQueueFullError';
  }
}

export class DecisionQueue {
  private readonly runner: DecisionRunner;
  private readonly pending: Waiter[] = [];
  private draining = false;
  private again = false;
  private stopped = false;

  constructor(runner: DecisionRunner) {
    this.runner = runner;
  }

  submit(job: DecisionJob): Promise<DecisionResult> {
    if (this.stopped) return Promise.reject(new Error('Decision queue is stopped'));
    if (this.pending.length >= DECISION_MAX_PENDING) {
      return Promise.reject(new DecisionQueueFullError(DECISION_MAX_PENDING));
    }
    return new Promise<DecisionResult>((resolve, reject) => {
      this.pending.push({ job, resolve, reject });
      this.kick();
    });
  }

  stop(): void {
    this.stopped = true;
    while (this.pending.length > 0) {
      this.pending.shift()?.reject(new Error('Decision queue is stopped'));
    }
  }

  private kick(): void {
    if (this.stopped) return;
    if (this.draining) {
      this.again = true;
      return;
    }
    void this.drain().catch((error: unknown) => {
      console.warn('[companion][decision] drain failed', error);
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
      try {
        waiter.resolve(await this.runner.run(waiter.job));
      } catch (error) {
        waiter.reject(error);
      }
    }
  }
}
