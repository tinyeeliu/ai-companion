/**
 * @fileoverview OpenAI-shaped speech route plus the Setup page's JSON.
 *
 * `POST /api/v1/audio/speech` returns audio bytes. The setup routes stay JSON
 * so the page can download and enable the model without speaking.
 */
import type { Hono } from 'hono';
import { HttpError } from '../types';
import { TtsFailedError, TtsTimeoutError } from './engine';
import { parseSpeechRequest } from './parse';
import { TtsQueueFullError, type SpeechResult, type TtsQueue } from './queue';
import type { TtsSetup } from './setup';

export interface TtsRoutesOptions {
  queue: TtsQueue;
  setup: TtsSetup;
}

export function registerTtsRoutes(app: Hono, options: TtsRoutesOptions): void {
  const { queue, setup } = options;

  app.post('/api/v1/audio/speech', async (c) => {
    if (!(await setup.downloaded())) {
      throw new HttpError(503, 'TTS_NOT_READY', 'Speech model is not downloaded');
    }
    if (!setup.enabled()) {
      throw new HttpError(503, 'TTS_DISABLED', 'Speech is turned off');
    }
    const job = parseSpeechRequest(await readJson(c));
    const result = await submit(queue, job);
    return c.body(new Uint8Array(result.audio), 200, { 'content-type': result.contentType });
  });

  app.get('/api/v1/setup.json', async (c) => {
    return c.json({ features: [await setup.view()] });
  });

  app.post('/api/v1/setup/tts/download.json', async (c) => {
    if (await setup.downloaded()) return c.json(await setup.view());
    return c.json(await setup.startDownload());
  });

  app.put('/api/v1/setup/tts.json', async (c) => {
    const body = await readJson(c);
    if (typeof body.enabled !== 'boolean') {
      throw new HttpError(400, 'INVALID_PARAM', 'enabled must be a boolean');
    }
    return c.json(await setup.setEnabled(body.enabled));
  });
}

async function submit(queue: TtsQueue, job: ReturnType<typeof parseSpeechRequest>): Promise<SpeechResult> {
  try {
    return await queue.submit(job);
  } catch (error) {
    if (error instanceof TtsQueueFullError) throw new HttpError(503, 'QUEUE_FULL', error.message);
    if (error instanceof TtsTimeoutError) throw new HttpError(504, 'TTS_TIMEOUT', error.message);
    if (error instanceof TtsFailedError) throw new HttpError(500, 'TTS_FAILED', error.message);
    if (error instanceof HttpError) throw error;
    throw new HttpError(500, 'TTS_FAILED', error instanceof Error ? error.message : String(error));
  }
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
