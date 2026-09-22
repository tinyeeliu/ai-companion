/**
 * @fileoverview Save and Connect gating: a draft is submittable only when it
 * would connect (ws(s) URL + token) or would deliberately release the link
 * (both fields cleared while a link is configured).
 */
import { describe, expect, test } from 'bun:test';
import { cloudSaveEnabled, isWebSocketUrl } from './cloudLink';

const CONFIGURED = 'wss://cloud.example/v1/companion';

describe('isWebSocketUrl', () => {
  test('accepts ws and wss, trimmed', () => {
    expect(isWebSocketUrl('ws://127.0.0.1:8083/api/v3/img/companion')).toBe(true);
    expect(isWebSocketUrl('wss://cloud.example/v1/companion')).toBe(true);
    expect(isWebSocketUrl('  ws://cloud.example  ')).toBe(true);
  });

  test('rejects other schemes, blanks and garbage', () => {
    expect(isWebSocketUrl('http://cloud.example')).toBe(false);
    expect(isWebSocketUrl('https://cloud.example')).toBe(false);
    expect(isWebSocketUrl('cloud.example')).toBe(false);
    expect(isWebSocketUrl('')).toBe(false);
    expect(isWebSocketUrl('   ')).toBe(false);
  });
});

describe('cloudSaveEnabled', () => {
  test('connect is enabled only with a dialable URL and a token', () => {
    expect(cloudSaveEnabled('ws://127.0.0.1:8083/api/v3/img/companion', 'tok-1', null)).toBe(true);
    expect(cloudSaveEnabled(CONFIGURED, 'tok-1', null)).toBe(true);
  });

  test('a token without a valid URL is not clickable', () => {
    expect(cloudSaveEnabled('', 'tok-1', CONFIGURED)).toBe(false);
    expect(cloudSaveEnabled('   ', 'tok-1', CONFIGURED)).toBe(false);
    expect(cloudSaveEnabled('https://cloud.example', 'tok-1', CONFIGURED)).toBe(false);
    expect(cloudSaveEnabled('not a url', 'tok-1', null)).toBe(false);
  });

  test('a URL without a token is not clickable', () => {
    expect(cloudSaveEnabled(CONFIGURED, '', CONFIGURED)).toBe(false);
    expect(cloudSaveEnabled(CONFIGURED, '   ', CONFIGURED)).toBe(false);
  });

  test('clearing both fields releases a configured link', () => {
    expect(cloudSaveEnabled('', '', CONFIGURED)).toBe(true);
    expect(cloudSaveEnabled('  ', '  ', CONFIGURED)).toBe(true);
  });

  test('clearing both fields with nothing configured stays disabled', () => {
    expect(cloudSaveEnabled('', '', null)).toBe(false);
    expect(cloudSaveEnabled('', '', '')).toBe(false);
  });
});
