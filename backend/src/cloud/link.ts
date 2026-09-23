import {
  allowedInvoke,
  parseFrame,
  stringifyFrame,
  TERMINAL_CLOSE_CODE,
  type CloudFrame,
} from './protocol';
import { logJson } from '../log';
import type { ChannelSession } from '../channel';
import type { ChannelProfile } from '../types';
import type { CloudStatus } from '../types';

const PING_MS = 25_000;
const HELLO_MS = 10_000;
const WS_OPEN = 1;

/**
 * Pre-open refusals tolerated before the link is declared permanently rejected.
 *
 * An SM3 restart refuses the handshake (401) until its datastore is up, so the
 * first few dials can fail through no fault of the token. With the 1s→30s backoff
 * this spans roughly a minute — long enough to outlast a restart, short enough
 * that a genuinely bad token still stops instead of hot-looping.
 */
const REFUSAL_GRACE_ATTEMPTS = 5;

/** Bun's `new WebSocket(url, options)` takes handshake headers; DOM lib does not. */
type WsLike = Pick<WebSocket, 'readyState' | 'send' | 'close' | 'addEventListener'>;

export type CloudLinkHooks = {
  connectionId: string;
  channel: string;
  url: string;
  token: string;
  account: () => string | undefined;
  /**
   * Everything the channel knows about the paired account, sent alongside
   * `account` on `hello` so the cloud can fill its row (phone/mid → channelId,
   * phone → phone, push name → name). Omitted when the channel has nothing yet.
   */
  profile?: () => ChannelProfile | undefined;
  session: () => ChannelSession | undefined;
  /** Test seam: dial something other than the real global WebSocket. */
  socketFactory?: (url: string, headers: Record<string, string>) => WsLike;
  /**
   * Called when the server rejects this socket terminally (4401). The link stops
   * instead of backing off, because retrying a rejected token is a hot loop.
   */
  onTerminalClose?: (code: number) => void;
  /**
   * The link just became usable (server replied `hello`). The inbound queue
   * drains on this instead of polling, since a frame sent earlier is dropped.
   */
  onOpened?: () => void;
  /**
   * Media presign endpoint the server advertised on its `hello`, or '' when it
   * advertised none. The manager records it so the channel can upload media
   * directly (1B) instead of shipping bytes in the frame (1A).
   */
  onUploadEndpoint?: (url: string) => void;
  /**
   * Queue an `invoke` instead of running it inline. Returning non-null means the
   * call was accepted for later delivery and that value is the `result` data;
   * returning null keeps the existing inline path (and its NOT_CONNECTED check).
   */
  queueSend?: (name: string, args: unknown[]) => { data: unknown } | null;
};

export class CloudLink {
  private ws: WsLike | null = null;
  private stopped = false;
  private backoffMs = 1_000;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private opened = false;
  /** True once the server said `4401`; the only state that needs a human. */
  private rejected = false;
  /** True while the upgrade is being refused and we are still giving it a chance. */
  private refused = false;
  /** Consecutive pre-open refusals; a restart usually clears within a couple of tries. */
  private refusals = 0;

  private readonly hooks: CloudLinkHooks;

  constructor(hooks: CloudLinkHooks) {
    this.hooks = hooks;
  }

  start(): void {
    this.stopped = false;
    this.rejected = false;
    this.refused = false;
    this.refusals = 0;
    this.connect();
  }

  /**
   * Live link state. `connecting` and `retrying` are split because "first dial"
   * and "we were up and lost it" read very differently in a dashboard, and the
   * socket-level `readyState` alone cannot tell them apart.
   */
  state(): CloudStatus {
    if (this.rejected) return 'rejected';
    // A refusal still inside the grace window is a retry, not a verdict.
    if (this.refused) return 'retrying';
    if (this.isOpen()) return 'connected';
    if (this.retryTimer != null) return 'retrying';
    return 'connecting';
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    this.opened = false;
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
  }

