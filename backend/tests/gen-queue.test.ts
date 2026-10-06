/**
 * Serialization is the whole point of GenQueue: two `draw-things-cli` processes
 * at once means two multi-gigabyte model loads fighting over the same memory.
 * These tests pin that invariant without spawning a real model.
 */
import { describe, expect, test } from 'bun:test';
import { GenQueue, GenQueueFullError, GEN_MAX_PENDING, type GenJob, type GenResult, type GenRunner } from '../src/gen/queue';
import { GenTimeoutError } from '../src/gen/drawthings';

/**
 * Records when each run entered and left so a test can prove no two overlapped,
 * and can fail loudly rather than flaking on a timing assumption.
 */
class RecordingRunner implements GenRunner {
  readonly events: Array<{ job: GenJob; enter: number; exit: number }> = [];
  active = 0;
  maxActive = 0;

  constructor(private readonly delayMs = 5) {}

  async run(job: GenJob): Promise<GenResult> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    const enter = this.events.length;
    try {
      await Bun.sleep(this.delayMs);
      this.events.push({ job, enter, exit: this.events.length });
      return { png: new Uint8Array([1, 2, 3]) };
    } finally {
      this.active -= 1;
    }
  }
}

function job(prompt: string): GenJob {
  return { prompt, model: 'flux_2_klein_4b_q6p.ckpt', width: 512, height: 512 };
}

describe('GenQueue', () => {
  test('never runs two jobs at once', async () => {
    const runner = new RecordingRunner(10);
    const queue = new GenQueue(runner);

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => queue.submit(job(`p${i}`))),
    );

    expect(results).toHaveLength(5);
    // The core assertion: one at a time.
    expect(runner.maxActive).toBe(1);
    expect(runner.events).toHaveLength(5);
  });

  test('serves jobs in submission order', async () => {
    const runner = new RecordingRunner();
    const queue = new GenQueue(runner);

    await Promise.all(Array.from({ length: 4 }, (_, i) => queue.submit(job(`p${i}`))));

    expect(runner.events.map((e) => e.job.prompt)).toEqual(['p0', 'p1', 'p2', 'p3']);
  });

  test('each caller gets its own bytes', async () => {
    const queue = new GenQueue(new RecordingRunner());
    const a = await queue.submit(job('a'));
    const b = await queue.submit(job('b'));
    expect(a.png).toEqual(new Uint8Array([1, 2, 3]));
    expect(b.png).toEqual(new Uint8Array([1, 2, 3]));
  });

  test('a failing job does not wedge the queue', async () => {
    let calls = 0;
    const queue = new GenQueue({
      async run(): Promise<GenResult> {
        calls += 1;
        if (calls === 1) throw new Error('model exploded');
        return { png: new Uint8Array([9]) };
      },
    });

    const failed = queue.submit(job('bad'));
    await expect(failed).rejects.toThrow('model exploded');

    // The slot must be free again immediately.
    const ok = await queue.submit(job('good'));
    expect(ok.png).toEqual(new Uint8Array([9]));
    expect(calls).toBe(2);
  });

  test('a timed-out run frees the slot for the next job', async () => {
    // The real deadline lives in the CLI adapter (it kills the child). Here the
    // fake models that by rejecting the way the adapter does on timeout, so the
    // test proves the queue recovers from a dead run and keeps serving.
    let calls = 0;
    const queue = new GenQueue({
      async run(): Promise<GenResult> {
        calls += 1;
        if (calls === 1) throw new GenTimeoutError(1000);
        return { png: new Uint8Array([7]) };
      },
    });

    await expect(queue.submit(job('hang'))).rejects.toBeInstanceOf(GenTimeoutError);
    // The slot must be free again immediately after a dead run.
    const ok = await queue.submit(job('next'));
    expect(ok.png).toEqual(new Uint8Array([7]));
    expect(calls).toBe(2);
  });

  test('reports depth while work is in flight', async () => {
    const runner = new RecordingRunner(30);
    const queue = new GenQueue(runner);

    const first = queue.submit(job('p0'));
    const second = queue.submit(job('p1'));
    await Bun.sleep(5);
    expect(queue.stats()).toEqual({ queued: 1, active: true });

    await Promise.all([first, second]);
    expect(queue.stats()).toEqual({ queued: 0, active: false });
    expect(queue.completed()).toBe(2);
  });

  test('refuses work past the backlog cap instead of growing it', async () => {
    const runner = new RecordingRunner(40);
    const queue = new GenQueue(runner);

    // Rejections are part of what is being observed here, so the settled type
    // is GenResult | unknown.
    const accepted: Array<Promise<unknown>> = [];
    // One runs, the rest queue: cap is one more than we can hold here.
    for (let i = 0; i < GEN_MAX_PENDING + 2; i += 1) {
      accepted.push(queue.submit(job(`p${i}`)).catch((error: unknown) => error));
    }
    const outcomes = await Promise.all(accepted);
    const full = outcomes.filter((o) => o instanceof GenQueueFullError);
    expect(full.length).toBeGreaterThan(0);
  });

  test('stop rejects queued work and refuses new submits', async () => {
    const queue = new GenQueue(new RecordingRunner(40));
    const running = queue.submit(job('p0'));
    const queued = queue.submit(job('p1'));

    queue.stop('test shutdown');

    await expect(queued).rejects.toThrow(/cancelled/);
    await expect(queue.submit(job('p2'))).rejects.toThrow(/stopped/);
    running.catch(() => {});
  });
});