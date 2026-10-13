/**
 * The two Kokoro checkpoints the Apple Silicon selector can load.
 * One is in memory at a time. `"default"` is that checkpoint's own voice.
 */
export type TtsModelId = 'en' | 'zh';

export interface TtsModelSpec {
  id: TtsModelId;
  repo: string;
  /** mlx-audio Kokoro language code. */
  lang: string;
  voice: string;
  testInput: string;
}

export const TTS_MODELS: Record<TtsModelId, TtsModelSpec> = {
  en: {
    id: 'en',
    repo: 'mlx-community/Kokoro-82M-bf16',
    lang: 'a',
    voice: 'af_heart',
    testInput: 'Hello from AI Companion.',
  },
  zh: {
    id: 'zh',
    repo: 'FluidInference/kokoro-82m-v1.1-zh-mlx',
    lang: 'z',
    voice: 'zf_001',
    testInput: '你好，这是一段本地语音测试。',
  },
};

export function parseTtsModel(value: unknown): TtsModelId | null {
  if (value === 'en' || value === 'zh') return value;
  return null;
}

/** British voices on the English checkpoint use lang `b`. Chinese is always `z`. */
export function speechLang(model: TtsModelId, voiceId: string): string {
  if (model === 'zh') return 'z';
  if (voiceId.startsWith('bf_') || voiceId.startsWith('bm_')) return 'b';
  return 'a';
}
