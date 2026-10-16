/**
 * `data/llm/` holds the Codex gateway binary. Deleting it returns the feature
 * to "not downloaded".
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { llmDir } from '../paths';
import { gatewayBinaryName } from './assets';

export const GATEWAY_HOST = '127.0.0.1';
export const DEFAULT_GATEWAY_PORT = 18080;
export const DEFAULT_MODEL = 'gpt-5.6-luna';
export const NO_PROXY = 'localhost,127.0.0.1,::1';

const PROXY_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'WS_PROXY', 'WSS_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'ws_proxy', 'wss_proxy',
  'NO_PROXY', 'no_proxy',
];

export function gatewayPort(): number {
  const raw = process.env.LLM_GATEWAY_PORT;
  if (raw == null || raw === '') return DEFAULT_GATEWAY_PORT;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : DEFAULT_GATEWAY_PORT;
}

export function binaryPath(root: string, platform: string = process.platform): string {
  return join(llmDir(root), gatewayBinaryName(platform));
}

export function binaryReady(root: string, platform: string = process.platform): boolean {
  return existsSync(binaryPath(root, platform));
}

export function authJsonPath(): string {
  const fromEnv = process.env.OPENAI_VIA_CODEX_AUTH_JSON;
  if (fromEnv != null && fromEnv.trim() !== '') return fromEnv.trim();
  return join(homedir(), '.codex', 'auth.json');
}

export function incomingDir(root: string): string {
  return join(llmDir(root), 'incoming');
}

/** Child environment. Proxy variables from the parent shell are never inherited. */
export function childEnv(useProxy: boolean, proxyUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of PROXY_KEYS) delete env[key];
  if (useProxy && proxyUrl !== '') {
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.ALL_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
    env.all_proxy = proxyUrl;
    env.NO_PROXY = NO_PROXY;
    env.no_proxy = NO_PROXY;
  }
  return env;
}

export function isProxyUrl(value: string): boolean {
  if (value === '') return true;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch {
    return false;
  }
}
