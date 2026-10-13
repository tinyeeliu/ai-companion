/**
 * @fileoverview System One route plus the Setup page's decision controls.
 *
 * `POST /api/v1/systemone.json` returns the mlx-decision success body.
 * Errors stay Companion `{ error, message }`.
 */
import type { Hono } from 'hono';
import { HttpError } from '../types';
import { parseDecisionRequest } from './parse';
import { DecisionQueueFullError, type DecisionQueue } from './queue';
import { DecisionFailedError, DecisionTimeoutError } from './session';
import type { DecisionSetup } from './setup';

export interface DecisionRoutesOptions {
  queue: DecisionQueue;
  setup: DecisionSetup;
}

export function registerDecisionRoutes(app: Hono, options: DecisionRoutesOptions): void {
  const { queue, setup } = options;

  app.post('/api/v1/systemone.json', async (c) => {
    const job = parseDecisionRequest(await readJson(c));
    if (!(await setup.downloaded())) {
      throw new HttpError(503, 'DECISION_NOT_READY', 'Decision model is not downloaded');
    }
    if (!setup.enabled()) {
      throw new HttpError(503, 'DECISION_DISABLED', 'Decision is turned off');
    }
    try {
      return c.json(await queue.submit(job));
    } catch (error) {
      throw mapDecisionError(error);
    }
  });

  app.post('/api/v1/setup/decision/download.json', async (c) => {
    if (await setup.downloaded()) return c.json(await setup.view());
    return c.json(await setup.startDownload());
  });

  app.put('/api/v1/setup/decision.json', async (c) => {
    const body = await readJson(c);
    if (typeof body.enabled !== 'boolean') {
      throw new HttpError(400, 'INVALID_PARAM', 'enabled must be a boolean');
    }
    return c.json(await setup.setEnabled(body.enabled));
  });
}

function mapDecisionError(error: unknown): HttpError {
  if (error instanceof DecisionQueueFullError) return new HttpError(503, 'QUEUE_FULL', error.message);
  if (error instanceof DecisionTimeoutError) return new HttpError(504, 'DECISION_TIMEOUT', error.message);
  if (error instanceof DecisionFailedError) return new HttpError(500, 'DECISION_FAILED', error.message);
  if (error instanceof HttpError) return error;
  return new HttpError(500, 'DECISION_FAILED', error instanceof Error ? error.message : String(error));
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
