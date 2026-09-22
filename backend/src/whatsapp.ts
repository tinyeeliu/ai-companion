import makeWASocket, { useMultiFileAuthState, type WAMessage, type WASocket } from '@whiskeysockets/baileys';
import type { ChannelFactory, ChannelSession, SessionHooks } from './channel';
import { mapDisconnect } from './disconnect';
import { compactProfile, DEDUPE_MAX, LOGOUT_TIMEOUT_MS, type ChannelProfile } from './types';
import { logJson } from './log';

export type { ChannelFactory, ChannelSession, SessionHooks };

interface SocketEntry {
  sock: WASocket;
  connected: boolean;
}

function capWait<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function phoneOf(jid: string | null | undefined): string | undefined {
  if (jid == null || jid === '') return undefined;
  const digits = (jid.split('@')[0]?.split(':')[0] ?? '').replace(/\D/g, '');
  return digits === '' ? undefined : digits;
}

/**
 * The single channel user a batch concerns, or undefined when it mixes senders.
 * Keeps a frame's top-level `userId` honest for batched `messages.upsert` events.
 */
function singleSenderId(messages: readonly WAMessage[]): string | undefined {
  const ids = new Set<string>();
  for (const msg of messages) {
    const id = senderPhoneFromKey(msg.key) ?? msg.key?.remoteJid ?? '';
    if (id !== '') ids.add(id);
  }
  return ids.size === 1 ? [...ids][0] : undefined;
}

function isPnJid(jid: string): boolean {
  const host = jid.split('@')[1] ?? '';
  return host === 's.whatsapp.net' || host.startsWith('s.whatsapp.net');
}

/** Prefer the phone JID (PN) over LID addressing used on newer WhatsApp keys. */
export function senderPhoneFromKey(key: {
  participant?: string | null;
  participantAlt?: string | null;
  remoteJid?: string | null;
  remoteJidAlt?: string | null;
} | null | undefined): string | undefined {
  if (key == null) return undefined;
  const candidates = [key.participantAlt, key.remoteJidAlt, key.participant, key.remoteJid];
  for (const jid of candidates) {
    if (typeof jid !== 'string' || jid === '' || !isPnJid(jid)) continue;
    const phone = phoneOf(jid);
    if (phone != null) return phone;
  }
  for (const jid of candidates) {
    if (typeof jid !== 'string' || jid === '') continue;
    const phone = phoneOf(jid);
    if (phone != null) return phone;
  }
  return undefined;
}

