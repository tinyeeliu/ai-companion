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
      c.req.path === '/api/v1/im/health' || c.req.path === '/api/v1/im/connection';
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
      return c.json(jsonError(err), err.status as 400 | 401 | 404 | 409 | 500);
    }
    console.error('[companion]', err);
    return c.json({ error: 'PROCESS_FAILED', message: err.message }, 500);
  });

  app.get('/api/v1/im/health', (c) => c.json({ ok: true, port, token }));

  app.use('/api/v1/im/*', async (c, next) => {
    if (c.req.path === '/api/v1/im/health') return next();
    const got = bearerToken(c.req.header('authorization'));
    if (got !== token) {
      return c.json({ error: 'UNAUTHORIZED', message: 'Bearer token required' }, 401);
    }
    return next();
  });

  app.get('/api/v1/im/connection', (c) => c.json({ connections: manager.views() }));

  app.post('/api/v1/im/connection', async (c) => {
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

  app.get('/api/v1/im/connection/:id', (c) => {
    return c.json({ connection: manager.view(c.req.param('id')) });
  });

  app.put('/api/v1/im/connection/:id', async (c) => {
    const body = await readJson(c);
    if (typeof body.name !== 'string') {
      throw new HttpError(400, 'INVALID_PARAM', 'name is required');
    }
    const connection = await manager.rename(c.req.param('id'), body.name);
    return c.json({ connection });
  });

  app.delete('/api/v1/im/connection/:id', async (c) => {
    await manager.remove(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/api/v1/im/connection/:id/enable', async (c) => {
    const connection = await manager.enable(c.req.param('id'));
    return c.json({ connection });
  });

  app.post('/api/v1/im/connection/:id/disable', async (c) => {
    const connection = await manager.disable(c.req.param('id'));
    return c.json({ connection });
  });

  app.get('/api/v1/im/connection/:id/qr', (c) => {
    const id = c.req.param('id');
    return c.json({ qr: manager.qr(id), pin: manager.pin(id) });
  });

  app.get('/api/v1/im/connection/:id/messages', (c) => {
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

  app.get('/api/v1/im/connection/:id/messages/:messageId', (c) => {
    const id = c.req.param('id');
    const messageId = Number(c.req.param('messageId'));
    if (!Number.isInteger(messageId) || messageId < 1) {
      throw new HttpError(400, 'INVALID_PARAM', 'messageId must be a positive integer');
    }
    return c.json({ message: manager.getMessage(id, messageId) });
  });

  app.post('/api/v1/im/connection/:id/message', async (c) => {
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

  app.put('/api/v1/im/connection/:id/webhook', async (c) => {
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

  app.put('/api/v1/im/connection/:id/cloud', async (c) => {
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

  app.get('/*', serveStatic({ root: FRONTEND_DIR }));
  return app;
}
