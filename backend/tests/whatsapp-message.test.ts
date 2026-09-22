import { describe, expect, test } from 'bun:test';
import { messageType } from '../src/whatsapp';

describe('WhatsApp message classification', () => {
  test('classifies bare conversation text with message metadata', () => {
    const message = {
      message: {
        conversation: 'Hi',
        messageContextInfo: {
          deviceListMetadataVersion: 2,
        },
      },
    };

    expect(messageType(message as never)).toBe('text');
  });
});
