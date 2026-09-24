import { describe, expect, test } from 'bun:test';
import { senderPhoneFromKey, toJid } from '../src/whatsapp';

describe('toJid', () => {
  test('builds the user jid from a bare phone', () => {
    expect(toJid('85265862165')).toBe('85265862165@s.whatsapp.net');
    expect(toJid('+852 6586 2165')).toBe('85265862165@s.whatsapp.net');
  });

  test('keeps a group jid instead of rewriting it as a phone', () => {
    // A group reply must reach the group; stripping `@g.us` would address a
    // user that does not exist.
    expect(toJid('120363412973586464@g.us')).toBe('120363412973586464@g.us');
  });

  test('passes an addressed jid through unchanged', () => {
    expect(toJid('8614714306735:14@s.whatsapp.net')).toBe('8614714306735:14@s.whatsapp.net');
  });
});

describe('senderPhoneFromKey', () => {
  test('uses remoteJidAlt when participant is empty and remoteJid is a LID', () => {
    expect(
      senderPhoneFromKey({
        remoteJid: '204608148369653@lid',
        remoteJidAlt: '85265862165@s.whatsapp.net',
        participant: '',
      }),
    ).toBe('85265862165');
  });

  test('uses participant phone when present', () => {
    expect(
      senderPhoneFromKey({
        remoteJid: '120363@g.us',
        participant: '6591111111:12@s.whatsapp.net',
      }),
    ).toBe('6591111111');
  });

  test('falls back to remoteJid phone', () => {
    expect(senderPhoneFromKey({ remoteJid: '6591222222@s.whatsapp.net' })).toBe('6591222222');
  });

  test('returns undefined when no jid is usable', () => {
    expect(senderPhoneFromKey({ participant: '', remoteJid: '' })).toBeUndefined();
  });
});
