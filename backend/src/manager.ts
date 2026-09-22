import type { Channel, ChannelFactory, ChannelSession } from './channel';
import { linejsFactory } from './line';
import { authDir } from './paths';
import { ConnectionStore, newConnectionId } from './store';
import { MessageStore, parseLimit, parsePage, summarize, type MessageQuery } from './messages';
import {
  cloudRejectedHint,
  cloudRejectedMessage,
  HttpError,
  MAX_RESTARTS,
  pruneDisconnectAt,
  QUEUE_MAX_AGE_MS,
  recordDisconnectAt,
  type CloudStatus,
  type ConnectionStatus,
  type ConnectionView,
  type DisconnectReasonName,
} from './types';
import { compactProfile, type ChannelProfile } from './types';
import { baileysFactory } from './whatsapp';
import { postWebhook, type FetchLike } from './webhook';
import { CloudLink } from './cloud/link';
import {
  CloudEventTransport,
  DeviceSendTransport,
  eventFor,
  MessageQueue,
  type OutboundPayload,
} from './cloud/queue';

interface Live {
  session: ChannelSession;
  status: ConnectionStatus;
  qr: string | null;
  pin: string | null;
  restarts: number;
}

/** Per-connection queue pair. Inbound and outbound never block each other. */
interface ConnectionQueues {
  inbound?: MessageQueue;
  cloudTransport?: CloudEventTransport;
  outbound?: MessageQueue;
  deviceTransport?: DeviceSendTransport;
}

/** Methods whose effects are messages and therefore belong in the durable queue. */
const QUEUEABLE_SENDS: Record<Channel, ReadonlySet<string>> = {
  whatsapp: new Set(['sendMessage']),
  line: new Set(['sendCompactMessage']),
};

function isQueueableSend(channel: Channel, name: string): boolean {
  return QUEUEABLE_SENDS[channel].has(name);
}

/**
 * Vendor events that carry a message. These are persisted by the inbound queue
 * and must not also be forwarded live, or a connected link would see them twice.
 */
function isMessageEvent(name: string): boolean {
  return name === 'messages.upsert' || name === 'message';
}

/** Text carried by a queueable send payload, when the channel sends text. */
function invokeText(args: unknown[]): string | null {
  const content = args[1];
  if (typeof content === 'string') return content;
  if (content != null && typeof content === 'object') {
    const text = (content as { text?: unknown }).text;
    if (typeof text === 'string' && text !== '') return text;
  }
  return null;
}

/**
 * The `result` data for a queued send. WhatsApp callers read `key.id`, so a
 * queued message answers with the same shape carrying the Companion-generated id.
 */
function queuedAck(channel: Channel, messageId: string, to: string): unknown {
  if (channel === 'line') return { messageId };
  return { key: { id: messageId, remoteJid: to } };
}

export class ConnectionManager {
  private readonly live = new Map<string, Live>();
  private readonly clouds = new Map<string, CloudLink>();
  private readonly queues = new Map<string, ConnectionQueues>();

  constructor(
    readonly store: ConnectionStore,
    readonly factory: ChannelFactory = baileysFactory,
    readonly fetchFn: FetchLike = fetch,
    readonly lineFactory: ChannelFactory = linejsFactory,
    readonly messages: MessageStore = MessageStore.memory(),
  ) {}

