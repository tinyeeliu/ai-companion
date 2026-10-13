/**
 * Where the Setup download puts Kokoro and the sherpa-onnx binary.
 * `data/tts/` is the whole feature: deleting it returns speech to "not downloaded".
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ttsDir } from '../paths';

export const MODEL_DIR_NAME = 'kokoro-multi-lang-v1_0';
const ENGINE_DIR_NAME = 'engine';
const BINARY_NAME = process.platform === 'win32' ? 'sherpa-onnx-offline-tts.exe' : 'sherpa-onnx-offline-tts';

export interface KokoroPaths {
  model: string;
  voices: string;
  tokens: string;
  espeak: string;
  dict: string;
  lexiconUs: string;
  lexiconGb: string;
  lexiconZh: string;
}

export function modelDir(root: string): string {
  return join(ttsDir(root), MODEL_DIR_NAME);
}

export function engineDir(root: string): string {
  return join(ttsDir(root), ENGINE_DIR_NAME);
}

export function incomingDir(root: string): string {
  return join(ttsDir(root), 'incoming');
}

export function kokoroPaths(root: string): KokoroPaths {
  const dir = modelDir(root);
  return {
    model: join(dir, 'model.onnx'),
    voices: join(dir, 'voices.bin'),
    tokens: join(dir, 'tokens.txt'),
    espeak: join(dir, 'espeak-ng-data'),
    dict: join(dir, 'dict'),
    lexiconUs: join(dir, 'lexicon-us-en.txt'),
    lexiconGb: join(dir, 'lexicon-gb-en.txt'),
    lexiconZh: join(dir, 'lexicon-zh.txt'),
  };
}

export function modelReady(root: string): boolean {
  const paths = kokoroPaths(root);
  return Object.values(paths).every((path) => existsSync(path));
}

export async function findEngineBinary(root: string): Promise<string | null> {
  const dir = engineDir(root);
  if (!existsSync(dir)) return null;
  return findNamed(dir, BINARY_NAME);
}

export async function libraryDirs(root: string): Promise<string[]> {
  const dir = engineDir(root);
  if (!existsSync(dir)) return [];
  const ext = process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';
  const dirs = new Set<string>();
  for (const file of await walk(dir)) {
    if (file.endsWith(ext)) dirs.add(dirname(join(dir, file)));
  }
  return [...dirs];
}

async function findNamed(dir: string, name: string): Promise<string | null> {
  for (const file of await walk(dir)) {
    const base = file.split(/[/\\]/).pop();
    if (base === name) return join(dir, file);
  }
  return null;
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.map((entry) => entry.toString());
}
