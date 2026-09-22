import type { DisconnectReasonName } from './types';
import type { ChannelProfile } from './types';

export type Channel = 'whatsapp' | 'line';

export const CHANNELS: Channel[] = ['whatsapp', 'line'];

export function isChannel(value: unknown): value is Channel {
  return value === 'whatsapp' || value === 'line';
}

export interface SessionHooks {
  onQr: (qr: string) => void;
  onPin: (pin: string) => void;
  onConnected: (account?: string, user?: string) => void;
  onDisconnected: (reason: DisconnectReasonName) => void;
  onInboundText: (msg: {
    id: string;
    from: string;
    to: string;
    text: string;
    timestamp: number;
    raw?: unknown;
  }) => void;
  onInboundMessage?: (msg: {
    id: string;
    from: string;
    to: string;
    text?: string;
    type: string;
    timestamp: number;
    raw?: unknown;
  }) => void;
  /**
   * Raw vendor callback for the cloud pipe. Not filtered for local UI.
   * `userId` is the channel user the event concerns when the adapter can name a
   * single one (a WhatsApp JID / phone, a LINE user id); omitted for mixed batches.
   */
  onVendorEvent?: (name: string, data: unknown, userId?: string) => void;
}

export interface ChannelSession {
  connect(options: { restore: boolean }): Promise<void>;
  disconnect(options: { logout: boolean }): Promise<void>;
  sendText(to: string, text: string): Promise<{ id: string }>;
  invoke(name: string, args: unknown[]): Promise<unknown>;
  qr(): string | null;
  pin(): string | null;
  isConnected(): boolean;
  account(): string | undefined;
  user(): string | undefined;
  /**
   * What this channel knows about the paired account, sent on the cloud `hello`.
   * Optional so a channel with nothing to add simply omits it; the `account` and
   * `user` accessors above still cover the local UI.
   */
  profile?(): ChannelProfile | undefined;
}

export interface ChannelFactory {
  create(id: string, authFolder: string, hooks: SessionHooks): ChannelSession;
}