  sendEvent(name: string, data: unknown, userId?: string): boolean {
    if (!this.isOpen()) return false;
    return this.send({
      v: 1,
      type: 'event',
      connectionId: this.hooks.connectionId,
      channel: this.hooks.channel,
      name,
      ...(userId != null && userId !== '' ? { userId } : {}),
      data,
    });
  }

  /** True only while the socket is open *and* the server has acknowledged us. */
  isOpen(): boolean {
    return this.opened && this.ws != null && this.ws.readyState === WS_OPEN;
  }

  private connect(): void {
    if (this.stopped) return;
    this.clearTimers();
    try {
      const headers = { Authorization: `Bearer ${this.hooks.token}` };
      const Ctor = WebSocket as unknown as new (
        url: string,
        options: { headers: Record<string, string> },
      ) => WsLike;
      this.ws =
        this.hooks.socketFactory != null
          ? this.hooks.socketFactory(this.hooks.url, headers)
          : new Ctor(this.hooks.url, { headers });
    } catch (error) {
      console.warn('[companion][cloud] connect failed', this.hooks.connectionId, error);
      this.scheduleReconnect();
      return;
    }
    const ws = this.ws;
    this.helloTimer = setTimeout(() => {
      if (!this.opened) {
        try {
          ws.close(4408, 'hello timeout');
        } catch {
          /* ignore */
        }
      }
    }, HELLO_MS);
    ws.addEventListener('open', () => {
      if (this.ws !== ws || this.stopped) return;
      const account = this.hooks.account();
      const profile = this.hooks.profile?.();
      this.send({
        v: 1,
        type: 'hello',
        connectionId: this.hooks.connectionId,
        channel: this.hooks.channel,
        data: {
          ...(account != null && account !== '' ? { account } : {}),
          ...(profile != null ? { profile } : {}),
        },
      });
    });
    ws.addEventListener('message', (event) => {
      if (this.ws !== ws || this.stopped) return;
      void this.onMessage(String(event.data));
    });
    ws.addEventListener('close', (event) => {
      if (this.ws !== ws) return;
      const code = (event as { code?: number }).code ?? 0;
      this.opened = false;
      this.ws = null;
      this.clearTimers();
      // A terminal rejection is not a transport blip: stop and surface it instead
      // of looping on a token the server will keep refusing.
      if (code === TERMINAL_CLOSE_CODE) {
        this.stopped = true;
        this.rejected = true;
        console.warn('[companion][cloud] rejected by server, not retrying', this.hooks.connectionId, code);
        this.hooks.onTerminalClose?.(code);
        return;
      }
      this.scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      // Bun fires `error` (not `close`) when the handshake is refused, so an HTTP
      // 401 lands here. A 401 is ambiguous: the token may be genuinely bad, or the
      // server may simply not be ready yet (an SM3 restart answers 401 until its
      // datastore is up). Latch only after the refusals outlast a restart, so a
      // transient one cannot park the link until a human re-saves it.
      if (this.ws !== ws || this.stopped) return;
      if (this.opened) {
        // The socket was live and then errored; the close handler will reconnect.
        return;
      }
      this.opened = false;
      this.ws = null;
      this.clearTimers();
      this.refusals += 1;
      if (this.refusals <= REFUSAL_GRACE_ATTEMPTS) {
        this.refused = true;
        console.warn('[companion][cloud] upgrade refused, retrying', this.hooks.connectionId, this.refusals);
        this.scheduleReconnect();
        return;
      }
      this.refused = false;
      this.rejected = true;
      console.warn('[companion][cloud] upgrade refused, not retrying', this.hooks.connectionId);
      this.hooks.onTerminalClose?.(0);
    });
  }

