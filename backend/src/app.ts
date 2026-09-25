import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import type { ConnectionManager } from './manager';
import { FRONTEND_DIR } from './paths';
import { bearerToken } from './token';
import { isChannel } from './channel';
import { HttpError, jsonError } from './types';
import { isHttpUrl, isWsUrl } from './webhook';
import { assertId } from './store';
import { isDirectionFilter, isMessageStatus, type MessageQuery } from './messages';
import { logJson } from './log';

export interface AppOptions {
  manager: ConnectionManager;
  token: string;
  port: number;
}

/**
 * Hono captures a path param greedily, so a route ending in `:id{.+\\.json}`
 * (`/connection/home.json`) hands the handler `home.json`. Strip the format
 * suffix the same way SM3's `stripFormatSuffix` does. Static leaf segments
 * (`/connection/:id/qr.json`) never need this — their param is a clean `home`.
 */
function stripFormatSuffix(value: string, suffix: string): string {
  return value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
}

function recipientTo(value: unknown, channel: string): string {
  if (typeof value !== 'string') return '';
  if (channel === 'line') return value.trim();
  return value.replace(/\D/g, '');
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

export function createApp(options: AppOptions): Hono {
  const app = new Hono();
  const { manager, token, port } = options;

  app.use('/api/*', async (c, next) => {
    const isConsolePolling =
      c.req.path === '/api/v1/im/health' || c.req.path === '/api/v1/im/connection.json';
    if (isConsolePolling) {
      return next();
    }
    let requestJson: unknown = null;
    const hasRequestBody = c.req.method !== 'GET' && c.req.method !== 'HEAD';
    if (hasRequestBody && (c.req.header('content-type') ?? '').includes('application/json')) {
      try {
        requestJson = await c.req.raw.clone().json();
      } catch {
        requestJson = '[invalid JSON request]';
      }
    }
    logJson('incoming', 'http', `${c.req.method} ${c.req.path}`, requestJson);
    await next();
    let responseJson: unknown = null;
    if ((c.res.headers.get('content-type') ?? '').includes('application/json')) {
      try {
        responseJson = await c.res.clone().json();
      } catch {
        responseJson = '[invalid JSON response]';
      }
    }
    logJson('outgoing', 'http', `${c.req.method} ${c.req.path} ${c.res.status}`, responseJson);
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json(jsonError(err), err.status as 400 | 401 | 404 | 408 | 409 | 500);
    }
    console.error('[companion]', err);
    return c.json({ error: 'PROCESS_FAILED', message: err.message }, 500);
  });

  app.get('/api/v1/im/health', (c) => c.json({ ok: true, port, token }));

  app.use('/api/v1/im/*', async (c, next) => {
    if (c.req.path === '/api/v1/im/health') return next();
    // Local dev (`scripts/run.sh`, :38000) calls test.json from Bruno without a
    // token. The packaged app on 38888 still requires the bearer.
    if (port === 38000 && c.req.path === '/api/v1/im/test.json') return next();
    const got = bearerToken(c.req.header('authorization'));
    if (got !== token) {
      return c.json({ error: 'UNAUTHORIZED', message: 'Bearer token required' }, 401);
    }
    return next();
  });

  app.get('/api/v1/im/connection.json', (c) => c.json({ connections: manager.views() }));

  app.post('/api/v1/im/connection.json', async (c) => {
    const body = await readJson(c);
    const requested = typeof body.id === 'string' ? body.id : undefined;
    const name = typeof body.name === 'string' ? body.name : undefined;
    if (body.channel != null && !isChannel(body.channel)) {
      throw new HttpError(400, 'INVALID_PARAM', 'channel must be whatsapp or line');
    }
    const channel = isChannel(body.channel) ? body.channel : 'whatsapp';
    if (requested != null) assertId(requested);
    const connection = await manager.create(requested, name, channel);
    return c.json({ connection });
  });

  app.post('/api/v1/im/connection/:id/enable.json', async (c) => {
    const connection = await manager.enable(c.req.param('id'));
    return c.json({ connection });
  });

  app.post('/api/v1/im/connection/:id/disable.json', async (c) => {
    const connection = await manager.disable(c.req.param('id'));
    return c.json({ connection });
  });

  app.get('/api/v1/im/connection/:id/qr.json', (c) => {
    const id = c.req.param('id');
    return c.json({ qr: manager.qr(id), pin: manager.pin(id) });
  });

  app.get('/api/v1/im/connection/:id/messages.json', (c) => {
    const id = c.req.param('id');
    const direction = c.req.query('direction') ?? 'all';
    if (!isDirectionFilter(direction)) {
      throw new HttpError(400, 'INVALID_PARAM', 'direction must be in, out, or all');
    }
    const status = c.req.query('status');
    if (status != null && !isMessageStatus(status)) {
      throw new HttpError(400, 'INVALID_PARAM', 'status is invalid');
    }
    const type = c.req.query('type');
    const query: MessageQuery = { direction };
    if (type != null && type.trim() !== '') query.type = type.trim();
    if (status != null) query.status = status;
    return c.json(
      manager.listMessages(id, query, c.req.query('page'), c.req.query('limit')),
    );
  });

  app.get('/api/v1/im/connection/:id/messages/:messageId{.+\\.json}', (c) => {
    const id = c.req.param('id');
    const messageId = Number(stripFormatSuffix(c.req.param('messageId'), '.json'));
    if (!Number.isInteger(messageId) || messageId < 1) {
      throw new HttpError(400, 'INVALID_PARAM', 'messageId must be a positive integer');
    }
    return c.json({ message: manager.getMessage(id, messageId) });
  });

  app.post('/api/v1/im/connection/:id/message.json', async (c) => {
    const id = c.req.param('id');
    const body = await readJson(c);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (typeof body.to !== 'string' || body.to.trim() === '') {
      throw new HttpError(400, 'INVALID_PARAM', 'to is required');
    }
    if (text === '') throw new HttpError(400, 'INVALID_PARAM', 'text is required');
    const row = manager.store.require(id);
    const to = recipientTo(body.to, row.channel);
    if (to === '') throw new HttpError(400, 'INVALID_PARAM', 'to is required');
    const sent = await manager.send(id, to, text);
    return c.json(sent);
  });

  // Not connection-scoped: both ids travel in the body.
  app.post('/api/v1/im/replay.json', async (c) => {
    const body = await readJson(c);
    const connectionId = typeof body.connectionId === 'string' ? body.connectionId.trim() : '';
    if (connectionId === '') {
      throw new HttpError(400, 'INVALID_PARAM', 'connectionId is required');
    }
    const messageId = Number(body.messageId);
    if (!Number.isInteger(messageId) || messageId < 1) {
      throw new HttpError(400, 'INVALID_PARAM', 'messageId must be a positive integer');
    }
    return c.json({ ok: true, ...manager.replayMessage(connectionId, messageId) });
  });

  app.post('/api/v1/im/test.json', async (c) => {
    const body = await readJson(c);
    if (!isChannel(body.channel)) {
      throw new HttpError(400, 'INVALID_PARAM', 'channel must be whatsapp or line');
    }
    if (body.payload == null || typeof body.payload !== 'object' || Array.isArray(body.payload)) {
      throw new HttpError(400, 'INVALID_PARAM', 'payload must be a v1 cloud frame');
    }
    const maxResponse = body.maxResponse == null ? 1 : body.maxResponse;
    if (typeof maxResponse !== 'number' || !Number.isInteger(maxResponse) || maxResponse < 1) {
      throw new HttpError(400, 'INVALID_PARAM', 'maxResponse must be an integer >= 1');
    }
    const maxWait = body.maxWait == null ? 10 : body.maxWait;
    if (typeof maxWait !== 'number' || !Number.isFinite(maxWait) || maxWait <= 0 || maxWait > 120) {
      throw new HttpError(400, 'INVALID_PARAM', 'maxWait must be seconds greater than 0 and at most 120');
    }
    if (body.skipReply != null && typeof body.skipReply !== 'boolean') {
      throw new HttpError(400, 'INVALID_PARAM', 'skipReply must be a boolean');
    }
    if (body.traceId != null && typeof body.traceId !== 'string') {
      throw new HttpError(400, 'INVALID_PARAM', 'traceId must be a string');
    }
    const traceId = typeof body.traceId === 'string' ? body.traceId.trim() : '';
    const frames = await manager.testExchange({
      channel: body.channel,
      payload: body.payload,
      maxResponse,
      maxWaitMs: maxWait * 1000,
      skipReply: body.skipReply !== false,
      ...(traceId !== '' ? { traceId } : {}),
    });
    return c.json(frames);
  });

  app.put('/api/v1/im/connection/:id/webhook.json', async (c) => {
    const body = await readJson(c);
    const raw = body.url;
    if (raw !== null && raw !== undefined && typeof raw !== 'string') {
      throw new HttpError(400, 'INVALID_PARAM', 'url must be a string or null');
    }
    const url = typeof raw === 'string' && raw !== '' ? raw : null;
    if (url != null && !isHttpUrl(url)) {
      throw new HttpError(400, 'INVALID_PARAM', 'url must be http or https');
    }
    const rawToken = body.token;
    if (rawToken !== null && rawToken !== undefined && typeof rawToken !== 'string') {
      throw new HttpError(400, 'INVALID_PARAM', 'token must be a string');
    }
    // Required whenever a url is set: the token identifies this computer to the
    // receiver as `Authorization: Bearer`. Clearing the url clears the token.
    const token = typeof rawToken === 'string' ? rawToken.trim() : '';
    if (url != null && token === '') {
      throw new HttpError(400, 'INVALID_PARAM', 'token is required when url is set');
    }
    const connection = await manager.setWebhook(c.req.param('id'), url, url == null ? null : token);
    return c.json({ connection });
  });

  app.put('/api/v1/im/connection/:id/cloud.json', async (c) => {
    const body = await readJson(c);
    const raw = body.url;
    if (raw !== null && raw !== undefined && typeof raw !== 'string') {
      throw new HttpError(400, 'INVALID_PARAM', 'url must be a string or null');
    }
    const url = typeof raw === 'string' && raw !== '' ? raw : null;
    if (url != null && !isWsUrl(url)) {
      throw new HttpError(400, 'INVALID_PARAM', 'url must be ws or wss');
    }
    const rawToken = body.token;
    if (rawToken !== null && rawToken !== undefined && typeof rawToken !== 'string') {
      throw new HttpError(400, 'INVALID_PARAM', 'token must be a string');
    }
    const token = typeof rawToken === 'string' ? rawToken.trim() : '';
    if (url != null && token === '') {
      throw new HttpError(400, 'INVALID_PARAM', 'token is required when url is set');
    }
    const connection = await manager.setCloud(c.req.param('id'), url, url == null ? null : token);
    return c.json({ connection });
  });

  // Greedy captures come last: `:id{.+\\.json}` would otherwise swallow
  // `home/qr` and match `/connection/home/qr.json` before its static leaf does.
  // Same ordering rule as SM3's kanban.routes.ts.
  app.get('/api/v1/im/connection/:id{.+\\.json}', (c) => {
    return c.json({ connection: manager.view(stripFormatSuffix(c.req.param('id'), '.json')) });
  });

  app.put('/api/v1/im/connection/:id{.+\\.json}', async (c) => {
    const body = await readJson(c);
    if (typeof body.name !== 'string') {
      throw new HttpError(400, 'INVALID_PARAM', 'name is required');
    }
    const connection = await manager.rename(stripFormatSuffix(c.req.param('id'), '.json'), body.name);
    return c.json({ connection });
  });

  app.delete('/api/v1/im/connection/:id{.+\\.json}', async (c) => {
    await manager.remove(stripFormatSuffix(c.req.param('id'), '.json'));
    return c.json({ ok: true });
  });

  app.get('/*', serveStatic({ root: FRONTEND_DIR }));
  return app;
}
