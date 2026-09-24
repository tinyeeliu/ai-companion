import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { isCanonicalSha256, normalizeSha256, sha256Bytes } from '../src/media/sha';

const BYTES = new Uint8Array([1, 2, 3, 4, 5]);
const CANONICAL = createHash('sha256').update(Buffer.from(BYTES)).digest('base64url');
const RAW = new Uint8Array(createHash('sha256').update(Buffer.from(BYTES)).digest());

function expectCanonical(value: unknown): void {
  expect(normalizeSha256(value)).toBe(CANONICAL);
  expect(isCanonicalSha256(normalizeSha256(value))).toBe(true);
}

describe('normalizeSha256', () => {
  test('accepts the raw digest WhatsApp puts on the wire', () => {
    // `fileSha256` is a `Uint8Array`, never a string.
    expectCanonical(RAW);
  });

  test('accepts base64url without padding, and reports it as canonical', () => {
    expectCanonical(CANONICAL);
    expect(isCanonicalSha256(CANONICAL)).toBe(true);
  });

  test('accepts standard base64 with padding', () => {
    const padded = Buffer.from(RAW).toString('base64');
    expectCanonical(padded);
    expect(isCanonicalSha256(padded)).toBe(false);
  });

  test('accepts standard base64 without padding', () => {
    expectCanonical(Buffer.from(RAW).toString('base64').replace(/=+$/, ''));
  });

  test('accepts a percent-encoded digest from a url path', () => {
    const padded = Buffer.from(RAW).toString('base64');
    expectCanonical(padded.replace(/=/g, '%3D'));
  });

  test('accepts hex', () => {
    expectCanonical(Buffer.from(RAW).toString('hex'));
  });

  test('reads the digest out of a content-addressed object name', () => {
    // The layout `storeChannelMedia` and the upload presign both enforce.
    expectCanonical(`https://workspace.example.com/temp/${CANONICAL}.jpeg`);
    expectCanonical(`temp/${CANONICAL}.jpeg`);
    expectCanonical(`temp/${CANONICAL}`);
    expectCanonical(`https://workspace.example.com/temp/${CANONICAL}.jpeg?x=1#y`);
  });

  test('rejects a url whose object name is not content-addressed', () => {
    expect(normalizeSha256('https://workspace.example.com/temp/photo.jpeg')).toBeNull();
    expect(normalizeSha256('temp/original-photo.jpg')).toBeNull();
  });

  test('rejects a truncated or over-long digest', () => {
    expect(normalizeSha256(CANONICAL.slice(0, 42))).toBeNull();
    expect(normalizeSha256(`${CANONICAL}a`)).toBeNull();
    expect(normalizeSha256(Buffer.from(RAW).toString('hex').slice(0, 63))).toBeNull();
    expect(normalizeSha256(new Uint8Array(16))).toBeNull();
  });

  test('rejects values that are not digests at all', () => {
    expect(normalizeSha256(undefined)).toBeNull();
    expect(normalizeSha256(null)).toBeNull();
    expect(normalizeSha256(42)).toBeNull();
    expect(normalizeSha256('')).toBeNull();
    expect(normalizeSha256('   ')).toBeNull();
    expect(normalizeSha256('image/jpeg')).toBeNull();
    // Not 32 bytes once decoded, and not a digest anyone produced.
    expect(normalizeSha256('not-a-sha256-value')).toBeNull();
  });

  test('rejects a value whose base64 is only superficially valid', () => {
    // `Buffer.from(..., 'base64')` skips invalid characters silently, so a value
    // that does not survive a decode/re-encode round trip must be refused rather
    // than turned into a plausible-looking identity.
    const damaged = `${CANONICAL.slice(0, 20)}!${CANONICAL.slice(21)}`;
    expect(normalizeSha256(damaged)).toBeNull();
  });

  test('exposes the raw digest bytes behind any spelling', () => {
    expect(sha256Bytes(CANONICAL)).toEqual(RAW);
    expect(sha256Bytes('nope')).toBeNull();
  });
});
