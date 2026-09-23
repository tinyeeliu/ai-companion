import { t } from './i18n';

export type Channel = 'whatsapp' | 'line';

export interface Connection {
  id: string;
  name: string;
  channel: Channel;
  status: string;
  phone?: string;
  user?: string;
  enabled: boolean;
  webhookUrl: string | null;
  /** Sent as a Bearer token on every webhook POST. */
  webhookToken: string | null;
  cloudUrl: string | null;
  cloudToken: string | null;
  /**
   * Media presign endpoint learned from the cloud's `hello`, or null when the
   * server advertised none. Read-only in the UI: it is never typed by hand.
   */
  uploadUrl: string | null;
  /** Live cloud reverse-WSS state: off | connecting | connected | retrying | rejected. */
  cloudStatus: string;
  /** Set only after a 4401 rejection, until the link is saved again. */
  cloudError?: string;
  uptimeMs?: number;
  incomingCount: number;
  outgoingCount: number;
  disconnectCount: number;
  pin?: string | null;
  lastError?: string;
}

export interface Health {
  ok: boolean;
  port: number;
  token: string;
}

let token = '';

export function authToken(): string {
  return token;
}

export async function bootstrap(): Promise<Health> {
  const health = await fetchHealth();
  token = health.token;
  return health;
}

export async function fetchHealth(): Promise<Health> {
  const res = await fetch('/api/v1/im/health');
  if (!res.ok) throw new Error(t('error.health', { status: res.status }));
  return (await res.json()) as Health;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token !== '') headers.set('Authorization', `Bearer ${token}`);
  if (init.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(path, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) {
    throw new Error(
      typeof body.message === 'string' ? body.message : t('error.http', { status: res.status }),
    );
  }
  return body as T;
}

export function listConnections(): Promise<{ connections: Connection[] }> {
  return request('/api/v1/im/connection');
}

export function createConnection(
  body: { id?: string; name?: string; channel?: Channel } = {},
): Promise<{ connection: Connection }> {
  return request('/api/v1/im/connection', { method: 'POST', body: JSON.stringify(body) });
}

export function getConnection(id: string): Promise<{ connection: Connection }> {
  return request(`/api/v1/im/connection/${encodeURIComponent(id)}`);
}

export function deleteConnection(id: string): Promise<{ ok: boolean }> {
  return request(`/api/v1/im/connection/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function enableConnection(id: string): Promise<{ connection: Connection }> {
  return request(`/api/v1/im/connection/${encodeURIComponent(id)}/enable`, { method: 'POST' });
}

export function disableConnection(id: string): Promise<{ connection: Connection }> {
  return request(`/api/v1/im/connection/${encodeURIComponent(id)}/disable`, { method: 'POST' });
}

export function getQr(id: string): Promise<{ qr: string | null; pin: string | null }> {
  return request(`/api/v1/im/connection/${encodeURIComponent(id)}/qr`);
}

export function sendMessage(id: string, to: string, text: string): Promise<{ id: string }> {
  return request(`/api/v1/im/connection/${encodeURIComponent(id)}/message`, {
    method: 'POST',
    body: JSON.stringify({ to, text }),
  });
}

export function saveWebhook(
  id: string,
  url: string | null,
  token?: string | null,
): Promise<{ connection: Connection }> {
  return request(`/api/v1/im/connection/${encodeURIComponent(id)}/webhook`, {
    method: 'PUT',
    body: JSON.stringify(url == null ? { url: null } : { url, token }),
  });
}

export function saveCloud(
  id: string,
  url: string | null,
  token?: string | null,
): Promise<{ connection: Connection }> {
  return request(`/api/v1/im/connection/${encodeURIComponent(id)}/cloud`, {
    method: 'PUT',
    body: JSON.stringify(url == null ? { url: null } : { url, token }),
  });
}

export function renameConnection(id: string, name: string): Promise<{ connection: Connection }> {
  return request(`/api/v1/im/connection/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ name }),
  });
}

export type MessageDirection = 'in' | 'out';

/** Delivery state of a queued message, mirroring the backend `MessageStatus`. */
export const MESSAGE_STATUSES = ['na', 'pending', 'sent', 'failed'] as const;

export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export function isMessageStatus(value: unknown): value is MessageStatus {
  return typeof value === 'string' && (MESSAGE_STATUSES as readonly string[]).includes(value);
}

/**
 * Types the filter offers. The column is a free-form string and the backend
 * accepts anything, so this list can grow without an API change.
 */
export const MESSAGE_TYPES = [
  'text',
  'image',
  'audio',
  'video',
  'document',
  'sticker',
  'location',
  'contact',
  'unknown',
] as const;

/** `all` merges both directions into one listing. */
export type DirectionFilter = 'all' | MessageDirection;

export interface ChatMessageListItem {
  id: number;
  connectionId: string;
  channel: Channel;
  direction: MessageDirection;
  providerId: string | null;
  type: string;
  from: string;
  to: string;
  summary: string;
  timestamp: number;
  /** `na` for history that was never queued. */
  status: MessageStatus;
  /** Transport failures so far; nonzero only for a retried or failed row. */
  errorCount: number;
}

export interface ChatMessageDetail extends ChatMessageListItem {
  createdAt: number;
  lastError: string | null;
  rawIn: unknown;
  rawOut: unknown;
}

/** Filters for {@link listMessages}. Omitted fields match everything. */
export interface MessageQuery {
  direction?: DirectionFilter;
  type?: string | null;
  status?: MessageStatus | null;
  page?: number;
  limit?: number;
}

export function listMessages(
  id: string,
  query: MessageQuery = {},
): Promise<{ messages: ChatMessageListItem[]; page: number; limit: number; total: number }> {
  const params = new URLSearchParams();
  // Only send what the backend cannot default, so URLs stay short and readable.
  if (query.direction != null && query.direction !== 'all') {
    params.set('direction', query.direction);
  }
  if (query.type != null && query.type !== '') params.set('type', query.type);
  if (query.status != null) params.set('status', query.status);
  if (query.page != null && query.page > 1) params.set('page', String(query.page));
  if (query.limit != null) params.set('limit', String(query.limit));
  const suffix = params.toString();
  return request(
    `/api/v1/im/connection/${encodeURIComponent(id)}/messages${suffix === '' ? '' : `?${suffix}`}`,
  );
}

export function getMessage(id: string, messageId: number): Promise<{ message: ChatMessageDetail }> {
  return request(`/api/v1/im/connection/${encodeURIComponent(id)}/messages/${messageId}`);
}

/**
 * Debug helper: re-forward a received message's stored payload to the cloud.
 * The row is not re-queued and its status does not change.
 */
export function replayMessage(
  id: string,
  messageId: number,
): Promise<{ ok: true; messageId: string | null; name: string; userId: string }> {
  return request('/api/v1/im/replay', {
    method: 'POST',
    body: JSON.stringify({ connectionId: id, messageId }),
  });
}
