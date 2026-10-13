/**
 * @fileoverview OpenAI Create speech request, and only that.
 *
 * Unknown fields are a 400, matching image generation. Two deliberate
 * divergences: `mp3` is OpenAI's default format and we have no encoder, so the
 * default here is `wav`; `sse` streaming is refused rather than faked as one
 * buffered event.
 */
import { HttpError } from '../types';
import { TTS_MODELS, type TtsModelId } from './models';
import { resolveVoice, type ResolvedVoice } from './voices';

const ALLOWED_KEYS = new Set([
  'model',
  'input',
  'voice',
  'response_format',
  'speed',
  'instructions',
  'stream_format',
]);

const REFUSED_FORMATS = ['mp3', 'opus', 'aac', 'flac'] as const;
const MAX_INPUT = 4096;

export interface SpeechJob {
  input: string;
  voice: ResolvedVoice;
  speed: number;
  format: 'wav' | 'pcm';
}

export function parseSpeechRequest(body: Record<string, unknown>, loaded: TtsModelId | null = null): SpeechJob {
  const unknownKeys = Object.keys(body).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new HttpError(
      400,
      'INVALID_PARAM',
      `unsupported field(s): ${unknownKeys.join(', ')}. Supported: ${[...ALLOWED_KEYS].join(', ')}`,
    );
  }

  if (body.model !== 'kokoro-82m') {
    throw new HttpError(400, 'INVALID_PARAM', 'model must be kokoro-82m');
  }

  const input = typeof body.input === 'string' ? body.input.trim() : '';
  if (input === '') throw new HttpError(400, 'INVALID_PARAM', 'input is required');
  if (input.length > MAX_INPUT) {
    throw new HttpError(400, 'INVALID_PARAM', `input must be at most ${MAX_INPUT} characters`);
  }

  const voiceName = voiceNameOf(body.voice);
  const voice = voiceName == null ? null : resolveLoadedVoice(voiceName, loaded);
  if (voice == null) {
    throw new HttpError(
      400,
      'INVALID_PARAM',
      'voice must be "default", a Kokoro voice id, an os/ voice, or alloy, echo, fable, onyx, nova',
    );
  }

  let format: 'wav' | 'pcm' = 'wav';
  if (body.response_format != null) {
    if (body.response_format === 'wav' || body.response_format === 'pcm') {
      format = body.response_format;
    } else if ((REFUSED_FORMATS as readonly string[]).includes(String(body.response_format))) {
      throw new HttpError(400, 'INVALID_PARAM', 'response_format must be wav or pcm');
    } else {
      throw new HttpError(400, 'INVALID_PARAM', 'response_format must be wav or pcm');
    }
  }

  let speed = 1;
  if (body.speed != null) {
    if (typeof body.speed !== 'number' || !Number.isFinite(body.speed) || body.speed < 0.25 || body.speed > 4) {
      throw new HttpError(400, 'INVALID_PARAM', 'speed must be a number from 0.25 to 4.0');
    }
    speed = body.speed;
  }

  if (body.instructions != null && typeof body.instructions !== 'string') {
    throw new HttpError(400, 'INVALID_PARAM', 'instructions must be a string');
  }

  if (body.stream_format != null && body.stream_format !== 'audio') {
    throw new HttpError(400, 'INVALID_PARAM', 'stream_format must be audio');
  }

  return { input, voice, speed, format };
}

function resolveLoadedVoice(name: string, loaded: TtsModelId | null): ResolvedVoice | null {
  const os = osVoice(name);
  if (name.trim().startsWith('os/')) return os;
  if (loaded === 'zh') {
    const trimmed = name.trim();
    const id = trimmed === 'default' ? TTS_MODELS.zh.voice : trimmed;
    if (!/^[a-z]{2}_[a-z0-9_]+$/i.test(id)) return null;
    return { id, sid: 0 };
  }
  return resolveVoice(name);
}

function osVoice(name: string): ResolvedVoice | null {
  const osName = name.trim().slice(3).trim();
  if (osName === '' || osName.includes('/')) return null;
  return { id: `os/${osName}`, sid: 0, osName };
}

function voiceNameOf(voice: unknown): string | null {
  if (typeof voice === 'string') return voice;
  if (voice != null && typeof voice === 'object' && !Array.isArray(voice)) {
    const id = (voice as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return null;
}
