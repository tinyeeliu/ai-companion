import { describe, expect, test } from 'bun:test';
import { senderPhoneFromKey } from '../src/whatsapp';

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