  private async onMessage(raw: string): Promise<void> {
    const frame = parseFrame(raw);
    if (frame == null) return;
    if (frame.type === 'hello') {
      this.opened = true;
      this.backoffMs = 1_000;
      this.refusals = 0;
      this.refused = false;
      if (this.helloTimer != null) {
        clearTimeout(this.helloTimer);
        this.helloTimer = null;
      }
      this.startPing();
      // The ack may carry the media presign endpoint. Reported on every hello so
      // a server that moves it (or starts advertising it) is picked up on the
      // next reconnect; '' means the frame carried none and media stays inline.
      this.hooks.onUploadEndpoint?.(uploadEndpointFrom(frame.data));
      this.hooks.onOpened?.();
      return;
    }
    if (frame.type === 'ping') {
      this.send({ v: 1, type: 'pong' });
      return;
    }
    if (frame.type === 'pong') return;
    if (frame.type === 'invoke') {
      await this.onInvoke(frame);
    }
  }

  private async onInvoke(frame: CloudFrame): Promise<void> {
    const id = frame.id ?? '';
    const name = frame.name ?? '';
    const channel = this.hooks.channel;
    const connectionId = this.hooks.connectionId;
    const reply = (out: CloudFrame) => this.send({ ...out, id, connectionId, channel });
    if (!allowedInvoke(channel, name)) {
      reply({
        v: 1,
        type: 'error',
        error: { code: 'METHOD_NOT_ALLOWED', message: `method ${name} is not allowed on ${channel}` },
      });
      return;
    }
    const args = invokeArgs(frame.data);
    // Queueable sends are persisted and acked before the phone is touched, so a
    // cloud reply never depends on the device being online. Non-queueable
    // methods (presence, read receipts) still run inline below.
    const queued = this.hooks.queueSend?.(name, args);
    if (queued != null) {
      reply({ v: 1, type: 'result', name, data: queued.data });
      return;
    }
    const session = this.hooks.session();
    if (session == null || !session.isConnected()) {
      reply({
        v: 1,
        type: 'error',
        error: { code: 'NOT_CONNECTED', message: `Connection ${connectionId} is not connected` },
      });
      return;
    }
    try {
      const data = await session.invoke(name, args);
      reply({ v: 1, type: 'result', name, data });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logJson('incoming', 'websocket', `cloud.invoke.error ${name}`, { connectionId, message });
      reply({
        v: 1,
        type: 'error',
        error: { code: 'INVOKE_FAILED', message },
      });
    }
  }

  private send(frame: CloudFrame): boolean {
    if (this.ws == null || this.ws.readyState !== WS_OPEN) return false;
    const payload = stringifyFrame(frame);
    logJson('outgoing', 'websocket', `cloud.${frame.type}`, {
      connectionId: this.hooks.connectionId,
      type: frame.type,
      name: frame.name ?? null,
    });
    try {
      this.ws.send(payload);
      return true;
    } catch (error) {
      // A socket that dies between the readyState check and the write would
      // otherwise throw out of a queue drain and strand the row.
      console.warn('[companion][cloud] send failed', this.hooks.connectionId, error);
      return false;
    }
  }

  private startPing(): void {
    if (this.pingTimer != null) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      this.send({ v: 1, type: 'ping' });
    }, PING_MS);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private clearTimers(): void {
    if (this.pingTimer != null) clearInterval(this.pingTimer);
    if (this.retryTimer != null) clearTimeout(this.retryTimer);
    if (this.helloTimer != null) clearTimeout(this.helloTimer);
    this.pingTimer = null;
    this.retryTimer = null;
    this.helloTimer = null;
  }
}

function invokeArgs(data: unknown): unknown[] {
  if (data != null && typeof data === 'object' && !Array.isArray(data)) {
    const args = (data as { args?: unknown }).args;
    if (Array.isArray(args)) return args;
  }
  return [];
}

/**
 * The media presign endpoint a `hello` ack advertised, or '' when it carried
 * none. Reads `data.upload.url`; anything else (an older server, a proxy that
 * rewrote the payload) is simply "no endpoint", which leaves the link on 1A.
 */
export function uploadEndpointFrom(data: unknown): string {
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return '';
  const upload = (data as { upload?: unknown }).upload;
  if (upload == null || typeof upload !== 'object' || Array.isArray(upload)) return '';
  const url = (upload as { url?: unknown }).url;
  return typeof url === 'string' ? url.trim() : '';
}
