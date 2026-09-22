import { describe, expect, test } from 'bun:test';
import { encodeBin, parseFrame, reviveBin, stringifyFrame } from '../src/cloud/protocol';

describe('cloud protocol', () => {
  test('round-trips binary fields', () => {
    const bytes = Uint8Array.from([1, 2, 255]);
    const encoded = encodeBin({ key: bytes, nested: { buf: bytes } });
    const revived = reviveBin(encoded) as { key: Buffer; nested: { buf: Buffer } };
    expect(Buffer.from(revived.key).equals(Buffer.from(bytes))).toBe(true);
    expect(Buffer.from(revived.nested.buf).equals(Buffer.from(bytes))).toBe(true);
  });

  test('parses a channel-agnostic invoke frame', () => {
    const raw = stringifyFrame({
      v: 1,
      type: 'invoke',
      id: 'c1',
      connectionId: 'home',
      channel: 'line',
      name: 'sendCompactMessage',
      data: { args: ['u1', 'hi'] },
    });
    const frame = parseFrame(raw);
    expect(frame).toMatchObject({
      type: 'invoke',
      id: 'c1',
      connectionId: 'home',
      channel: 'line',
      name: 'sendCompactMessage',
    });
    expect(frame?.data).toEqual({ args: ['u1', 'hi'] });
  });

  test('rejects unknown versions', () => {
    expect(parseFrame(JSON.stringify({ v: 2, type: 'ping' }))).toBeNull();
  });
});
