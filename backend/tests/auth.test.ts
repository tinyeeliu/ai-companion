import { describe, expect, test } from 'bun:test';
import { constantTimeEqual, isLoopbackAddress } from '../src/auth';

describe('isLoopbackAddress', () => {
  test('accepts loopback forms', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.1.2.3')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('localhost')).toBe(true);
  });

  test('rejects everything else', () => {
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
    expect(isLoopbackAddress('192.168.1.10')).toBe(false);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
    expect(isLoopbackAddress('::ffff:192.168.1.10')).toBe(false);
    expect(isLoopbackAddress('2001:db8::1')).toBe(false);
  });
});

describe('constantTimeEqual', () => {
  test('matches only identical non-empty strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual(null, 'abc')).toBe(false);
    expect(constantTimeEqual('abc', null)).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});
