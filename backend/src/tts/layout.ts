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
const MLX_DIR_NAME = 'mlx';
export const MLX_BINARY_NAME = 'KokoroCLI';
export const MLX_MODEL_FILE = 'kokoro-v1_0.safetensors';
export const MLX_DEFAULT_VOICE = 'af_heart.npy';
const BINARY_NAME = process.platform === 'win32' ? 'sherpa-onnx-offline-tts.exe' : 'sherpa-onnx-offline-tts';

/** Apple Silicon speaks with KokoroCLI (MLX). Every other machine stays on sherpa. */
export function usesMlxEngine(platform = process.platform, arch = process.arch): boolean {
  return platform === 'darwin' && arch === 'arm64';
}

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

export function mlxDir(root: string): string {
  return join(ttsDir(root), MLX_DIR_NAME);
}

export function pythonDir(root: string): string {
  return join(ttsDir(root), 'python');
}

export function pythonBin(root: string): string {
  return join(pythonDir(root), 'venv', 'bin', 'python');
}

export function uvBin(root: string): string {
  return join(pythonDir(root), 'uv');
}

export function pythonReady(root: string): boolean {
  return existsSync(join(pythonDir(root), 'python.ready')) && existsSync(pythonBin(root));
}

export function mlxHubDir(root: string): string {
  return join(mlxDir(root), 'hub');
}

export function modelMarker(root: string, model: string): string {
  return join(mlxDir(root), 'ready', model);
}

export function mlxModelReady(root: string, model: string): boolean {
  return existsSync(modelMarker(root, model));
}

/** Env for uv and the speech worker. Caches stay under data/tts. */
export function workerEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    HF_HOME: join(mlxDir(root), 'hf'),
    HF_HUB_CACHE: mlxHubDir(root),
    COMPANION_TTS_ROOT: ttsDir(root),
    UV_PYTHON_INSTALL_DIR: join(pythonDir(root), 'pythons'),
    UV_CACHE_DIR: join(pythonDir(root), 'cache'),
  };
}

export function mlxVoicePath(root: string, voiceId: string): string {
  return join(mlxDir(root), 'voices', `${voiceId}.npy`);
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

/** Weights, the default voice, and the KokoroCLI binary are all present. */
export function mlxReady(root: string): boolean {
  const dir = mlxDir(root);
  return existsSync(join(dir, 'config.json'))
    && existsSync(join(dir, MLX_MODEL_FILE))
    && existsSync(join(dir, 'voices', MLX_DEFAULT_VOICE))
    && existsSync(join(dir, MLX_BINARY_NAME));
}

export async function findMlxBinary(root: string): Promise<string | null> {
  const bin = join(mlxDir(root), MLX_BINARY_NAME);
  return existsSync(bin) ? bin : null;
}

export async function findEngineBinary(root: string): Promise<string | null> {
  const dir = engineDir(root);
  if (!existsSync(dir)) return null;
  return findNamed(dir, BINARY_NAME);
}

export async function libraryDirs(root: string): Promise<string[]> {
  return sharedLibraryDirs(engineDir(root));
}

export async function mlxLibraryDirs(root: string): Promise<string[]> {
  return sharedLibraryDirs(mlxDir(root));
}

async function sharedLibraryDirs(dir: string): Promise<string[]> {
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
