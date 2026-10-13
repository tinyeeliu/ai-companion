/**
 * Where the Setup download puts laya-multilingual and its Python environment.
 * `data/decision/` is the whole feature, separate from `data/tts/` so the two
 * package pins never share a venv. Deleting it returns decision to "not downloaded".
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { decisionDir } from '../paths';

/** Apple Silicon only. Every other machine gets no download and no model. */
export function supportsDecision(platform = process.platform, arch = process.arch): boolean {
  return platform === 'darwin' && arch === 'arm64';
}

export function pythonDir(root: string): string {
  return join(decisionDir(root), 'python');
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

export function hubDir(root: string): string {
  return join(decisionDir(root), 'hub');
}

export function modelMarker(root: string): string {
  return join(decisionDir(root), 'ready');
}

export function modelReady(root: string): boolean {
  return existsSync(modelMarker(root));
}

export function incomingDir(root: string): string {
  return join(decisionDir(root), 'incoming');
}

/** Env for uv and the decision worker. Caches stay under data/decision. */
export function workerEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    HF_HOME: join(decisionDir(root), 'hf'),
    HF_HUB_CACHE: hubDir(root),
    COMPANION_DECISION_ROOT: decisionDir(root),
    UV_PYTHON_INSTALL_DIR: join(pythonDir(root), 'pythons'),
    UV_CACHE_DIR: join(pythonDir(root), 'cache'),
  };
}
