/**
 * Kokoro v1.0 speaker ids published with sherpa-onnx's
 * `kokoro-multi-lang-v1_0` package. `af_heart` is the generic voice: it is the
 * model's own default and the one `"default"` selects.
 */
const SPEAKERS = [
  'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica',
  'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah',
  'af_sky', 'am_adam', 'am_echo', 'am_eric', 'am_fenrir',
  'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa',
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily', 'bm_daniel',
  'bm_fable', 'bm_george', 'bm_lewis', 'ef_dora', 'em_alex',
  'ff_siwis', 'hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi',
  'if_sara', 'im_nicola', 'jf_alpha', 'jf_gongitsune', 'jf_nezumi',
  'jf_tebukuro', 'jm_kumo', 'pf_dora', 'pm_alex', 'pm_santa',
  'zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi', 'zm_yunjian',
  'zm_yunxi', 'zm_yunxia', 'zm_yunyang',
] as const;

export const DEFAULT_VOICE_ID = 'af_heart';

/** OpenAI voice names that already exist as Kokoro speakers. The rest are rejected. */
const OPENAI_VOICES: Record<string, string> = {
  alloy: 'af_alloy',
  echo: 'am_echo',
  fable: 'bm_fable',
  onyx: 'am_onyx',
  nova: 'af_nova',
};

const SID = new Map<string, number>(SPEAKERS.map((id, sid) => [id, sid]));

export interface ResolvedVoice {
  id: string;
  sid: number;
}

/**
 * Map a request voice onto a Kokoro speaker. `"default"` is the generic voice.
 * Returns null when the name is not one we serve, so the route can answer 400
 * instead of guessing a stand-in.
 */
export function resolveVoice(name: string): ResolvedVoice | null {
  const trimmed = name.trim();
  const id = trimmed === 'default' ? DEFAULT_VOICE_ID : (OPENAI_VOICES[trimmed] ?? trimmed);
  const sid = SID.get(id);
  if (sid == null) return null;
  return { id, sid };
}
