import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { configPath, ensureDir } from './paths';
import { DEFAULT_PORT, type AppConfig } from './types';

/** A uuid4 with its dashes stripped: 32 lowercase hex characters. */
export function newToken(): string {
  return randomUUID().replace(/-/g, '');
}

/** Tokens are opaque, but bounded so a huge body can never be stored. */
export function isValidToken(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.trim().length <= 256;
}

function writeConfig(root: string, config: AppConfig): void {
  writeFileSync(configPath(root), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * The persisted models directory, or null when unset/unreadable.
 *
 * Read separately from the token because the two are written by different
 * callers: a token change in Settings must not drop a models directory the
 * operator set by hand.
 */
function readConfig(root: string): Partial<AppConfig> | null {
  const file = configPath(root);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Partial<AppConfig>;
  } catch {
    return null;
  }
}

export function configModelsDir(root: string): string | null {
  const parsed = readConfig(root);
  if (parsed == null) return null;
  return typeof parsed.modelsDir === 'string' && parsed.modelsDir.trim() !== ''
    ? parsed.modelsDir.trim()
    : null;
}

/** Speech stays off until Setup turns it on. A missing field is off. */
export function configTtsEnabled(root: string): boolean {
  return readConfig(root)?.ttsEnabled === true;
}

/** Apple Silicon speech checkpoint. A missing field is the English model. */
export function configTtsModel(root: string): 'en' | 'zh' {
  return readConfig(root)?.ttsModel === 'zh' ? 'zh' : 'en';
}

/** Decision stays off until Setup turns it on. A missing field is off. */
export function configDecisionEnabled(root: string): boolean {
  return readConfig(root)?.decisionEnabled === true;
}

/** LLM Gateway stays off until Setup turns it on. A missing field is off. */
export function configLlmEnabled(root: string): boolean {
  return readConfig(root)?.llmEnabled === true;
}

/** The gateway uses the shared proxy only when Setup opts in. A missing field is off. */
export function configLlmUseProxy(root: string): boolean {
  return readConfig(root)?.llmUseProxy === true;
}

/** Shared proxy URL. Empty when unset. */
export function configProxyUrl(root: string): string {
  const value = readConfig(root)?.proxyUrl;
  return typeof value === 'string' ? value.trim() : '';
}

interface ConfigSnapshot {
  token: string;
  port: number;
  modelsDir: string | null;
  ttsEnabled: boolean;
  ttsModel: 'en' | 'zh';
  decisionEnabled: boolean;
  llmEnabled: boolean;
  llmUseProxy: boolean;
  proxyUrl: string;
}

function snapshot(root: string, portDefault: number): ConfigSnapshot {
  const parsed = readConfig(root);
  return {
    token: typeof parsed?.token === 'string' ? parsed.token : '',
    port: typeof parsed?.port === 'number' ? parsed.port : portDefault,
    modelsDir: configModelsDir(root),
    ttsEnabled: parsed?.ttsEnabled === true,
    ttsModel: parsed?.ttsModel === 'zh' ? 'zh' : 'en',
    decisionEnabled: parsed?.decisionEnabled === true,
    llmEnabled: parsed?.llmEnabled === true,
    llmUseProxy: parsed?.llmUseProxy === true,
    proxyUrl: typeof parsed?.proxyUrl === 'string' ? parsed.proxyUrl.trim() : '',
  };
}

/** Write a full config. Callers pass a snapshot so a token save cannot drop a switch. */
function persist(root: string, config: ConfigSnapshot): AppConfig {
  ensureDir(root);
  writeConfig(root, config);
  return config;
}

function patchConfig(root: string, patch: Partial<ConfigSnapshot>, portDefault = DEFAULT_PORT): AppConfig {
  const current = snapshot(root, portDefault);
  const token = patch.token ?? (current.token !== '' ? current.token : newToken());
  return persist(root, { ...current, ...patch, token });
}

export function loadOrCreateConfig(root: string, port: number = DEFAULT_PORT): AppConfig {
  ensureDir(root);
  const file = configPath(root);
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppConfig>;
      if (typeof parsed.token === 'string' && parsed.token !== '') {
        const cfg = snapshot(root, port);
        if (cfg.port !== port) return persist(root, { ...cfg, port });
        return cfg;
      }
    } catch {
      /* unreadable config: replace it below */
    }
  }
  return persist(root, {
    token: newToken(),
    port,
    modelsDir: null,
    ttsEnabled: false,
    ttsModel: 'en',
    decisionEnabled: false,
    llmEnabled: false,
    llmUseProxy: false,
    proxyUrl: '',
  });
}

/**
 * Persist a token chosen in the Settings page. `config.json` is the only home
 * for it — never SQLite. The stored port is preserved as-is: this call must not
 * reset a custom `COMPANION_PORT` back to the default. The caller holds the
 * returned value so the live guard reads the new token without a restart.
 */
export function setConfigToken(root: string, token: string): AppConfig {
  return patchConfig(root, { token });
}

/**
 * Persist the Setup page's speech switch. The token, port, and models directory
 * stay as they are — this call must not rotate a credential or move a model dir.
 */
export function setConfigTtsEnabled(root: string, enabled: boolean): AppConfig {
  return patchConfig(root, { ttsEnabled: enabled });
}

/** Persist the Setup selector. The token, port, models directory, and switch stay. */
export function setConfigTtsModel(root: string, model: 'en' | 'zh'): AppConfig {
  return patchConfig(root, { ttsModel: model });
}

/**
 * Persist the Setup page's decision switch. The token, port, models directory,
 * and speech settings stay as they are.
 */
export function setConfigDecisionEnabled(root: string, enabled: boolean): AppConfig {
  return patchConfig(root, { decisionEnabled: enabled });
}

export function setConfigLlmEnabled(root: string, enabled: boolean): AppConfig {
  return patchConfig(root, { llmEnabled: enabled });
}

export function setConfigLlmUseProxy(root: string, useProxy: boolean): AppConfig {
  return patchConfig(root, { llmUseProxy: useProxy });
}

/** Empty clears the proxy. A feature that opted in then stops using one. */
export function setConfigProxyUrl(root: string, proxyUrl: string): AppConfig {
  return patchConfig(root, { proxyUrl: proxyUrl.trim() });
}

export function bearerToken(header: string | undefined): string | null {
  if (header == null || header === '') return null;
  const match = /^Bearer\s+(\S+)/i.exec(header);
  return match?.[1] ?? null;
}
