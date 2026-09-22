import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { ConnectionStore } from '../src/store';

const dirs: string[] = [];

function tempStore(): ConnectionStore {
  const dir = mkdtempSync(join(tmpdir(), 'companion-store-'));
  dirs.push(dir);
  return new ConnectionStore(dir);
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir != null) rmSync(dir, { recursive: true, force: true });
  }
});

describe('ConnectionStore', () => {
  test('add list get update remove', () => {
    const store = tempStore();
    expect(store.list()).toEqual([]);
    store.add('home', 'http://127.0.0.1:9/hook');
    expect(store.list()).toHaveLength(1);
    expect(store.get('home')?.webhookUrl).toBe('http://127.0.0.1:9/hook');
    expect(store.get('home')?.name).toBe('home');
    store.add('work', null, 'Work');
    expect(store.get('work')?.name).toBe('Work');
    expect(store.meta('home').incomingCount).toBe(0);
    expect(store.meta('home').disconnectAt).toEqual([]);
    store.update('home', { enabled: false, webhookUrl: null, name: 'House' });
    expect(store.require('home').enabled).toBe(false);
    expect(store.require('home').webhookUrl).toBeNull();
    expect(store.require('home').name).toBe('House');
    store.update('home', { webhookToken: 'hook-secret' });
    expect(store.require('home').webhookToken).toBe('hook-secret');
    // Rows written before the token existed normalize to null, not undefined.
    expect(store.require('work').webhookToken).toBeNull();
    store.saveMeta('home', { ...store.meta('home'), incomingCount: 2, phone: '6591' });
    expect(store.meta('home').phone).toBe('6591');
    store.remove('home');
    store.remove('work');
    expect(store.list()).toEqual([]);
    expect(() => store.require('home')).toThrow();
  });

  test('rejects bad ids and duplicates', () => {
    const store = tempStore();
    expect(() => store.add('bad id')).toThrow();
    store.add('ok');
    expect(() => store.add('ok')).toThrow();
  });

  test('keeps whatsapp and line in separate roots', () => {
    const store = tempStore();
    store.add('home', null, 'Home', 'whatsapp');
    store.add('desk', null, 'Desk', 'line');
    expect(store.get('home')?.channel).toBe('whatsapp');
    expect(store.get('desk')?.channel).toBe('line');
    expect(store.list().map((row) => row.id).sort()).toEqual(['desk', 'home']);
    store.update('desk', { enabled: false });
    expect(store.require('home').enabled).toBe(true);
    expect(store.require('desk').enabled).toBe(false);
    store.remove('desk');
    expect(store.get('desk')).toBeUndefined();
    expect(store.require('home').channel).toBe('whatsapp');
  });
});
