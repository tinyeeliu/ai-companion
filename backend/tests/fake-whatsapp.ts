import type { ChannelFactory, ChannelSession, SessionHooks } from '../src/channel';

export class FakeSession implements ChannelSession {
  connectedFlag = false;
  qrValue: string | null = null;
  pinValue: string | null = null;
  phoneValue: string | undefined = '6591111111';
  userValue: string | undefined = 'Alice';
  failConnect = false;

  constructor(
    readonly id: string,
    readonly hooks: SessionHooks,
  ) {}

  async connect(options: { restore: boolean }): Promise<void> {
    if (this.failConnect) throw new Error('connect failed');
    if (options.restore) {
      this.connectedFlag = true;
      this.qrValue = null;
      this.pinValue = null;
      this.hooks.onConnected(this.phoneValue, this.userValue);
      return;
    }
    this.qrValue = '2@fake-qr';
    this.pinValue = null;
    this.hooks.onQr(this.qrValue);
  }

  async disconnect(_options: { logout: boolean }): Promise<void> {
    this.connectedFlag = false;
    this.qrValue = null;
    this.pinValue = null;
  }

  async sendText(_to: string, _text: string): Promise<{ id: string }> {
    if (!this.connectedFlag) throw new Error('not connected');
    return { id: 'wamid.fake' };
  }

  async invoke(name: string, args: unknown[]): Promise<unknown> {
    if (!this.connectedFlag) throw new Error('not connected');
    return { name, args };
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
    return this.phoneValue;
  }

  user(): string | undefined {
    return this.userValue;
  }
}

export function fakeFactory(sessions: Map<string, FakeSession>): ChannelFactory {
  return {
    create(id, _authFolder, hooks) {
      const session = new FakeSession(id, hooks);
      sessions.set(id, session);
      return session;
    },
  };
}
