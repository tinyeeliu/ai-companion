/**
 * @fileoverview Direct-to-storage media upload (media phase 1B).
 *
 * The cloud advertises a presign endpoint on its `hello`. When one is known, the
 * Companion decrypts media, buys a short-lived PUT with the link bearer, and
 * uploads to the bucket itself, so the event frame carries only a url. That
 * keeps the bytes off the socket and out of the durable queue (which stores
 * frames as JSON text, i.e. base64).
 *
 * Everything here is best-effort: any failure returns null and the caller falls
 * back to shipping the bytes inline (1A), which is why none of these paths throw.
 */
import { createHash } from 'node:crypto';
import { logJson } from './log';
import type { FetchLike } from './webhook';

/** Presign round trip is small; a slow answer here just means fall back to 1A. */
const PRESIGN_TIMEOUT_MS = 15_000;
/** Generous because a home uplink can be slow and a retry costs a re-download. */
const UPLOAD_TIMEOUT_MS = 120_000;

/** Presign a url and put the bytes there, or null when either step fails. */
export type MediaUploader = (bytes: Uint8Array, mimetype: string) => Promise<{ url: string } | null>;

export interface MediaUploaderOptions {
  /** The learned endpoint, or '' when the server advertised none. */
  endpoint: () => string;
  /** The link bearer the socket already authenticates with. */
  token: () => string;
  fetchFn?: FetchLike;
}

/** SHA-256 as the cloud stores it: base64url with no padding. */
function sha256Base64Url(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64url');
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

/**
 * Builds the uploader for one connection.
 *
 * Reads the endpoint and token per call rather than capturing them, so a
 * reconnect that learns a new endpoint (or a token rotation) takes effect on the
 * next message instead of needing the session to be rebuilt.
 */
export function createMediaUploader(options: MediaUploaderOptions): MediaUploader {
  const fetchFn = options.fetchFn ?? fetch;

  return async (bytes, mimetype) => {
    const endpoint = options.endpoint().trim();
    const token = options.token().trim();
    if (endpoint === '' || token === '') return null;

    try {
      const presign = await fetchFn(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          mimetype,
          length: bytes.byteLength,
          sha256: sha256Base64Url(bytes),
        }),
        signal: AbortSignal.timeout(PRESIGN_TIMEOUT_MS),
      });
      const body = (await presign.json().catch(() => null)) as
        | { data?: { uploadUrl?: unknown; downloadUrl?: unknown } }
        | null;
      const uploadUrl = body?.data?.uploadUrl;
      const downloadUrl = body?.data?.downloadUrl;
      if (!presign.ok || !isHttpUrl(uploadUrl) || !isHttpUrl(downloadUrl)) {
        logJson('outgoing', 'http', 'media presign failed', {
          status: presign.status,
          body: body ?? null,
        });
        return null;
      }

      // The content type is part of the signature, so it must match the presign
      // exactly or the storage server answers 403.
      const put = await fetchFn(uploadUrl.trim(), {
        method: 'PUT',
        headers: { 'content-type': mimetype },
        body: bytes as BodyInit,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      if (!put.ok) {
        logJson('outgoing', 'http', 'media upload failed', { status: put.status, mimetype });
        return null;
      }
      logJson('outgoing', 'http', 'media uploaded', { url: downloadUrl.trim(), length: bytes.byteLength });
      return { url: downloadUrl.trim() };
    } catch (error) {
      logJson('outgoing', 'http', 'media upload error', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };
}
