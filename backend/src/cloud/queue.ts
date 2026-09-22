/**
 * @fileoverview Durable message queue for both directions.
 *
 * `ChatMessage` rows are the queue: a row is written `pending` before any
 * network call and only the worker advances it. One `MessageQueue` per
 * connection *and* direction, so a stalled outbound drain never blocks inbound.
 *
 * Failure model:
 * - transport error -> `error_count += 1`, stays `pending`, retried later
 * - real error      -> `failed`, never resent
 * - 3 attempts, or older than an hour -> `failed`
 *
 * An offline socket is not an error: the worker simply waits for `onReady`.
 */
import type { QueuedMessage, MessageStore, MessageDirection } from '../messages';
import { QUEUE_MAX_AGE_MS, QUEUE_MAX_ATTEMPTS } from '../types';
import type { Channel } from '../channel';
import type { CloudLink } from './link';
import { logJson } from '../log';

export interface QueueSendOk {
  ok: true;
  /** Vendor id learned during delivery, when the channel returns one. */
  providerId?: string | null;
}

export interface QueueSendFail {
  ok: false;
  /** `true` when the receiver rejected it for a real reason — never retry. */
  real: boolean;
  error: string;
}

export type QueueSendResult = QueueSendOk | QueueSendFail;

/**
 * Where a queued row goes. Accessors are used instead of captured instances
 * because a session is rebuilt on every reconnect while the queue survives.
 */
export interface QueueTransport {
  /** Can this destination accept a write right now? */
  ready(): boolean;
  /** Permanent rejection of the destination: nothing queued will ever send. */
  rejected(): boolean;
  /** Register the wake signal fired when the destination becomes usable. */
  onReady(handler: () => void): void;
  send(row: QueuedMessage): Promise<QueueSendResult> | QueueSendResult;
}

/** Wake signal shared by the transports so a queue can re-arm itself. */
class ReadyEmitter {
  private readonly handlers: Array<() => void> = [];

  onReady(handler: () => void): void {
    this.handlers.push(handler);
  }

  /** The destination became usable; drain whatever is waiting. */
  notifyReady(): void {
    for (const handler of [...this.handlers]) {
      try {
        handler();
      } catch (error) {
        console.warn('[companion][queue] ready handler failed', error);
      }
    }
  }
}

export interface MessageQueueOptions {
  connectionId: string;
  direction: MessageDirection;
  messages: MessageStore;
  transport: QueueTransport;
}

export class MessageQueue {
  private readonly connectionId: string;
  private readonly direction: MessageDirection;
  private readonly messages: MessageStore;
  private readonly transport: QueueTransport;
  private draining = false;
  private stopped = false;
  /** A kick that arrived mid-drain; one extra pass instead of a backlog. */
  private again = false;

  constructor(options: MessageQueueOptions) {
    this.connectionId = options.connectionId;
    this.direction = options.direction;
    this.messages = options.messages;
    this.transport = options.transport;
    this.transport.onReady(() => this.kick());
  }

  /** Fire-and-forget: extra kicks while draining collapse into one more pass. */
  kick(): void {
    if (this.stopped) return;
    if (this.draining) {
      this.again = true;
      return;
    }
    void this.drain().catch((error: unknown) => {
      console.warn('[companion][queue] drain failed', this.connectionId, this.direction, error);
    });
  }

  stop(): void {
    this.stopped = true;
  }

