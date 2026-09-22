import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loginWithAuthToken, loginWithQR, type Client } from '@evex/linejs';
import { FileStorage } from '@evex/linejs/storage';
import type { ChannelFactory, ChannelSession, SessionHooks } from './channel';
import { DEDUPE_MAX, compactProfile, type ChannelProfile } from './types';
import { logJson } from './log';

const DEVICE = 'ANDROIDSECONDARY' as const;

function storageFile(authFolder: string): string {
  return join(authFolder, 'storage.json');
}

function tokenFile(authFolder: string): string {
  return join(authFolder, 'token');
}

function readToken(authFolder: string): string | null {
  const path = tokenFile(authFolder);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8').trim();
  return raw === '' ? null : raw;
}

function writeToken(authFolder: string, token: string): void {
  writeFileSync(tokenFile(authFolder), token, { mode: 0o600 });
}

function dropToken(authFolder: string): void {
  try {
    unlinkSync(tokenFile(authFolder));
  } catch {
    /* already gone */
  }
}

function inboundMessage(message: {
  isMyMessage?: boolean;
  text?: string;
  raw?: { id?: unknown; contentType?: unknown; createdTime?: unknown };
  from?: { id?: string };
  to?: { id?: string };
}): { id: string; from: string; to: string; text?: string; type: string; timestamp: number } | null {
  const contentType = message.raw?.contentType;
  const text = typeof message.text === 'string' ? message.text : '';
  const id = String(message.raw?.id ?? '');
  if (id === '') return null;
  const type =
    typeof contentType === 'string' && contentType !== '' && contentType !== 'NONE'
      ? contentType.toLowerCase()
      : text === ''
        ? 'unknown'
        : 'text';
  const created = Number(message.raw?.createdTime ?? 0);
  return {
    id,
    from: message.from?.id ?? '',
    to: message.to?.id ?? '',
    ...(text === '' ? {} : { text }),
    type,
    timestamp: Number.isFinite(created) && created > 0 ? created : Date.now(),
  };
}

