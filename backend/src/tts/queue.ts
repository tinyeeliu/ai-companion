/**
 * @fileoverview Serial queue in front of sherpa-onnx.
 *
 * Kokoro is small next to an image model, but each call is still a full process
 * that loads the weights. Two of those at once would fight over the same file
 * and the same memory, so speech runs one at a time. The queue is in memory
 * only: a restart drops whatever was waiting, and it is separate from the image
 * queue so a FLUX job does not hold up a sentence.
 */
import type { SpeechJob } from './parse';

export interface SpeechResult {
  audio: Uint8Array;
  contentType: string;
}

export interface SpeechRunner {
  run(job: SpeechJob): Promise<SpeechResult>;
}

interface Waiter {
  job: SpeechJob;
  resolve: (result: SpeechResult) => void;
  reject: (error: unknown) => void;
}

export const TTS_MAX_PENDING = 8;

export class TtsQueueFullError extends Error {
  constructor(readonly limit: number) {
    super(`Speech queue is full (${limit} waiting)`);
    this.name = 'TtsQueueFullError';
  }
}

export class TtsQueue {
  private readonly runner: SpeechRunner;
  private readonly pending: Waiter[] = [];
  private draining = false;
  private again = false;
  private stopped = false;

  constructor(runner: SpeechRunner) {
    this.runner = runner;
  }

  submit(job: SpeechJob): Promise<SpeechResult> {
    if (this.stopped) return Promise.reject(new Error('Speech queue is stopped'));
    if (this.pending.length >= TTS_MAX_PENDING) {
      return Promise.reject(new TtsQueueFullError(TTS_MAX_PENDING));
    }
    return new Promise<SpeechResult>((resolve, reject) => {
      this.pending.push({ job, resolve, reject });
      this.kick();
    });
  }

  stop(): void {
    this.stopped = true;
    while (this.pending.length > 0) {
      this.pending.shift()?.reject(new Error('Speech queue is stopped'));
    }
  }

  private kick(): void {
    if (this.stopped) return;
    if (this.draining) {
      this.again = true;
      return;
    }
    void this.drain().catch((error: unknown) => {
      console.warn('[companion][tts] drain failed', error);
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