  /** The destination is gone for good; everything queued for it is dead. */
  failAllPending(reason: string): number {
    try {
      return this.messages.failAllPending(this.connectionId, this.direction, reason);
    } catch (error) {
      console.error('[companion][queue][error] failAllPending', this.connectionId, error);
      return 0;
    }
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      do {
        this.again = false;
        await this.drainOnce();
      } while (this.again && !this.stopped);
    } finally {
      this.draining = false;
    }
  }

  private async drainOnce(): Promise<void> {
    while (!this.stopped) {
      if (this.transport.rejected()) {
        this.failAllPending('link rejected');
        return;
      }
      if (!this.transport.ready()) return;
      const row = this.messages.nextPending(this.connectionId, this.direction);
      if (row == null) return;
      if (Date.now() - row.createdAt > QUEUE_MAX_AGE_MS) {
        this.messages.markFailed(row.id, 'expired');
        continue;
      }

      let result: QueueSendResult;
      try {
        result = await this.transport.send(row);
      } catch (error) {
        // A throw escaping the transport is by definition not a receiver verdict.
        result = { ok: false, real: false, error: errorText(error) };
      }

      if (result.ok) {
        this.messages.markSent(row.id, result.providerId);
        logJson('outgoing', 'websocket', `queue.sent.${this.direction}`, {
          connectionId: this.connectionId,
          messageId: row.messageId,
        });
        continue;
      }

      if (result.real) {
        this.messages.markFailed(row.id, result.error);
        logJson('outgoing', 'websocket', `queue.failed.${this.direction}`, {
          connectionId: this.connectionId,
          messageId: row.messageId,
          error: result.error,
        });
        continue;
      }

      const attempts = this.messages.markRetry(row.id, result.error);
      if (attempts >= QUEUE_MAX_ATTEMPTS) {
        this.messages.markFailed(row.id, result.error);
      }
      logJson('outgoing', 'websocket', `queue.retry.${this.direction}`, {
        connectionId: this.connectionId,
        messageId: row.messageId,
        attempts,
        error: result.error,
      });
      // The transport is unhealthy: stop rather than burn the remaining attempts.
      return;
    }
  }
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Numeric status carried by a structured vendor rejection (Boom or a raw body). */
function statusOf(value: unknown): number | null {
  if (value == null || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  for (const key of ['statusCode', 'status', 'status_code']) {
    const raw = rec[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  }
  const output = rec.output;
  if (output != null && typeof output === 'object') return statusOf(output);
  return null;
}

function codeOf(value: unknown): string | null {
  if (value == null || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  for (const key of ['code', 'errorCode']) {
    const raw = rec[key];
    if (typeof raw === 'string' && raw !== '') return raw;
  }
  if (rec.data != null) return codeOf(rec.data);
  return null;
}

const TRANSPORT_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND']);

/**
 * Distinguishes "the receiver said no" from "we could not reach the receiver".
 *
 * Only structured evidence counts as real: a Boom-style `output.statusCode`, a
 * numeric HTTP status, or an error `code`. Anything else — not connected, socket
 * closed, timeout, DNS — is transport, so it is retried instead of being
 * dropped as a permanent failure.
 */
export function classifyVendorError(error: unknown): 'real' | 'transport' {
  const status = statusOf(error);
  if (status != null) {
    // A 4xx/5xx from the vendor API is a verdict; an odd non-HTTP status is not.
    return status >= 400 && status <= 599 ? 'real' : 'transport';
  }
  const code = (codeOf(error) ?? '').toUpperCase();
  if (code !== '' && !TRANSPORT_CODES.has(code)) return 'real';
  return 'transport';
}

/**
 * Rebuilds the vendor callback the cloud would have received in real time. Only
 * message-bearing events are stored, so whatsapp is always a `notify` upsert.
 */
export function eventFor(channel: Channel, row: QueuedMessage): { name: string; data: unknown } {
  if (channel === 'line') return { name: 'message', data: row.rawIn };
  return { name: 'messages.upsert', data: { messages: [row.rawIn], type: 'notify' } };
}

/** Inbound: forwards a stored vendor payload to the cloud as an `event` frame. */
export class CloudEventTransport extends ReadyEmitter implements QueueTransport {
  constructor(
    private readonly channel: Channel,
    private readonly link: () => CloudLink | undefined,
  ) {
    super();
  }

  ready(): boolean {
    return this.link()?.isOpen() === true;
  }

  rejected(): boolean {
    return this.link()?.state() === 'rejected';
  }

  send(row: QueuedMessage): QueueSendResult {
    const link = this.link();
    if (link == null || !link.isOpen()) {
      return { ok: false, real: false, error: 'link not open' };
    }
    const { name, data } = eventFor(this.channel, row);
    if (!link.sendEvent(name, data, row.from)) {
      return { ok: false, real: false, error: 'link write failed' };
    }
    return { ok: true };
  }
}

/** Outbound raw payload recorded when the send was queued. */
export type OutboundPayload =
  | { kind: 'invoke'; name: string; args: unknown[] }
  | { kind: 'sendText'; to: string; text: string };

export function outboundOf(row: QueuedMessage): OutboundPayload | null {
  const raw = row.rawOut;
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.kind === 'invoke' && typeof rec.name === 'string' && Array.isArray(rec.args)) {
    return { kind: 'invoke', name: rec.name, args: rec.args };
  }
  if (rec.kind === 'sendText' && typeof rec.to === 'string' && typeof rec.text === 'string') {
    return { kind: 'sendText', to: rec.to, text: rec.text };
  }
  return null;
}

/** The vendor id a channel returns from a successful send, when it returns one. */
export function providerIdOf(value: unknown): string | null {
  if (value == null || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.messageId === 'string' && rec.messageId !== '') return rec.messageId;
  if (typeof rec.id === 'string' && rec.id !== '') return rec.id;
  const key = rec.key;
  if (key != null && typeof key === 'object') {
    const id = (key as { id?: unknown }).id;
    if (typeof id === 'string' && id !== '') return id;
  }
  return null;
}

export interface OutboundSession {
  isConnected(): boolean;
  invoke(name: string, args: unknown[]): Promise<unknown>;
  sendText(to: string, text: string): Promise<{ id: string }>;
}

/** Outbound: delivers a queued send to the phone/LINE session. */
export class DeviceSendTransport extends ReadyEmitter implements QueueTransport {
  constructor(
    private readonly channel: Channel,
    private readonly session: () => OutboundSession | undefined,
  ) {
    super();
  }

  ready(): boolean {
    return this.session()?.isConnected() === true;
  }

  /** A revoked session (logout/replaced) is state, not a terminal verdict. */
  rejected(): boolean {
    return false;
  }

  async send(row: QueuedMessage): Promise<QueueSendResult> {
    const session = this.session();
    if (session == null || !session.isConnected()) {
      return { ok: false, real: false, error: 'not connected' };
    }
    const payload = outboundOf(row);
    if (payload == null) {
      // A queued row we cannot interpret will never become sendable.
      return { ok: false, real: true, error: 'invalid queued payload' };
    }
    try {
      if (payload.kind === 'invoke') {
        const result = await session.invoke(payload.name, payload.args);
        return { ok: true, providerId: providerIdOf(result) };
      }
      const sent = await session.sendText(payload.to, payload.text);
      return { ok: true, providerId: sent.id === '' ? null : sent.id };
    } catch (error) {
      return { ok: false, real: classifyVendorError(error) === 'real', error: errorText(error) };
    }
  }
}