  async restoreEnabled(): Promise<void> {
    for (const row of this.store.list()) {
      if (!row.enabled) continue;
      try {
        await this.start(row.id, { restore: true });
      } catch (error) {
        console.warn('[companion] restore failed', row.id, error);
        this.store.saveMeta(row.id, {
          ...this.store.meta(row.id),
          lastError: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  views(): ConnectionView[] {
    return this.store.list().map((row) => this.view(row.id));
  }

  view(id: string): ConnectionView {
    const row = this.store.require(id);
    const meta = this.store.meta(id);
    const live = this.live.get(id);
    const status: ConnectionStatus = row.enabled
      ? (live?.status ?? 'disconnected')
      : 'disabled';
    const uptimeMs =
      status === 'connected' && meta.connectedAt != null ? Date.now() - meta.connectedAt : undefined;
    const cloud = this.cloudState(id, row, meta.cloudRejectedAt ?? null);
    return {
      id,
      name: row.name,
      channel: row.channel,
      status,
      phone: live?.session.account() ?? meta.phone,
      user: live?.session.user() ?? meta.user,
      enabled: row.enabled,
      webhookUrl: row.webhookUrl,
      webhookToken: row.webhookToken,
      cloudUrl: row.cloudUrl,
      cloudToken: row.cloudToken,
      cloudStatus: cloud.status,
      cloudError: cloud.error,
      uptimeMs,
      incomingCount: meta.incomingCount,
      outgoingCount: meta.outgoingCount,
      disconnectCount: pruneDisconnectAt(meta.disconnectAt).length,
      pin: live?.pin ?? live?.session.pin() ?? null,
      lastError: meta.lastError ?? undefined,
    };
  }

  /**
   * The live link wins when it exists (it knows about a retry in flight), and the
   * stored rejection covers the case where the process restarted after a `4401`
   * and correctly declined to dial at all.
   */
  private cloudState(
    id: string,
    row: { cloudUrl: string | null; cloudToken: string | null },
    rejectedAt: number | null,
  ): { status: CloudStatus; error?: string } {
    const configured =
      row.cloudUrl != null && row.cloudUrl !== '' && row.cloudToken != null && row.cloudToken !== '';
    if (!configured) return { status: 'off' };
    const link = this.clouds.get(id);
    if (link != null) {
      const status = link.state();
      return status === 'rejected' ? { status, error: cloudRejectedHint } : { status };
    }
    if (rejectedAt != null) return { status: 'rejected', error: cloudRejectedHint };
    // Configured but no live link: the phone itself is off, so there is nothing
    // to keep on the wire yet.
    return { status: 'off' };
  }

  qr(id: string): string | null {
    this.store.require(id);
    return this.live.get(id)?.qr ?? this.live.get(id)?.session.qr() ?? null;
  }

  pin(id: string): string | null {
    this.store.require(id);
    return this.live.get(id)?.pin ?? this.live.get(id)?.session.pin() ?? null;
  }

  async create(requestedId?: string, name?: string, channel: Channel = 'whatsapp'): Promise<ConnectionView> {
    const id = requestedId == null || requestedId === '' ? newConnectionId(channel) : requestedId;
    this.store.add(id, null, name, channel);
    try {
      await this.start(id, { restore: false });
    } catch (error) {
      this.markError(id, error);
    }
    return this.view(id);
  }

  async enable(id: string): Promise<ConnectionView> {
    this.store.require(id);
    this.store.update(id, { enabled: true });
    await this.start(id, { restore: true });
    this.startCloud(id);
    return this.view(id);
  }

  async disable(id: string): Promise<ConnectionView> {
    this.store.require(id);
    this.stopCloud(id);
    await this.stop(id, { logout: false });
    this.store.update(id, { enabled: false });
    this.store.saveMeta(id, { ...this.store.meta(id), connectedAt: null });
    return this.view(id);
  }

  async remove(id: string): Promise<void> {
    this.store.require(id);
    this.stopCloud(id);
    this.dropQueues(id);
    await this.stop(id, { logout: true });
    this.messages.deleteForConnection(id);
    this.store.remove(id);
    this.live.delete(id);
  }

  async setWebhook(id: string, url: string | null, token: string | null): Promise<ConnectionView> {
    // The PUT body is the full state: clearing the url clears the token too.
    const nextToken = url == null || token == null || token === '' ? null : token;
    this.store.update(id, { webhookUrl: url, webhookToken: nextToken });
    return this.view(id);
  }

  async setCloud(id: string, url: string | null, token: string | null): Promise<ConnectionView> {
    this.store.require(id);
    this.store.update(id, { cloudUrl: url, cloudToken: url == null ? null : token });
    // Saving is the human's answer to a rejection: make the link dialable again.
    this.store.saveMeta(id, { ...this.store.meta(id), cloudRejectedAt: null });
    this.stopCloud(id);
    if (url != null && token != null && token !== '') this.startCloud(id);
    return this.view(id);
  }

  async rename(id: string, name: string): Promise<ConnectionView> {
    this.store.require(id);
    const trimmed = name.trim();
    if (trimmed === '') throw new HttpError(400, 'INVALID_PARAM', 'name is required');
    if (trimmed.length > 64) throw new HttpError(400, 'INVALID_PARAM', 'name must be 1–64 characters');
    this.store.update(id, { name: trimmed });
    return this.view(id);
  }

  async send(id: string, to: string, text: string): Promise<{ id: string; to: string; status: 'pending' }> {
    const row = this.store.require(id);
    const live = this.live.get(id);
    const meta = this.store.meta(id);
    const messageId = Bun.randomUUIDv7();
    this.store.saveMeta(id, { ...meta, outgoingCount: meta.outgoingCount + 1 });
    this.messages.insert({
      connectionId: id,
      channel: row.channel,
      direction: 'out',
      messageId,
      type: 'text',
      fromId: live?.session.account() ?? meta.phone ?? '',
      toId: to,
      summary: summarize(text),
      timestamp: Date.now(),
      status: 'pending',
      rawIn: { to, text },
      rawOut: { kind: 'sendText', to, text } satisfies OutboundPayload,
    });
    this.outboundQueue(id, row.channel).kick();
    return { id: messageId, to, status: 'pending' };
  }

  /**
   * Queues a cloud `invoke` send and returns the `result` data to ack it with.
   * Returns null for methods that are not messages, so the link runs them inline.
   */
  private queueSend(id: string, channel: Channel, name: string, args: unknown[]): { data: unknown } | null {
    if (!isQueueableSend(channel, name)) return null;
    const to = typeof args[0] === 'string' ? args[0] : '';
    const text = invokeText(args);
    const messageId = Bun.randomUUIDv7();
    try {
      const meta = this.store.meta(id);
      // A cloud reply is a real outbound message, so it counts exactly like the
      // local REST `send` above: the Sent counter is a lifetime total of every
      // message that goes out, not only the dashboard-originated ones. Counted
      // before the insert so the inline fallback (insert failed, link still
      // sends it) cannot slip past the counter.
      this.store.saveMeta(id, { ...meta, outgoingCount: meta.outgoingCount + 1 });
      this.messages.insert({
        connectionId: id,
        channel,
        direction: 'out',
        messageId,
        type: text == null ? 'unknown' : 'text',
        fromId: this.live.get(id)?.session.account() ?? meta.phone ?? '',
        toId: to,
        summary: summarize(text ?? `[${name}]`),
        timestamp: Date.now(),
        status: 'pending',
        rawIn: { name, args },
        rawOut: { kind: 'invoke', name, args } satisfies OutboundPayload,
      });
    } catch (error) {
      // The ack is what the cloud waits on; a failed insert must not become a
      // silent success, so let the link report the invoke as failed.
      console.error('[companion][queue][error] Failed to enqueue cloud send', error);
      return null;
    }
    this.outboundQueue(id, channel).kick();
    return { data: queuedAck(channel, messageId, to) };
  }

  /** Outbound worker for a connection, created on first use and kept across reconnects. */
  private outboundQueue(id: string, channel: Channel): MessageQueue {
    const entry = this.queues.get(id) ?? {};
    if (entry.outbound == null) {
      const transport = new DeviceSendTransport(channel, () => this.live.get(id)?.session);
      entry.deviceTransport = transport;
      entry.outbound = new MessageQueue({
        connectionId: id,
        direction: 'out',
        messages: this.messages,
        transport,
      });
      this.queues.set(id, entry);
    }
    return entry.outbound;
  }

  /**
   * Nudge both queues and retire anything that waited too long. Wakes exist for
   * the common cases; this is the safety net for a missed signal.
   */
  tickQueue(now = Date.now()): void {
    try {
      this.messages.expireStale(QUEUE_MAX_AGE_MS, now);
    } catch (error) {
      console.warn('[companion] queue expiry failed', error);
    }
    for (const entry of this.queues.values()) {
      entry.inbound?.kick();
      entry.outbound?.kick();
    }
  }

  listMessages(id: string, query: MessageQuery, pageRaw?: string, limitRaw?: string) {
    this.store.require(id);
    return this.messages.list(id, query, parsePage(pageRaw), parseLimit(limitRaw));
  }

  getMessage(id: string, messageId: number) {
    this.store.require(id);
    const message = this.messages.get(id, messageId);
    if (message == null) throw new HttpError(404, 'NOT_FOUND', `Message ${messageId} not found`);
    return message;
  }

  /**
   * Debug-only: re-frames a stored received message exactly as it was forwarded
   * the first time, straight onto the open link. The row's status, error_count
   * and last_error are untouched, so this is not a retry — the cloud simply
   * receives the same event again.
   */
  replayMessage(
    id: string,
    messageId: number,
  ): { messageId: string | null; name: string; userId: string } {
    this.store.require(id);
    const row = this.messages.getQueued(id, messageId);
    if (row == null) throw new HttpError(404, 'NOT_FOUND', `Message ${messageId} not found`);
    if (row.direction !== 'in') {
      throw new HttpError(409, 'INVALID_STATE', 'Only received messages are forwarded to the cloud');
    }
    if (row.rawIn == null) {
      throw new HttpError(409, 'INVALID_STATE', 'This message has no stored payload to replay');
    }
    const link = this.clouds.get(id);
    if (link == null || !link.isOpen()) {
      throw new HttpError(409, 'NOT_CONNECTED', `Connection ${id} has no open cloud link`);
    }
    const { name, data } = eventFor(row.channel, row);
    if (!link.sendEvent(name, data, row.from)) {
      throw new HttpError(409, 'NOT_CONNECTED', `Connection ${id} has no open cloud link`);
    }
    return { messageId: row.messageId, name, userId: row.from };
  }

  private factoryFor(channel: Channel): ChannelFactory {
    return channel === 'line' ? this.lineFactory : this.factory;
  }

  private hooksFor(id: string) {
    const onInboundMessage = (msg: {
      id: string;
      from: string;
      to: string;
      text?: string;
      type: string;
      timestamp: number;
      raw?: unknown;
    }) => {
      try {
        const row = this.store.get(id);
        if (row == null) return;
        const meta = this.store.meta(id);
        this.store.saveMeta(id, { ...meta, incomingCount: meta.incomingCount + 1 });
        const summary = msg.text == null || msg.text === '' ? `[${msg.type}]` : msg.text;
        const webhookBody = {
          connectionId: id,
          channel: row.channel,
          id: msg.id,
          from: msg.from,
          to: msg.to,
          text: msg.text ?? '',
          timestamp: msg.timestamp,
          type: msg.type,
        };
        // The cloud pipe is a durable queue, so the row is written pending and the
        // worker forwards it when the link is up. Without a configured link the
        // row is history only, exactly like the old dropped frame.
        const queueable =
          row.cloudUrl != null && row.cloudUrl !== '' && row.cloudToken != null && row.cloudToken !== '';
        this.messages.insert({
          connectionId: id,
          channel: row.channel,
          direction: 'in',
          messageId: msg.id === '' ? Bun.randomUUIDv7() : msg.id,
          providerId: msg.id === '' ? undefined : msg.id,
          type: msg.type,
          fromId: msg.from,
          toId: msg.to,
          summary: summarize(summary),
          timestamp: msg.timestamp > 0 ? msg.timestamp : Date.now(),
          status: queueable ? 'pending' : 'na',
          rawIn: msg.raw ?? { id: msg.id, from: msg.from, to: msg.to, text: msg.text, timestamp: msg.timestamp },
          rawOut: row.webhookUrl != null && row.webhookUrl !== '' ? webhookBody : null,
        });
        if (queueable) this.queues.get(id)?.inbound?.kick();
        if (row.webhookUrl == null || row.webhookUrl === '') return;
        void postWebhook(row.webhookUrl, webhookBody, this.fetchFn, row.webhookToken).then((ok) => {
          if (!ok) console.warn('[companion] webhook failed', id);
        });
      } catch (error) {
        console.error('[companion][message][error] Failed to persist inbound message', error);
      }
    };

    return {
      onQr: (qr: string) => {
        const live = this.live.get(id);
        if (live == null) return;
        live.qr = qr;
        live.status = 'qr';
      },
      onPin: (pin: string) => {
        const live = this.live.get(id);
        if (live == null) return;
        live.pin = pin;
        live.status = 'qr';
      },
      onConnected: (account?: string, user?: string) => {
        const live = this.live.get(id);
        if (live == null) return;
        live.qr = null;
        live.pin = null;
        live.status = 'connected';
        live.restarts = 0;
        const meta = this.store.meta(id);
        this.store.saveMeta(id, {
          ...meta,
          phone: account ?? meta.phone,
          user: user ?? meta.user,
          connectedAt: Date.now(),
          lastError: null,
        });
        // Anything queued while the phone was offline can go out now.
        this.queues.get(id)?.deviceTransport?.notifyReady();
      },
      onDisconnected: (reason: DisconnectReasonName) => {
        void this.handleDisconnect(id, reason);
      },
      onInboundMessage,
      onInboundText: (msg: {
        id: string;
        from: string;
        to: string;
        text: string;
        timestamp: number;
        raw?: unknown;
      }) => {
        onInboundMessage({ ...msg, type: 'text' });
      },
      onVendorEvent: (name: string, data: unknown, userId?: string) => {
        // Message events are owned by the durable inbound queue: the same payload
        // is stored here and forwarded when the link is up. Forwarding it live too
        // would double-send on a connected link.
        if (isMessageEvent(name)) return;
        this.clouds.get(id)?.sendEvent(name, data, userId);
      },
    };
  }

  /**
   * Profile for the cloud `hello`: the live channel's own view when a session is
   * up, else what the store remembered from the last successful pairing. Never
   * claims a phone for a channel that has none — `account` is the channel's
   * address (WhatsApp digits / LINE mid), and only WhatsApp fills `phone`.
   */
  private profileFor(id: string): ChannelProfile | undefined {
    const live = this.live.get(id)?.session;
    const session = live?.profile?.();
    if (session != null) return session;
    const meta = this.store.meta(id);
    return compactProfile({
      account: meta.phone ?? '',
      displayName: meta.user ?? '',
    });
  }

  private async start(id: string, options: { restore: boolean }): Promise<void> {
    const row = this.store.require(id);
    const previousRestarts = this.live.get(id)?.restarts ?? 0;
    await this.stop(id, { logout: false });
    const session = this.factoryFor(row.channel).create(
      id,
      authDir(this.store.root, row.channel, id),
      this.hooksFor(id),
    );
    this.live.set(id, {
      session,
      status: 'connecting',
      qr: null,
      pin: null,
      restarts: previousRestarts,
    });
    try {
      await session.connect(options);
    } finally {
      const live = this.live.get(id);
      if (live != null && (live.qr != null || live.pin != null)) live.status = 'qr';
      this.startCloud(id);
    }
  }

  private async stop(id: string, options: { logout: boolean }): Promise<void> {
    const live = this.live.get(id);
    if (live == null) return;
    this.live.delete(id);
    await live.session.disconnect(options);
  }

  private startCloud(id: string): void {
    const row = this.store.get(id);
    if (row == null || !row.enabled) return;
    const url = row.cloudUrl;
    const token = row.cloudToken;
    if (url == null || url === '' || token == null || token === '') return;
    this.stopCloud(id);
    const queues = this.queues.get(id) ?? {};
    const transport = new CloudEventTransport(row.channel, () => this.clouds.get(id));
    queues.cloudTransport = transport;
    queues.inbound = new MessageQueue({
      connectionId: id,
      direction: 'in',
      messages: this.messages,
      transport,
    });
    this.queues.set(id, queues);
    const link = new CloudLink({
      connectionId: id,
      channel: row.channel,
      url,
      token,
      account: () => this.live.get(id)?.session.account() ?? this.store.meta(id).phone,
      profile: () => this.profileFor(id),
      session: () => this.live.get(id)?.session,
      // The socket accepting a write is not enough to send: an un-acked frame is
      // dropped, so the inbound queue drains on the server's `hello`.
      onOpened: () => transport.notifyReady(),
      queueSend: (name, args) => {
        const current = this.store.get(id);
        if (current == null) return null;
        return this.queueSend(id, current.channel, name, args);
      },
      onTerminalClose: (code) => {
        // The server refused this link. Stop and record why, so the UI can ask
        // the user for a current token instead of us looping on a dead socket.
        // `code === 0` means the upgrade itself was refused (HTTP 401).
        // Nothing queued will ever be accepted, so fail it rather than leave it
        // waiting out the hour.
        queues.inbound?.failAllPending(cloudRejectedMessage(code));
        this.store.saveMeta(id, {
          ...this.store.meta(id),
          lastError: cloudRejectedMessage(code),
          cloudRejectedAt: Date.now(),
        });
        this.stopCloud(id);
      },
    });
    this.clouds.set(id, link);
    link.start();
  }

  private stopCloud(id: string): void {
    const link = this.clouds.get(id);
    if (link != null) {
      link.stop();
      this.clouds.delete(id);
    }
    // Queued rows stay `pending`: a link that is re-saved should drain them, and
    // the hourly expiry retires anything that never gets another chance.
    const queues = this.queues.get(id);
    if (queues == null) return;
    queues.inbound?.stop();
    queues.inbound = undefined;
    queues.cloudTransport = undefined;
  }

  /** Connection is going away entirely; stop both workers. */
  private dropQueues(id: string): void {
    const queues = this.queues.get(id);
    if (queues == null) return;
    queues.inbound?.stop();
    queues.outbound?.stop();
    this.queues.delete(id);
  }

  private async handleDisconnect(id: string, reason: DisconnectReasonName): Promise<void> {
    const row = this.store.get(id);
    if (row == null) return;
    const live = this.live.get(id);
    if (live != null) {
      live.status = 'disconnected';
      live.qr = null;
      live.pin = null;
    }
    const meta = this.store.meta(id);
    this.store.saveMeta(id, { ...meta, disconnectAt: recordDisconnectAt(meta.disconnectAt) });
    if (reason === 'logout' || reason === 'replaced') {
      this.store.update(id, { enabled: false });
      this.store.saveMeta(id, {
        ...this.store.meta(id),
        connectedAt: null,
        lastError: reason === 'logout' ? 'logged out' : 'connection replaced',
      });
      this.live.delete(id);
      return;
    }
    if (reason === 'rate_limited') {
      this.store.saveMeta(id, { ...this.store.meta(id), lastError: 'rate limited' });
      if (live != null) live.status = 'error';
      return;
    }
    const restarts = (live?.restarts ?? 0) + 1;
    if (live != null) live.restarts = restarts;
    if (!row.enabled || restarts > MAX_RESTARTS) {
      this.store.saveMeta(id, {
        ...this.store.meta(id),
        connectedAt: null,
        lastError: `disconnected (${reason})`,
      });
      if (live != null) live.status = 'error';
      return;
    }
    try {
      await this.start(id, { restore: true });
      const next = this.live.get(id);
      if (next != null) next.restarts = restarts;
    } catch (error) {
      this.markError(id, error);
    }
  }

  private markError(id: string, error: unknown): void {
    const live = this.live.get(id);
    if (live != null) live.status = 'error';
    this.store.saveMeta(id, {
      ...this.store.meta(id),
      lastError: error instanceof Error ? error.message : String(error),
    });
  }
}
