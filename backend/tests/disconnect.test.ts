import { describe, expect, test } from 'bun:test';
import { mapDisconnect } from '../src/disconnect';
import { DISCONNECT_WINDOW_MS, pruneDisconnectAt, recordDisconnectAt } from '../src/types';

function boom(statusCode: number): unknown {
  return { output: { statusCode } };
}

describe('mapDisconnect', () => {
  test('maps baileys close codes', () => {
    expect(mapDisconnect(boom(401))).toBe('logout');
    expect(mapDisconnect(boom(440))).toBe('replaced');
    expect(mapDisconnect(boom(405))).toBe('rate_limited');
    expect(mapDisconnect(boom(515))).toBe('restart');
    expect(mapDisconnect(boom(500))).toBe('auth_corrupt');
    expect(mapDisconnect(new Error('Bad MAC'))).toBe('auth_corrupt');
    expect(mapDisconnect(boom(408))).toBe('transient');
    expect(mapDisconnect(undefined)).toBe('transient');
  });
});

describe('disconnect window', () => {
  test('keeps events inside 24 hours and drops older', () => {
    const now = 1_700_000_000_000;
    const fresh = now - DISCONNECT_WINDOW_MS + 1;
    const stale = now - DISCONNECT_WINDOW_MS - 1;
    expect(pruneDisconnectAt([stale, fresh], now)).toEqual([fresh]);
    expect(recordDisconnectAt([stale, fresh], now)).toEqual([fresh, now]);
    expect(pruneDisconnectAt(undefined, now)).toEqual([]);
  });
});
