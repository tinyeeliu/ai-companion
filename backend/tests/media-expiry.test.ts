import { describe, expect, test } from 'bun:test';
import { WHATSAPP_MEDIA_TTL_MS, expiryFromUrl, whatsappMediaExpiryMs } from '../src/media/expiry';

/**
 * The url of a real inbound image, exactly as WhatsApp minted it.
 *
 * `oe=6ADCAB3C` is 1792846652, i.e. 2026-10-24T12:57:32Z — 30.07 days after the
 * `mediaKeyTimestamp` of 1790248346 on the same proto.
 */
const REAL_URL =
  'https://mmg.whatsapp.net/v/t62.7118-24/814899669_955161900346874_8835798806796056987_n.enc' +
  '?ccb=11-4&oh=01_Q5Aa5gECGn4oNapYPGpcCxlSzRaIq7pwk5-HrMOVX-cTct9RLQ&oe=6ADCAB3C&_nc_sid=5e03e0&mms3=true';

const REAL_OE_MS = 1_792_846_652_000;
const REAL_MINTED = 1_790_248_346;

describe('expiryFromUrl', () => {
  test('reads the hex `oe` WhatsApp declares', () => {
    expect(expiryFromUrl(REAL_URL)).toBe(REAL_OE_MS);
  });

  test('still reads it when the url is not something `URL` accepts', () => {
    // A directPath is relative, and a vendor url can arrive truncated; neither
    // should cost us the expiry when the parameter is plainly there.
    expect(expiryFromUrl('/v/t62/x.enc?oe=6ADCAB3C')).toBe(REAL_OE_MS);
    expect(expiryFromUrl('not a url at all?oe=6ADCAB3C')).toBe(REAL_OE_MS);
  });

  test('a missing, empty, or unreadable `oe` is "no expiry declared"', () => {
    expect(expiryFromUrl('https://mmg.whatsapp.net/v/x.enc?ccb=11-4')).toBeNull();
    expect(expiryFromUrl('https://mmg.whatsapp.net/v/x.enc?oe=')).toBeNull();
    expect(expiryFromUrl('https://mmg.whatsapp.net/v/x.enc?oe=zzzz')).toBeNull();
    expect(expiryFromUrl('https://mmg.whatsapp.net/v/x.enc?oe=0')).toBeNull();
    expect(expiryFromUrl('')).toBeNull();
    expect(expiryFromUrl(undefined)).toBeNull();
  });
});

describe('whatsappMediaExpiryMs', () => {
  test('the expiry WhatsApp stated wins over the mint time', () => {
    expect(whatsappMediaExpiryMs({ url: REAL_URL, mediaKeyTimestamp: REAL_MINTED })).toBe(
      REAL_OE_MS,
    );
  });

  test('without one, the mint time plus the observed lifetime', () => {
    // The real pair was 30.07 days apart, so the fallback lands slightly early —
    // which is the safe direction: re-upload a little sooner, never hand out a
    // url whose blob has already been collected.
    expect(whatsappMediaExpiryMs({ mediaKeyTimestamp: REAL_MINTED })).toBe(
      REAL_MINTED * 1000 + WHATSAPP_MEDIA_TTL_MS,
    );
  });

  test('accepts the spellings a decoded proto gives a number in', () => {
    // protobuf numbers arrive as a number, a numeric string, or a Long.
    expect(whatsappMediaExpiryMs({ mediaKeyTimestamp: '1790248346' })).toBe(
      REAL_MINTED * 1000 + WHATSAPP_MEDIA_TTL_MS,
    );
    expect(whatsappMediaExpiryMs({ mediaKeyTimestamp: { toNumber: () => REAL_MINTED } })).toBe(
      REAL_MINTED * 1000 + WHATSAPP_MEDIA_TTL_MS,
    );
  });

  test('nothing usable means no deadline is invented', () => {
    expect(whatsappMediaExpiryMs({})).toBeNull();
    expect(whatsappMediaExpiryMs({ url: 'https://mmg.whatsapp.net/v/x.enc' })).toBeNull();
    expect(whatsappMediaExpiryMs({ mediaKeyTimestamp: 0 })).toBeNull();
    expect(whatsappMediaExpiryMs({ mediaKeyTimestamp: 'nope' })).toBeNull();
    expect(whatsappMediaExpiryMs({ mediaKeyTimestamp: null })).toBeNull();
  });
});
