import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  attachCompanionMedia,
  COMPANION_FRAME_MEDIA_BUDGET_BYTES,
  COMPANION_MEDIA_MAX_BYTES,
  messageType,
} from '../src/whatsapp';

/** SHA-256 as the wire carries it: base64url, unpadded. */
function base64Url(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('base64url');
}

const BYTES = new Uint8Array([1, 2, 3, 4]);

describe('WhatsApp message classification', () => {
  test('classifies bare conversation text with message metadata', () => {
    const message = {
      message: {
        conversation: 'Hi',
        messageContextInfo: {
          deviceListMetadataVersion: 2,
        },
      },
    };

    expect(messageType(message as never)).toBe('text');
  });
});

describe('attachCompanionMedia', () => {
  test('attaches bytes with the plaintext hash and length', async () => {
    const plan = await attachCompanionMedia({
      kind: 'image',
      declaredLength: BYTES.byteLength,
      remaining: COMPANION_FRAME_MEDIA_BUDGET_BYTES,
      mimetype: 'image/jpeg',
      decrypt: async () => BYTES,
    });

    expect(plan.block).toMatchObject({ mimetype: 'image/jpeg', length: BYTES.byteLength });
    // Base64url without padding: 43 chars for a 32-byte digest.
    expect(plan.block?.sha256).toBe(base64Url(BYTES));
    expect(plan.block?.sha256).toHaveLength(43);
    expect(plan.block?.sha256).not.toContain('=');
    expect(plan.remaining).toBe(COMPANION_FRAME_MEDIA_BUDGET_BYTES - BYTES.byteLength);
  });

  test('a non-media kind is never attached, and never decrypted', async () => {
    let decrypted = false;
    const plan = await attachCompanionMedia({
      kind: 'sticker',
      declaredLength: 4,
      remaining: COMPANION_FRAME_MEDIA_BUDGET_BYTES,
      decrypt: async () => {
        decrypted = true;
        return BYTES;
      },
    });
    expect(plan.block).toBeNull();
    expect(decrypted).toBe(false);
  });

  test('a declared length over the frame budget is rejected before the download', async () => {
    let decrypted = false;
    const plan = await attachCompanionMedia({
      kind: 'video',
      declaredLength: COMPANION_FRAME_MEDIA_BUDGET_BYTES + 1,
      remaining: COMPANION_FRAME_MEDIA_BUDGET_BYTES,
      decrypt: async () => {
        decrypted = true;
        return BYTES;
      },
    });
    expect(plan.block).toBeNull();
    expect(decrypted).toBe(false);
    expect(plan.remaining).toBe(COMPANION_FRAME_MEDIA_BUDGET_BYTES);
  });

  test('a file over the per-file cap is dropped after the download', async () => {
    const huge = new Uint8Array(COMPANION_MEDIA_MAX_BYTES + 1);
    const plan = await attachCompanionMedia({
      kind: 'document',
      declaredLength: null,
      remaining: COMPANION_FRAME_MEDIA_BUDGET_BYTES,
      decrypt: async () => huge,
    });
    expect(plan.block).toBeNull();
    expect(plan.remaining).toBe(COMPANION_FRAME_MEDIA_BUDGET_BYTES);
  });

  test('a failed decrypt, an empty blob and an exhausted budget ship no block', async () => {
    const failed = await attachCompanionMedia({
      kind: 'image',
      declaredLength: 4,
      remaining: 1024,
      decrypt: async () => null,
    });
    expect(failed.block).toBeNull();

    const empty = await attachCompanionMedia({
      kind: 'image',
      declaredLength: 0,
      remaining: 1024,
      decrypt: async () => new Uint8Array(0),
    });
    expect(empty.block).toBeNull();

    const spent = await attachCompanionMedia({
      kind: 'image',
      declaredLength: null,
      remaining: 0,
      decrypt: async () => BYTES,
    });
    expect(spent.block).toBeNull();
    expect(spent.remaining).toBe(0);
  });

  test('an album spends the frame budget in arrival order', async () => {
    const each = new Uint8Array(4 * 1024 * 1024);
    let remaining = COMPANION_FRAME_MEDIA_BUDGET_BYTES;
    const attached: number[] = [];
    // Two 4 MB photos exceed the 6 MB frame budget, so only the first ships.
    for (const index of [0, 1]) {
      const plan = await attachCompanionMedia({
        kind: 'image',
        declaredLength: each.byteLength,
        remaining,
        decrypt: async () => each,
      });
      remaining = plan.remaining;
      if (plan.block != null) attached.push(index);
    }
    expect(attached).toEqual([0]);
    expect(remaining).toBe(COMPANION_FRAME_MEDIA_BUDGET_BYTES - each.byteLength);
  });

  test('an upload carries a url instead of bytes and spends no frame budget', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const uploaded: Array<string | number> = [];
    const plan = await attachCompanionMedia({
      kind: 'image',
      declaredLength: bytes.byteLength,
      remaining: COMPANION_FRAME_MEDIA_BUDGET_BYTES,
      mimetype: 'image/jpeg',
      decrypt: async () => bytes,
      upload: async (buffer, mimetype) => {
        uploaded.push(buffer.byteLength, mimetype);
        return { url: 'https://workspacetest.supermama.academy/temp/abc.jpeg' };
      },
    });
    expect(plan.block).toMatchObject({
      url: 'https://workspacetest.supermama.academy/temp/abc.jpeg',
      mimetype: 'image/jpeg',
      sha256: base64Url(bytes),
      length: 4,
    });
    expect(plan.block?.bytes).toBeUndefined();
    // Nothing rode the frame, so the budget is untouched for the next message.
    expect(plan.remaining).toBe(COMPANION_FRAME_MEDIA_BUDGET_BYTES);
    expect(uploaded).toEqual([4, 'image/jpeg']);
  });

  test('a media file over the frame budget still uploads, since no bytes ride the frame', async () => {
    // 4 MB over a 2 MB budget: impossible inline, fine once uploaded.
    const bytes = new Uint8Array(4 * 1024 * 1024);
    let decrypted = false;
    const plan = await attachCompanionMedia({
      kind: 'video',
      declaredLength: bytes.byteLength,
      remaining: 2 * 1024 * 1024,
      mimetype: 'video/mp4',
      decrypt: async () => {
        decrypted = true;
        return bytes;
      },
      upload: async () => ({ url: 'https://workspacetest.supermama.academy/temp/abc.mp4' }),
    });
    expect(decrypted).toBe(true);
    expect(plan.block?.url).toBe('https://workspacetest.supermama.academy/temp/abc.mp4');
    expect(plan.remaining).toBe(2 * 1024 * 1024);
  });

  test('a failed upload falls back to inline bytes', async () => {
    const bytes = new Uint8Array([9, 9, 9]);
    const plan = await attachCompanionMedia({
      kind: 'image',
      declaredLength: bytes.byteLength,
      remaining: COMPANION_FRAME_MEDIA_BUDGET_BYTES,
      mimetype: 'image/jpeg',
      decrypt: async () => bytes,
      upload: async () => null,
    });
    // The message is never worse off than 1A because an upload failed.
    expect(plan.block?.bytes).toBe(bytes);
    expect(plan.block?.url).toBeUndefined();
    expect(plan.remaining).toBe(COMPANION_FRAME_MEDIA_BUDGET_BYTES - bytes.byteLength);
  });

  test('a failed upload with no budget left ships nothing', async () => {
    const bytes = new Uint8Array([9, 9, 9]);
    const plan = await attachCompanionMedia({
      kind: 'image',
      declaredLength: bytes.byteLength,
      remaining: 2,
      decrypt: async () => bytes,
      upload: async () => null,
    });
    expect(plan.block).toBeNull();
    expect(plan.remaining).toBe(2);
  });
});
