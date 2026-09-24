/**
 * @fileoverview SHA-256 dialects.
 *
 * One digest reaches the Companion in several spellings: WhatsApp's
 * `fileSha256` is a raw `Uint8Array`, the cloud sends base64url with the padding
 * stripped, and a digest copied out of a storage url can be standard base64 with
 * `=`, percent-encoded (`%3D`) in a path, or hex. Everything is canonicalized to
 * a single form — base64url, no padding, 43 characters — so one file has exactly
 * one identity and a content-addressed lookup cannot miss on a spelling
 * difference.
 *
 * The two dialects that actually meet in this codebase are WhatsApp's padded
 * standard base64 (`fileSha256`) and everyone else's unpadded base64url, which is
 * what the cloud stores under and what `DataUtility.getSha256Base64` produces on
 * the SM3 side.
 */
import { createHash } from 'node:crypto';

/** Length of a SHA-256 digest in bytes. */
export const SHA256_DIGEST_BYTES = 32;

/** A canonical digest: base64url, no padding, 43 characters. */
const CANONICAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** 32 bytes spelled as hex. */
const HEX_PATTERN = /^[0-9a-fA-F]{64}$/;

/** SHA-256 of `bytes`, base64url without padding. */
export function sha256Base64Url(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64url');
}

/** True when `value` is already in the canonical spelling. */
export function isCanonicalSha256(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_PATTERN.test(value);
}

/**
 * Canonicalizes any accepted spelling into base64url without padding, or null
 * when the value is not a 32-byte digest at all.
 *
 * Null is the answer for anything unrecognized — a truncated digest, a filename
 * that is not content-addressed, an unrelated string — because a wrong sha is
 * worse than no sha: it would let one file's cached bytes answer for another.
 */
export function normalizeSha256(value: unknown): string | null {
  const bytes = sha256Bytes(value);
  return bytes == null ? null : Buffer.from(bytes).toString('base64url');
}

/** The raw digest bytes behind any accepted spelling, or null. */
export function sha256Bytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value.byteLength === SHA256_DIGEST_BYTES ? value : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  // A bare digest, in whichever spelling arrived.
  const direct = decodeToken(text);
  if (direct != null) return direct;
  // Otherwise it may address a stored object, whose name is the digest.
  for (const token of objectNameTokens(text)) {
    const decoded = decodeToken(token);
    if (decoded != null) return decoded;
  }
  return null;
}

/**
 * The candidate digest spellings inside a url, path, or object name.
 *
 * The last path segment first, then that segment with its extension removed —
 * `temp/{sha}.jpeg` and `temp/{sha}` are both real layouts. Nothing is stripped
 * from the front: an object named `original-{sha}.jpeg` yields
 * `original-{sha}`, which fails to decode and is refused. Guessing at prefixes
 * would be how a wrong sha gets in.
 */
function objectNameTokens(text: string): string[] {
  const withoutQuery = text.split(/[?#]/)[0] ?? '';
  const segment = withoutQuery.split('/').filter((part) => part !== '').pop() ?? '';
  if (segment === '') return [];
  const decoded = percentDecode(segment);
  const dot = decoded.indexOf('.');
  return dot < 0 ? [decoded] : [decoded, decoded.slice(0, dot)];
}

/** One spelling as bytes: hex, or base64 in either alphabet. */
function decodeToken(token: string): Uint8Array | null {
  if (HEX_PATTERN.test(token)) return new Uint8Array(Buffer.from(token, 'hex'));
  return decodeDigest(token);
}

/**
 * Decodes base64 / base64url in either padding convention, rejecting anything
 * that is not exactly one digest long.
 *
 * `Buffer.from(…, 'base64')` silently skips invalid characters and ignores
 * trailing bits, so the decoded bytes are re-encoded and compared: a value that
 * does not survive that round trip was never a digest and is refused rather than
 * hashed into a plausible-looking identity.
 */
function decodeDigest(text: string): Uint8Array | null {
  const stripped = percentDecode(text).replace(/[=\s]+$/g, '');
  // The hyphen is last so it is a literal, not the range operator: `[+/-_]`
  // silently excludes `-` itself, and base64url digests use it constantly.
  if (stripped === '' || !/^[A-Za-z0-9+/_-]+$/.test(stripped)) return null;
  const normalized = stripped.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const bytes = Buffer.from(padded, 'base64');
  if (bytes.byteLength !== SHA256_DIGEST_BYTES) return null;
  if (bytes.toString('base64').replace(/=+$/, '') !== normalized) return null;
  return new Uint8Array(bytes);
}

/** `decodeURIComponent` that keeps the input on malformed escapes. */
function percentDecode(text: string): string {
  if (!text.includes('%')) return text;
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
