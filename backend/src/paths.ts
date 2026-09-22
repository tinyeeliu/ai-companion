import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Channel } from './channel';
import { DEFAULT_PORT } from './types';

const here = dirname(fileURLToPath(import.meta.url));

/** companion/backend/src → companion/ */
export const COMPANION_ROOT = resolve(here, '../..');
export const FRONTEND_DIR = frontendDir();

function frontendDir(): string {
  const fromEnv = process.env.COMPANION_FRONTEND_DIR;
  if (fromEnv != null && fromEnv !== '') return resolve(fromEnv);
  const dist = join(COMPANION_ROOT, 'frontend/dist');
  if (existsSync(join(dist, 'index.html'))) return dist;
  return join(COMPANION_ROOT, 'frontend');
}

export function dataDir(): string {
  const fromEnv = process.env.COMPANION_DATA_DIR;
  if (fromEnv != null && fromEnv !== '') return resolve(fromEnv);
  return join(COMPANION_ROOT, 'data');
}

export function listenPort(): number {
  const raw = process.env.COMPANION_PORT;
  if (raw == null || raw === '') return DEFAULT_PORT;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PORT;
}

export function configPath(root: string): string {
  return join(root, 'config.json');
}

export function channelRoot(root: string, channel: Channel): string {
  return join(root, channel);
}

export function whatsappRoot(root: string): string {
  return channelRoot(root, 'whatsapp');
}

export function indexPath(root: string, channel: Channel): string {
  return join(channelRoot(root, channel), 'index.json');
}

export function connectionDir(root: string, channel: Channel, id: string): string {
  return join(channelRoot(root, channel), id);
}

export function metaPath(root: string, channel: Channel, id: string): string {
  return join(connectionDir(root, channel, id), 'meta.json');
}

export function authDir(root: string, channel: Channel, id: string): string {
  return join(connectionDir(root, channel, id), 'auth');
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}
