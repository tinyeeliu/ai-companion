/**
 * @fileoverview LLM Gateway routes.
 *
 * `POST /codex/v1/chat/completions` and `POST /codex/v1/responses` forward a
 * bare model name to the local Codex server. The `/v1/...` twins are a
 * provider router: a model of `codex/gpt-5.6-luna` drops the prefix and uses
 * that same handler. Responses retrieve, delete, and cancel are forwarded
 * with the id unchanged.
 */
import type { Context, Hono } from 'hono';
import { HttpError } from '../types';
import { DEFAULT_MODEL } from './layout';
import type { LlmSetup } from './setup';

export interface LlmRoutesOptions {
  setup: LlmSetup;
}

const TEST_BODY = {
  model: DEFAULT_MODEL,
  messages: [{ role: 'user', content: 'Say hello in one word.' }],
};

export function registerLlmRoutes(app: Hono, options: LlmRoutesOptions): void {
  const { setup } = options;

  app.post('/codex/v1/chat/completions', async (c) => {
    const body = await readJson(c);
    return setup.forward(body);
  });

  app.post('/v1/chat/completions', async (c) => {
    return setup.forward(stripCodexModel(await readJson(c)));
  });

  mountResponses(app, setup, '/codex/v1/responses', false);
  mountResponses(app, setup, '/v1/responses', true);

  app.post('/api/v1/setup/llm/download.json', async (c) => {
    if (setup.downloaded()) return c.json(await setup.view());
    return c.json(await setup.startDownload());
  });

  app.put('/api/v1/setup/llm.json', async (c) => {
    const body = await readJson(c);
    const hasEnabled = Object.prototype.hasOwnProperty.call(body, 'enabled');
    const hasProxy = Object.prototype.hasOwnProperty.call(body, 'useProxy');
    if (!hasEnabled && !hasProxy) {
      throw new HttpError(400, 'INVALID_PARAM', 'enabled or useProxy is required');
    }
    if (hasProxy) {
      if (typeof body.useProxy !== 'boolean') {
        throw new HttpError(400, 'INVALID_PARAM', 'useProxy must be a boolean');
      }
      await setup.setUseProxy(body.useProxy);
    }
    if (hasEnabled) {
      if (typeof body.enabled !== 'boolean') {
        throw new HttpError(400, 'INVALID_PARAM', 'enabled must be a boolean');
      }
      return c.json(await setup.setEnabled(body.enabled));
    }
    return c.json(await setup.view());
  });

  app.post('/api/v1/setup/llm/test.json', async (c) => {
    const started = Date.now();
    const res = await setup.forward(TEST_BODY);
    const payload = await res.json().catch(() => null) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    } | null;
    if (!res.ok) {
      const message = payload?.error?.message ?? `Gateway returned ${res.status}`;
      throw new HttpError(res.status >= 400 && res.status <= 599 ? res.status : 502, 'LLM_FAILED', message);
    }
    const text = payload?.choices?.[0]?.message?.content ?? '';
    return c.json({ text, ms: Date.now() - started });
  });
}

/**
 * Create, retrieve, delete, cancel, and input-token count. `input_tokens` is
 * registered before `:id` so that segment is not captured as an id.
 * `rewriteModel` is the `/v1` router: create and input_tokens must use a
 * `codex/` model. Follow-up calls have no model; the id already names a
 * response on this gateway.
 */
function mountResponses(app: Hono, setup: LlmSetup, base: string, rewriteModel: boolean): void {
  app.post(`${base}/input_tokens`, async (c) => {
    const body = await readJson(c);
    return setup.forward(rewriteModel ? stripCodexModel(body) : body, '/v1/responses/input_tokens');
  });

  app.post(`${base}/:id/cancel`, async (c) => {
    return setup.forwardRequest('POST', `/v1/responses/${c.req.param('id')}/cancel`, await readRaw(c));
  });

  app.get(`${base}/:id`, (c) => {
    return setup.forwardRequest('GET', withQuery(`/v1/responses/${c.req.param('id')}`, c), null);
  });

  app.delete(`${base}/:id`, (c) => {
    return setup.forwardRequest('DELETE', withQuery(`/v1/responses/${c.req.param('id')}`, c), null);
  });

  app.post(base, async (c) => {
    const body = await readJson(c);
    return setup.forward(rewriteModel ? stripCodexModel(body) : body, '/v1/responses');
  });
}

function stripCodexModel(body: Record<string, unknown>): Record<string, unknown> {
  const model = typeof body.model === 'string' ? body.model : '';
  if (!model.startsWith('codex/')) {
    throw new HttpError(404, 'NOT_FOUND', `No provider for model ${model === '' ? '(missing)' : model}`);
  }
  const bare = model.slice('codex/'.length);
  if (bare === '') throw new HttpError(400, 'INVALID_PARAM', 'model is missing a name after codex/');
  return { ...body, model: bare };
}

function withQuery(path: string, c: Context): string {
  const search = new URL(c.req.url).search;
  return search === '' ? path : `${path}${search}`;
}

async function readRaw(c: Context): Promise<string | null> {
  const text = await c.req.text();
  return text.length === 0 ? null : text;
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
