/**
 * @fileoverview OpenAI-shaped speech route plus the Setup page's JSON.
 *
 * `POST /api/v1/audio/speech` returns audio bytes. The setup routes stay JSON
 * so the page can download and enable the model without speaking.
 * `GET /api/v1/setup.json` is mounted by the app so speech and decision share one list.
 */
import type { Hono } from 'hono';
import { HttpError } from '../types';
import { TtsFailedError, TtsTimeoutError } from './engine';
import { listVoices } from './catalog';
import { speakOs } from './os';
import { parseSpeechRequest } from './parse';
import { playOnSpeaker } from './speaker';
import { usesMlxEngine } from './layout';
import { TtsQueueFullError, type SpeechResult, type TtsQueue } from './queue';
import type { TtsSetup } from './setup';

export interface TtsRoutesOptions {
  queue: TtsQueue;
  setup: TtsSetup;
  /** Test double. The default plays the wav on this machine. */
  play?: (wav: Uint8Array) => Promise<void>;
}

export function registerTtsRoutes(app: Hono, options: TtsRoutesOptions): void {
  const { queue, setup } = options;
  const play = options.play ?? playOnSpeaker;

  app.get('/api/v1/voices.json', async (c) => {
    return c.json({ voices: await listVoices(setup.dataRoot()) });
  });

  app.post('/api/v1/audio/speech', async (c) => {
    const body = await readJson(c);
    const job = parseSpeechRequest(body, usesMlxEngine() ? setup.model() : null);
    if (job.voice.osName != null) {
      return respond(c, job, await speakMapped(job), play);
    }
    if (!(await setup.downloaded())) {
      throw new HttpError(503, 'TTS_NOT_READY', 'Speech model is not downloaded');
    }
    if (!setup.enabled()) {
      throw new HttpError(503, 'TTS_DISABLED', 'Speech is turned off');
    }
    return respond(c, job, await submit(queue, job), play);
  });

  app.post('/api/v1/setup/tts/download.json', async (c) => {
    if (await setup.downloaded()) return c.json(await setup.view());
    return c.json(await setup.startDownload());
  });

  app.put('/api/v1/setup/tts.json', async (c) => {
    const body = await readJson(c);
    if (body.model != null) {
      if (typeof body.model !== 'string') {
        throw new HttpError(400, 'INVALID_PARAM', 'model must be en or zh');
      }
      return c.json(await setup.setModel(body.model));
    }
    if (typeof body.enabled !== 'boolean') {
      throw new HttpError(400, 'INVALID_PARAM', 'enabled must be a boolean');
    }
    return c.json(await setup.setEnabled(body.enabled));
  });
}

async function respond(
  c: { body: (data: Uint8Array | null, status?: number, headers?: Record<string, string>) => Response },
  job: ReturnType<typeof parseSpeechRequest>,
  result: SpeechResult,
  play: (wav: Uint8Array) => Promise<void>,
): Promise<Response> {
  if (!job.speaker) {
    return c.body(new Uint8Array(result.audio), 200, { 'content-type': result.contentType });
  }
  try {
    await play(result.audio);
  } catch (error) {
    throw mapSpeechError(error);
  }
  return c.body(null, 204);
}

async function speakMapped(job: ReturnType<typeof parseSpeechRequest>): Promise<SpeechResult> {
  try {
    return await speakOs(job);
  } catch (error) {
    throw mapSpeechError(error);
  }
}

async function submit(queue: TtsQueue, job: ReturnType<typeof parseSpeechRequest>): Promise<SpeechResult> {
  try {
    return await queue.submit(job);
  } catch (error) {
    throw mapSpeechError(error);
  }
}

function mapSpeechError(error: unknown): HttpError {
  if (error instanceof TtsQueueFullError) return new HttpError(503, 'QUEUE_FULL', error.message);
  if (error instanceof TtsTimeoutError) return new HttpError(504, 'TTS_TIMEOUT', error.message);
  if (error instanceof TtsFailedError) return new HttpError(500, 'TTS_FAILED', error.message);
  if (error instanceof HttpError) return error;
  return new HttpError(500, 'TTS_FAILED', error instanceof Error ? error.message : String(error));
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