function displayNameOf(
  user: { name?: string; notify?: string; verifiedName?: string; username?: string } | undefined,
): string | undefined {
  for (const value of [user?.notify, user?.name, user?.verifiedName, user?.username]) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function toJid(to: string): string {
  const digits = to.replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}

function unwrapConversation(msg: WAMessage): string | null {
  const raw = msg.message as Record<string, unknown> | null | undefined;
  if (raw == null) return null;
  const inner = unwrapContent(raw);
  if (inner.conversation != null) return String(inner.conversation);
  const extended = inner.extendedTextMessage;
  if (extended != null && typeof extended === 'object') {
    const text = (extended as { text?: string }).text;
    if (typeof text === 'string' && text !== '') return text;
  }
  return null;
}

function unwrapContent(message: Record<string, unknown>): Record<string, unknown> {
  const ephemeral = message.ephemeralMessage as { message?: Record<string, unknown> } | undefined;
  if (ephemeral?.message != null) return unwrapContent(ephemeral.message);
  const viewOnce = message.viewOnceMessage as { message?: Record<string, unknown> } | undefined;
  if (viewOnce?.message != null) return unwrapContent(viewOnce.message);
  const viewOnceV2 = message.viewOnceMessageV2 as { message?: Record<string, unknown> } | undefined;
  if (viewOnceV2?.message != null) return unwrapContent(viewOnceV2.message);
  return message;
}

export function messageType(msg: WAMessage): string {
  const raw = msg.message as Record<string, unknown> | null | undefined;
  if (raw == null) return 'unknown';
  const content = unwrapContent(raw);
  // `conversation` is the bare protobuf field used for ordinary text. It is
  // not a `*Message` key, and messageContextInfo is metadata, not a message.
  if (content.conversation != null) return 'text';
  if (content.extendedTextMessage != null) return 'text';
  const key = Object.keys(content).find((name) => name.endsWith('Message'));
  if (key == null) return 'unknown';
  return key.replace(/Message$/, '').toLowerCase();
}

const silent = (): void => undefined;

function baileysLogger() {
  const logger = {
    level: 'silent',
    trace: silent,
    debug: silent,
    info: silent,
    warn: silent,
    error: silent,
    fatal: silent,
    child: () => logger,
  };
  return logger;
}

class BaileysSession implements ChannelSession {
  private entry: SocketEntry | null = null;
  private currentQr: string | null = null;
  private currentPhone: string | undefined;
  private currentUser: string | undefined;
  private epoch = 0;
  private manualClose = false;
  private readonly seen = new Set<string>();

  constructor(
    readonly id: string,
    readonly authFolder: string,
    readonly hooks: SessionHooks,
  ) {}

  qr(): string | null {
    return this.currentQr;
  }

  pin(): string | null {
    return null;
  }

  isConnected(): boolean {
    return this.entry?.connected === true;
  }

  account(): string | undefined {
    return this.currentPhone ?? phoneOf(this.entry?.sock.user?.id);
  }

  user(): string | undefined {
    return this.currentUser ?? displayNameOf(this.entry?.sock.user);
  }

  /**
   * What WhatsApp exposes the moment the session opens (and on every restore):
   * the phone digits, the device jid, the push name and the @handle when set.
   * This is the payload the cloud turns into `phone` / `channelId` / `name`.
   */
  profile(): ChannelProfile | undefined {
    const user = this.entry?.sock.user;
    const rawUsername = (user as { username?: unknown } | undefined)?.username;
    return compactProfile({
      account: this.account() ?? '',
      userId: user?.id ?? '',
      phone: this.account() ?? '',
      username: typeof rawUsername === 'string' ? rawUsername : '',
      displayName: this.user() ?? '',
    });
  }

  async connect(_options: { restore: boolean }): Promise<void> {
    await this.openSocket();
  }

  async disconnect(options: { logout: boolean }): Promise<void> {
    this.epoch += 1;
    const entry = this.entry;
    this.entry = null;
    this.currentQr = null;
    this.manualClose = true;
    if (entry == null) return;
    const linked = options.logout && (entry.connected || entry.sock.user != null);
    try {
      if (linked) await capWait(entry.sock.logout(), LOGOUT_TIMEOUT_MS);
      else entry.sock.end(undefined);
    } catch {
      try {
        entry.sock.end(undefined);
      } catch {
        /* already closed */
      }
    }
  }

  async sendText(to: string, text: string): Promise<{ id: string }> {
    const entry = this.entry;
    if (entry == null || !entry.connected) {
      throw new Error('not connected');
    }
    const payload = { text };
    logJson('outgoing', 'websocket', 'whatsapp.sendMessage', {
      connectionId: this.id,
      to: toJid(to),
      payload,
    });
    try {
      const sent = await entry.sock.sendMessage(toJid(to), payload);
      const result = { id: sent?.key?.id ?? '' };
      logJson('incoming', 'websocket', 'whatsapp.sendMessage.result', {
        connectionId: this.id,
        result,
      });
      return result;
    } catch (error) {
      console.error('[companion][websocket][error] WhatsApp sendMessage failed', error);
      throw error;
    }
  }

  async invoke(name: string, args: unknown[]): Promise<unknown> {
    const entry = this.entry;
    if (entry == null || !entry.connected) {
      throw new Error('not connected');
    }
    const sock = entry.sock as unknown as Record<string, unknown>;
    const method = sock[name];
    if (typeof method !== 'function') {
      throw new Error(`method ${name} is not available`);
    }
    return (method as (...params: unknown[]) => unknown).apply(entry.sock, args);
  }

  private async openSocket(): Promise<void> {
    if (this.entry != null) await this.disconnect({ logout: false });
    this.manualClose = false;
    const epoch = this.epoch;
    const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);
    if (this.epoch !== epoch) return;
    const sock = makeWASocket({
      auth: state,
      logger: baileysLogger() as unknown as Parameters<typeof makeWASocket>[0]['logger'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      browser: ['AI Companion', 'Chrome', '120.0.0'],
      getMessage: async () => undefined,
    });
    if (this.epoch !== epoch) {
      try {
        sock.end(undefined);
      } catch {
        /* replaced */
      }
      return;
    }
    const entry: SocketEntry = { sock, connected: false };
    this.entry = entry;

    sock.ev.on('creds.update', () => {
      if (this.entry !== entry) return;
      void saveCreds().catch(() => undefined);
    });

    sock.ev.on('connection.update', (update) => {
      if (this.entry !== entry) return;
      this.hooks.onVendorEvent?.('connection.update', update);
      if (update.qr != null && update.qr !== '') {
        this.currentQr = update.qr;
        this.hooks.onQr(update.qr);
      }
      if (update.connection === 'open') {
        entry.connected = true;
        this.currentQr = null;
        this.currentPhone = phoneOf(entry.sock.user?.id);
        this.currentUser =
          displayNameOf(entry.sock.user) ?? displayNameOf(entry.sock.authState.creds.me);
        this.hooks.onConnected(this.currentPhone, this.currentUser);
        return;
      }
      if (update.connection !== 'close') return;
      const reason = mapDisconnect(update.lastDisconnect?.error);
      entry.connected = false;
      this.entry = null;
      this.currentQr = null;
      if (this.manualClose) {
        this.manualClose = false;
        return;
      }
      this.hooks.onDisconnected(reason);
    });

    sock.ev.on('messages.upsert', (upsert) => {
      if (this.entry !== entry) return;
      logJson('incoming', 'websocket', 'whatsapp.messages.upsert', {
        connectionId: this.id,
        type: upsert.type,
        messages: upsert.messages,
      });
      this.hooks.onVendorEvent?.('messages.upsert', upsert, singleSenderId(upsert.messages));
      if (upsert.type !== 'notify') return;
      for (const msg of upsert.messages) {
        try {
          if (msg.key?.fromMe === true) continue;
          const remote = msg.key?.remoteJid ?? '';
          if (remote === 'status@broadcast') continue;
          const id = msg.key?.id ?? '';
          if (id === '') {
            console.error('[companion][websocket][unexpected] WhatsApp message has no id', msg);
            continue;
          }
          if (this.seen.has(id)) continue;
          this.seen.add(id);
          if (this.seen.size > DEDUPE_MAX) {
            const first = this.seen.values().next().value;
            if (first != null) this.seen.delete(first);
          }
          const text = unwrapConversation(msg);
          const type = messageType(msg);
          const from = senderPhoneFromKey(msg.key) ?? '';
          const to = this.currentPhone ?? '';
          const timestamp = Number(msg.messageTimestamp ?? 0) * 1000;
          if (type === 'unknown') {
            console.error('[companion][websocket][unexpected] Unsupported WhatsApp message', {
              id,
              keys: Object.keys((msg.message as Record<string, unknown> | null) ?? {}),
            });
          }
          const inbound = {
            id,
            from,
            to,
            ...(text == null ? {} : { text }),
            type,
            timestamp,
            raw: msg,
          };
          if (this.hooks.onInboundMessage != null) {
            this.hooks.onInboundMessage(inbound);
          } else if (text != null) {
            this.hooks.onInboundText({ ...inbound, text });
          }
        } catch (error) {
          console.error('[companion][websocket][error] Failed to process WhatsApp message', error);
        }
      }
    });
  }
}

export const baileysFactory: ChannelFactory = {
  create(id, authFolder, hooks) {
    return new BaileysSession(id, authFolder, hooks);
  },
};
