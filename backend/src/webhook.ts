import { WEBHOOK_RETRIES, WEBHOOK_TIMEOUT_MS } from './types';
import { logJson } from './log';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** POST JSON to a webhook. Fire-and-forget callers should not await unless testing. */
export async function postWebhook(
  url: string,
  body: unknown,
  fetchFn: FetchLike = fetch,
  token?: string | null,
): Promise<boolean> {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token != null && token !== '') headers.Authorization = `Bearer ${token}`;
  for (let attempt = 0; attempt < WEBHOOK_RETRIES; attempt += 1) {
    try {
      logJson('outgoing', 'http', `POST ${url} attempt=${attempt + 1}`, body);
      const response = await fetchFn(url, {
        method: 'POST',
        headers,
        body: payload,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      let responseJson: unknown = null;
      if ((response.headers.get('content-type') ?? '').includes('application/json')) {
        try {
          responseJson = await response.clone().json();
        } catch {
          responseJson = '[invalid JSON response]';
        }
      }
      logJson('incoming', 'http', `POST ${url} ${response.status}`, responseJson);
      if (response.ok) return true;
    } catch {
      /* retry */
    }
    if (attempt < WEBHOOK_RETRIES - 1) await wait(200 * 2 ** attempt);
  }
  return false;
}

export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isWsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
  } catch {
    return false;
  }
}
