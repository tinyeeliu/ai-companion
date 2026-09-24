/**
 * @fileoverview When WhatsApp stops serving a media blob.
 *
 * A media proto points at a CDN blob WhatsApp mints per upload, and that blob is
 * not kept forever. The url says when it dies: the `oe` query parameter is the
 * expiry as a unix timestamp in hex. Recording it next to the proto is what lets
 * a cached proto be reused while the blob is live and re-uploaded once it is not,
 * instead of guessing a flat lifetime.
 *
 * Measured on a real inbound image: `oe=6ADCAB3C` decodes to 30.07 days after
 * `mediaKeyTimestamp`, which is where `WHATSAPP_MEDIA_TTL_MS` comes from.
 */

/**
 * What WhatsApp's CDN appears to keep a blob for, used only when a digest-less
 * proto gives us `mediaKeyTimestamp` but no readable `oe`.
 *
 * This is an observation, not a published constant: it is the observed gap
 * between `oe` and `mediaKeyTimestamp`. Being a day short is harmless (it only
 * means a refresh slightly earlier), while being long is what would hand out a
 * dead url, so the rounding here is deliberately conservative.
 */
export const WHATSAPP_MEDIA_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The `oe` parameter as milliseconds, or null when the url carries none. */
export function expiryFromUrl(url: string | null | undefined): number | null {
  const trimmed = (url ?? '').trim();
  if (trimmed === '') return null;
  let oe: string | null = null;
  try {
    oe = new URL(trimmed).searchParams.get('oe');
  } catch {
    // A relative or malformed url still gets one chance below: the expiry is a
    // query parameter, so the raw text can be searched without a parser.
    oe = null;
  }
  if (oe == null) {
    const match = /[?&]oe=([0-9a-fA-F]+)/.exec(trimmed);
    if (match == null) return null;
    oe = match[1] ?? null;
  }
  return oeSecondsToMs(oe);
}

/**
 * A proto's `mediaKeyTimestamp` as milliseconds.
 *
 * Read from `unknown` because protobuf numbers arrive as a `number`, a numeric
 * string, or a Long, and the caller only has the decoded proto.
 */
function timestampToMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value * 1000 : null;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : null;
  }
  if (value != null && typeof value === 'object') {
    const toNumber = (value as { toNumber?: unknown }).toNumber;
    if (typeof toNumber === 'function') {
      const parsed = (toNumber as () => number).call(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : null;
    }
  }
  return null;
}

/** Hex unix seconds as milliseconds. Empty or non-hex is "no expiry known". */
function oeSecondsToMs(value: string | null): number | null {
  const token = (value ?? '').trim();
  if (token === '' || !/^[0-9a-fA-F]+$/.test(token)) return null;
  const seconds = Number.parseInt(token, 16);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/**
 * When the WhatsApp blob behind a media proto stops being downloadable.
 *
 * The declared `oe` wins because WhatsApp stated it. Without one, the proto's own
 * `mediaKeyTimestamp` is the mint time, so the observed lifetime is added to it.
 * Null means nothing was usable and the caller keeps its own conservative
 * fallback rather than inventing a deadline.
 */
export function whatsappMediaExpiryMs(input: {
  url?: string | null;
  mediaKeyTimestamp?: unknown;
}): number | null {
  const fromUrl = expiryFromUrl(input.url);
  if (fromUrl != null) return fromUrl;
  const minted = timestampToMs(input.mediaKeyTimestamp);
  return minted == null ? null : minted + WHATSAPP_MEDIA_TTL_MS;
}
