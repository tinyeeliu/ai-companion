/**
 * @fileoverview Cloud WebSocket draft rules shared by the dialog and its tests.
 * The dialog must offer Save and Connect only for a request the server would
 * accept *and* that would actually dial: a ws(s) URL plus a token. Mirrors
 * `PUT /cloud` in the Companion backend (`isWsUrl`, "token is required when url
 * is set"), plus the one clearing action that intentionally sends `url: null`.
 */

/** A dialable WebSocket URL: parseable and ws: / wss:, as the server requires. */
export function isWebSocketUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
  } catch {
    return false;
  }
}

/**
 * Whether the Cloud WebSocket save button may be clicked.
 *
 * - both values valid → connect;
 * - both fields cleared while a link is configured → turn that link off (the
 *   server's `url: null` path, and the only way to release a saved link);
 * - anything else (half-filled, wrong scheme, nothing configured yet) → no.
 */
export function cloudSaveEnabled(
  url: string,
  token: string,
  configuredUrl: string | null | undefined,
): boolean {
  const cleanUrl = url.trim();
  if (isWebSocketUrl(cleanUrl)) return token.trim() !== '';
  return cleanUrl === '' && token.trim() === '' && (configuredUrl ?? '') !== '';
}