class LineJsSession implements ChannelSession {
  private client: Client | null = null;
  private currentQr: string | null = null;
  private currentPin: string | null = null;
  private currentAccount: string | undefined;
  private currentUser: string | undefined;
  private connectedFlag = false;
  private manualClose = false;
  private listenAbort: AbortController | null = null;
  private epoch = 0;
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
    return this.currentPin;
  }

  isConnected(): boolean {
    return this.connectedFlag;
  }

  account(): string | undefined {
    return this.currentAccount;
  }

  user(): string | undefined {
    return this.currentUser;
  }

  /**
   * LINE's profile after `getMyProfile()`: the mid (which is the channel address,
   * never a phone) and the displayName. LINE exposes no phone or @handle, so
   * `phone`/`username` stay absent and the cloud must not invent them.
   */
  profile(): ChannelProfile | undefined {
    return compactProfile({
      account: this.currentAccount ?? '',
      userId: this.currentAccount ?? '',
      displayName: this.currentUser ?? '',
    });
  }

  async connect(options: { restore: boolean }): Promise<void> {
    await this.disconnect({ logout: false });
    this.manualClose = false;
    const epoch = this.epoch;
    const saved = options.restore ? readToken(this.authFolder) : null;
    if (saved != null) {
      await this.openClient(epoch, await this.loginSaved(saved));
      return;
    }
    void this.loginQr(epoch)
      .then((client) => this.openClient(epoch, client))
      .catch(() => {
        if (this.manualClose || this.epoch !== epoch) return;
        this.connectedFlag = false;
        this.hooks.onDisconnected('transient');
      });
  }

  async disconnect(options: { logout: boolean }): Promise<void> {
    this.epoch += 1;
    this.manualClose = true;
    this.listenAbort?.abort();
    this.listenAbort = null;
    this.client = null;
    this.connectedFlag = false;
    this.currentQr = null;
    this.currentPin = null;
    if (options.logout) dropToken(this.authFolder);
  }

  async sendText(to: string, text: string): Promise<{ id: string }> {
    const client = this.client;
    if (client == null || !this.connectedFlag) throw new Error('not connected');
    logJson('outgoing', 'websocket', 'line.sendMessage', {
      connectionId: this.id,
      to,
      payload: { text },
    });
    try {
      const sent = await client.sendCompactMessage(to, text);
      const result = { id: String(sent.messageId) };
      logJson('incoming', 'websocket', 'line.sendMessage.result', {
        connectionId: this.id,
        result,
      });
      return result;
    } catch (error) {
      console.error('[companion][websocket][error] LINE sendMessage failed', error);
      throw error;
    }
  }

  async invoke(name: string, args: unknown[]): Promise<unknown> {
    const client = this.client;
    if (client == null || !this.connectedFlag) throw new Error('not connected');
    if (name === 'sendCompactMessage') {
      const to = typeof args[0] === 'string' ? args[0] : '';
      const text = typeof args[1] === 'string' ? args[1] : '';
      return client.sendCompactMessage(to, text);
    }
    const method = (client as unknown as Record<string, unknown>)[name];
    if (typeof method !== 'function') {
      throw new Error(`method ${name} is not available`);
    }
    return (method as (...params: unknown[]) => unknown).apply(client, args);
  }

  private loginSaved(token: string): Promise<Client> {
    return loginWithAuthToken(token, {
      device: DEVICE,
      storage: new FileStorage(storageFile(this.authFolder)),
    });
  }

  private loginQr(epoch: number): Promise<Client> {
    return loginWithQR(
      {
        onReceiveQRUrl: (url) => {
          if (this.epoch !== epoch) return;
          this.currentQr = url;
          this.hooks.onQr(url);
        },
        onPincodeRequest: (pin) => {
          if (this.epoch !== epoch) return;
          this.currentPin = pin;
          this.hooks.onPin(pin);
        },
      },
      { device: DEVICE, storage: new FileStorage(storageFile(this.authFolder)) },
    );
  }

  private async openClient(epoch: number, client: Client): Promise<void> {
    if (this.manualClose || this.epoch !== epoch) return;
    this.client = client;
    writeToken(this.authFolder, client.authToken);
    const profile = await client.getMyProfile();
    if (this.manualClose || this.epoch !== epoch) return;
    const mid = profile.mid;
    const displayName = typeof profile.displayName === 'string' ? profile.displayName.trim() : '';
    this.currentAccount = mid;
    this.currentUser = displayName === '' ? undefined : displayName;
    this.currentQr = null;
    this.currentPin = null;
    this.connectedFlag = true;
    this.bindClient(client);
    this.hooks.onConnected(this.currentAccount, this.currentUser);
  }

  private bindClient(client: Client): void {
    const abort = new AbortController();
    this.listenAbort = abort;
    client.on('message', (message) => {
      try {
        if (this.client !== client) return;
        logJson('incoming', 'websocket', 'line.message', {
          connectionId: this.id,
          message,
        });
        this.hooks.onVendorEvent?.('message', message, message.from?.id ?? undefined);
        if (message.isMyMessage === true) return;
        const msg = inboundMessage(message);
        if (msg == null) {
          console.error('[companion][websocket][unexpected] Unsupported LINE message', message);
          return;
        }
        if (msg.type === 'unknown') {
          console.error('[companion][websocket][unexpected] LINE message has unknown type', message);
        }
        if (this.seen.has(msg.id)) return;
        this.seen.add(msg.id);
        if (this.seen.size > DEDUPE_MAX) {
          const first = this.seen.values().next().value;
          if (first != null) this.seen.delete(first);
        }
        const inbound = {
          ...msg,
          to: msg.to === '' ? (this.currentAccount ?? '') : msg.to,
          raw: message,
        };
        if (this.hooks.onInboundMessage != null) {
          this.hooks.onInboundMessage(inbound);
        } else if (msg.text != null) {
          this.hooks.onInboundText({ ...inbound, text: msg.text });
        }
      } catch (error) {
        console.error('[companion][websocket][error] Failed to process LINE message', error);
      }
    });
    client.listen({ talk: true, square: false, signal: abort.signal });
  }
}

export const linejsFactory: ChannelFactory = {
  create(id, authFolder, hooks) {
    return new LineJsSession(id, authFolder, hooks);
  },
};
