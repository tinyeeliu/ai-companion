/**
 * Request authentication for the Companion sidecar.
 *
 * A loopback caller (the app's own webview, Vite dev proxy, or a local tool) is
 * trusted and needs no token. Any other source must present the configured
 * bearer token, because the listener is reachable beyond this machine.
 *
 * The client address is read from the socket (Bun's `requestIP`), never from a
 * header: `X-Forwarded-For` is caller-controlled and would let anyone claim to
 * be local.
 */
import { timingSafeEqual } from 'node:crypto';
import { getConnInfo } from 'hono/bun';
import type { Context } from 'hono';

/** Any `127.x.x.x`, `::1`, or a `::ffff:` IPv4-mapped loopback address. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address == null) return false;
  const value = address.trim().toLowerCase();
  if (value === '') return false;
  if (value === 'localhost') return true;
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  // IPv4-mapped IPv6 (`::ffff:127.0.0.1`) and IPv4 in general.
  const v4 = value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * True when the request came from this machine. A missing connection info
 * (tests using `app.request`, or a server without `requestIP`) is treated as
 * local: there is no remote peer to authenticate.
 */
export function clientIsLoopback(c: Context): boolean {
  try {
    return isLoopbackAddress(getConnInfo(c).remote.address);
  } catch {
    return true;
  }
}

/**
 * Length-checked constant-time comparison, so a wrong token cannot be recovered
 * from response timing. Returns false when either side is absent.
 */
export function constantTimeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
