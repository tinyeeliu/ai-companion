/**
 * Voices this machine can speak. Kokoro entries come from checkpoints already
 * on disk. OS entries are the platform synthesizer and do not need a download.
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { mlxHubDir, modelReady, usesMlxEngine } from './layout';
import { TTS_MODELS, type TtsModelId } from './models';
import { listOsVoices, type OsVoice } from './os';
import { sherpaVoiceIds } from './voices';

export type VoiceGender = 'MALE' | 'FEMALE' | 'NEUTRAL';

export interface VoiceInfo {
  id: string;
  name: string;
  language_codes: string[];
  gender: VoiceGender;
  vendor: 'kokoro' | 'os';
}

const LANG: Record<string, string> = {
  a: 'en-US',
  b: 'en-GB',
  e: 'es-ES',
  f: 'fr-FR',
  h: 'hi-IN',
  i: 'it-IT',
  j: 'ja-JP',
  p: 'pt-BR',
  z: 'zh-CN',
};

/** Display metadata for one Kokoro id. `af_heart` is Heart, en-US, female. */
export function kokoroVoice(id: string): VoiceInfo {
  const prefix = id.slice(0, 2);
  const rest = id.slice(3);
  const named = rest !== '' && !/^\d+$/.test(rest);
  const name = named ? rest.charAt(0).toUpperCase() + rest.slice(1) : id;
  const gender: VoiceGender = prefix[1] === 'f' ? 'FEMALE' : prefix[1] === 'm' ? 'MALE' : 'NEUTRAL';
  return {
    id,
    name,
    language_codes: [LANG[prefix[0] ?? ''] ?? 'en-US'],
    gender,
    vendor: 'kokoro',
  };
}

export async function listVoices(root: string): Promise<VoiceInfo[]> {
  const kokoro = (await kokoroIds(root)).map(kokoroVoice);
  kokoro.sort((a, b) => a.id.localeCompare(b.id));
  const os = (await listOsVoices()).map(toVoice);
  os.sort((a, b) => a.name.localeCompare(b.name));
  return [...kokoro, ...os];
}

function toVoice(voice: OsVoice): VoiceInfo {
  return {
    id: `os/${voice.name}`,
    name: voice.name,
    language_codes: [voice.language],
    gender: voice.gender,
    vendor: 'os',
  };
}

/**
 * The checkpoint that owns this voice file. `af_heart` is only in the English
 * snapshot; `zf_001` is only in the Chinese one. A name in both, or in neither,
 * returns null so the caller keeps the Setup selection.
 */
export async function modelForKokoroVoice(root: string, voiceId: string): Promise<TtsModelId | null> {
  const inEn = (await snapshotVoiceIds(root, 'en', '.safetensors')).includes(voiceId);
  const inZh = (await snapshotVoiceIds(root, 'zh', '.npy')).includes(voiceId);
  if (inEn && !inZh) return 'en';
  if (inZh && !inEn) return 'zh';
  return null;
}

async function kokoroIds(root: string): Promise<string[]> {
  if (usesMlxEngine()) {
    const ids = new Set<string>();
    for (const id of await snapshotVoiceIds(root, 'en', '.safetensors')) ids.add(id);
    for (const id of await snapshotVoiceIds(root, 'zh', '.npy')) ids.add(id);
    return [...ids];
  }
  if (!modelReady(root)) return [];
  return [...sherpaVoiceIds()];
}

async function snapshotVoiceIds(root: string, model: TtsModelId, ext: string): Promise<string[]> {
  const repo = TTS_MODELS[model].repo.replaceAll('/', '--');
  const folder = join(mlxHubDir(root), `models--${repo}`);
  if (!existsSync(folder)) return [];
  const ids: string[] = [];
  const entries = await readdir(folder, { recursive: true });
  for (const entry of entries) {
    const rel = entry.toString().replaceAll('\\', '/');
    if (!rel.includes('/voices/')) continue;
    if (!rel.endsWith(ext)) continue;
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    const id = base.slice(0, -ext.length);
    if (id === '' || id.includes('/')) continue;
    ids.push(id);
  }
  return ids;
}
