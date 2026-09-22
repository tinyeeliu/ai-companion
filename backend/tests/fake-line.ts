import type { ChannelFactory, ChannelSession, SessionHooks } from '../src/channel';

export class FakeLineSession implements ChannelSession {
  connectedFlag = false;
  qrValue: string | null = null;
  pinValue: string | null = null;
  accountValue: string | undefined = 'u-fake-mid';
  userValue: string | undefined = 'Display Name';
  lastTo: string | null = null;

  constructor(
    readonly id: string,
    readonly hooks: SessionHooks,
  ) {}

  async connect(options: { restore: boolean }): Promise<void> {
    if (options.restore) {
      this.connectedFlag = true;
      this.qrValue = null;
      this.pinValue = null;
      this.hooks.onConnected(this.accountValue, this.userValue);
      return;
    }
    this.qrValue = 'https://line.me/R/nv/QRCodeAuth/fake';
    this.pinValue = '123456';
    this.hooks.onQr(this.qrValue);
    this.hooks.onPin(this.pinValue);
  }

  async disconnect(_options: { logout: boolean }): Promise<void> {
    this.connectedFlag = false;
    this.qrValue = null;
    this.pinValue = null;
  }

  async sendText(to: string, _text: string): Promise<{ id: string }> {
    if (!this.connectedFlag) throw new Error('not connected');
    this.lastTo = to;
    return { id: 'line.fake' };
  }

  async invoke(name: string, args: unknown[]): Promise<unknown> {
    if (!this.connectedFlag) throw new Error('not connected');
    if (name === 'sendCompactMessage') {
      this.lastTo = typeof args[0] === 'string' ? args[0] : null;
      return { messageId: 'line.fake' };
    }
    throw new Error(`method ${name} is not available`);
  }

  qr(): string | null {
    return this.qrValue;
  }

  pin(): string | null {
    return this.pinValue;
  }

  isConnected(): boolean {
    return this.connectedFlag;
  }

  account(): string | undefined {
    return this.accountValue;
  }

  user(): string | undefined {
    return this.userValue;
  }
}

export function fakeLineFactory(sessions: Map<string, FakeLineSession>): ChannelFactory {
  return {
    create(id, _authFolder, hooks) {
      const session = new FakeLineSession(id, hooks);
      sessions.set(id, session);
      return session;
    },
  };
}
