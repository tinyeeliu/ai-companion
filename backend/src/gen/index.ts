/**
 * @fileoverview OpenAI-shaped image generation routes.
 *
 * The wire format is the OpenAI Images API, deliberately and only that:
 * `model`, `prompt`, `n`, `size`, `quality`, `response_format`, `user`. Unknown
 * fields are a 400 rather than a shrug, so a caller that fat-fingers a Bifrost
 * or Draw Things field (`negative_prompt`, `num_inference_steps`, `seed`) learns
 * immediately instead of silently getting different output than it asked for.
 *
 * Two things deliberately diverge from OpenAI:
 * - Errors use the Companion envelope `{ error, message }`, matching every other
 *   route in this process.
 * - The path is `/api/v1/image/generations.json`, under the existing `/api/*`
 *   bearer guard, so an OpenAI SDK cannot be pointed here unchanged.
 */
import type { Hono } from 'hono';
import { HttpError } from '../types';
import { GenQueueFullError, type GenJob, type GenQueue, type GenResult } from './queue';
import { GenFailedError, GenTimeoutError, type DrawThings } from './drawthings';
import type { GenStore } from './store';

/**
 * OpenAI's size set, plus `auto`. Every concrete value is already a multiple of
 * 64, which is Draw Things' width/height requirement, so nothing here has to be
 * rejected or rounded.
 */
const SIZES = new Set([
  'auto',
  '256x256',
  '512x512',
  '1024x1024',
  '1792x1024',
  '1024x1792',
  '1536x1024',
  '1024x1536',
]);

const ALLOWED_KEYS = new Set(['model', 'prompt', 'n', 'size', 'quality', 'response_format', 'user']);
const QUALITIES = new Set(['auto', 'high', 'medium', 'low', 'standard', 'hd']);

/** Steps per quality band. `high` is the model's recommended count. */
const QUALITY_STEPS: Record<string, number | undefined> = {
  auto: undefined,
  high: undefined,
  medium: 6,
  standard: 6,
  low: 4,
  hd: undefined,
};

export const DEFAULT_MODEL = 'flux_2_klein_4b_q6p.ckpt';
/** OpenAI caps `n` at 10; each unit here is a full multi-second model run. */
const MAX_N = 4;

export interface ImageRoutesOptions {
  queue: GenQueue;
  drawThings: DrawThings;
  store: GenStore;
  /** False when the CLI is missing on this machine; routes then answer 503. */
  ready: boolean;
}

interface ImageData {
  b64_json: string | null;
  url: string | null;
  revised_prompt: null;
}

interface ParsedRequest {
  job: GenJob;
  n: number;
  responseFormat: 'url' | 'b64_json';
}

export function registerImageRoutes(app: Hono, options: ImageRoutesOptions): void {
  const { queue, drawThings, store, ready } = options;

  app.post('/api/v1/image/generations.json', async (c) => {
    if (!ready) {
      throw new HttpError(503, 'CLI_UNAVAILABLE', 'draw-things-cli is not available on this machine');
    }
    const parsed = parseRequest(await readJson(c));
    const created = Math.floor(Date.now() / 1000);
    const data: ImageData[] = [];
    for (let i = 0; i < parsed.n; i += 1) {
      // Sequential here too, deliberately: these are whole model runs, and the
      // point of the queue is that they never pile up.
      const result = await submit(queue, parsed.job);
      data.push(dispose(result, parsed.responseFormat, store));
    }
    return c.json({ created, data });
  });

  app.get('/api/v1/image/generations/:id{.+\\.png}', (c) => {
    const id = stripPng(c.req.param('id'));
    const png = store.read(id);
    if (png == null) throw new HttpError(404, 'NOT_FOUND', `Image ${id} not found`);
    // Hono types a body as a plain `Uint8Array<ArrayBuffer>`; the store hands
    // back the wider `ArrayBufferLike`, so copy into a fresh buffer.
    return c.body(new Uint8Array(png), 200, { 'content-type': 'image/png' });
  });
}

/** Maps a runner failure onto the HTTP surface without leaking a stack trace. */
async function submit(queue: GenQueue, job: GenJob): Promise<GenResult> {
  try {
    return await queue.submit(job);
  } catch (error) {
    if (error instanceof GenQueueFullError) {
      throw new HttpError(503, 'QUEUE_FULL', error.message);
    }
    if (error instanceof GenTimeoutError) {
      throw new HttpError(504, 'GENERATION_TIMEOUT', error.message);
    }
    if (error instanceof GenFailedError) {
      throw new HttpError(500, 'GENERATION_FAILED', error.message);
    }
    if (error instanceof HttpError) throw error;
    throw new HttpError(500, 'GENERATION_FAILED', error instanceof Error ? error.message : String(error));
  }
}

function dispose(result: GenResult, format: 'url' | 'b64_json', store: GenStore): ImageData {
  if (format === 'b64_json') {
    return { b64_json: Buffer.from(result.png).toString('base64'), url: null, revised_prompt: null };
  }
  const id = store.save(result.png);
  return { b64_json: null, url: `/api/v1/image/generations/${id}.png`, revised_prompt: null };
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body != null && typeof body === 'object' && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function stripPng(value: string): string {
  return value.endsWith('.png') ? value.slice(0, -'.png'.length) : value;
}

export function parseRequest(body: Record<string, unknown>): ParsedRequest {
  const unknownKeys = Object.keys(body).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new HttpError(
      400,
      'INVALID_PARAM',
      `unsupported field(s): ${unknownKeys.join(', ')}. Supported: ${[...ALLOWED_KEYS].join(', ')}`,
    );
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (prompt === '') throw new HttpError(400, 'INVALID_PARAM', 'prompt is required');

  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (model === '') throw new HttpError(400, 'INVALID_PARAM', 'model is required');

  let n = 1;
  if (body.n != null) {
    if (typeof body.n !== 'number' || !Number.isInteger(body.n) || body.n < 1 || body.n > MAX_N) {
      throw new HttpError(400, 'INVALID_PARAM', `n must be an integer between 1 and ${MAX_N}`);
    }
    n = body.n;
  }

  let width: number | undefined;
  let height: number | undefined;
  if (body.size != null && body.size !== 'auto') {
    if (typeof body.size !== 'string' || !SIZES.has(body.size)) {
      throw new HttpError(400, 'INVALID_PARAM', `size must be one of: ${[...SIZES].join(', ')}`);
    }
    const [w, h] = body.size.split('x');
    width = Number(w);
    height = Number(h);
  }

  let steps: number | undefined;
  if (body.quality != null) {
    if (typeof body.quality !== 'string' || !QUALITIES.has(body.quality)) {
      throw new HttpError(400, 'INVALID_PARAM', `quality must be one of: ${[...QUALITIES].join(', ')}`);
    }
    steps = QUALITY_STEPS[body.quality];
  }

  let responseFormat: 'url' | 'b64_json' = 'url';
  if (body.response_format != null) {
    if (body.response_format !== 'url' && body.response_format !== 'b64_json') {
      throw new HttpError(400, 'INVALID_PARAM', 'response_format must be url or b64_json');
    }
    responseFormat = body.response_format;
  }

  if (body.user != null && typeof body.user !== 'string') {
    throw new HttpError(400, 'INVALID_PARAM', 'user must be a string');
  }

  return {
    job: { prompt, model, ...(width != null ? { width } : {}), ...(height != null ? { height } : {}), ...(steps != null ? { steps } : {}) },
    n,
    responseFormat,
  };
}