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

export function loadOrCreateConfig(root: string, port: number = DEFAULT_PORT): AppConfig {
  ensureDir(root);
  const file = configPath(root);
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppConfig>;
    if (typeof parsed.token === 'string' && parsed.token !== '') {
      const cfg: AppConfig = {
        token: parsed.token,
        port: typeof parsed.port === 'number' ? parsed.port : port,
        modelsDir: configModelsDir(root),
        ttsEnabled: parsed.ttsEnabled === true,
        ttsModel: parsed.ttsModel === 'zh' ? 'zh' : 'en',
        decisionEnabled: parsed.decisionEnabled === true,
      };
      if (cfg.port !== port) {
        cfg.port = port;
        writeConfig(root, cfg);
      }
      return cfg;
    }
  }
  const cfg: AppConfig = {
    token: newToken(),
    port,
    modelsDir: null,
    ttsEnabled: false,
    ttsModel: 'en',
    decisionEnabled: false,
  };
  writeConfig(root, cfg);
  return cfg;
}

/**
 * Persist a token chosen in the Settings page. `config.json` is the only home
 * for it — never SQLite. The stored port is preserved as-is: this call must not
 * reset a custom `COMPANION_PORT` back to the default. The caller holds the
 * returned value so the live guard reads the new token without a restart.
 */
export function setConfigToken(root: string, token: string): AppConfig {
  ensureDir(root);
  const file = configPath(root);
  let port = DEFAULT_PORT;
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppConfig>;
      if (typeof parsed.port === 'number') port = parsed.port;
    } catch {
      /* unreadable config: fall back to the default port */
    }
  }
  const cfg: AppConfig = {
    token,
    port,
    modelsDir: configModelsDir(root),
    ttsEnabled: configTtsEnabled(root),
    ttsModel: configTtsModel(root),
    decisionEnabled: configDecisionEnabled(root),
  };
  writeConfig(root, cfg);
  return cfg;
}

/**
 * Persist the Setup page's speech switch. The token, port, and models directory
 * stay as they are — this call must not rotate a credential or move a model dir.
 */
export function setConfigTtsEnabled(root: string, enabled: boolean): AppConfig {
  ensureDir(root);
  const file = configPath(root);
  let token = '';
  let port = DEFAULT_PORT;
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppConfig>;
      if (typeof parsed.token === 'string') token = parsed.token;
      if (typeof parsed.port === 'number') port = parsed.port;
    } catch {
      /* unreadable config: keep the defaults and still record the switch */
    }
  }
  if (token === '') token = newToken();
  const cfg: AppConfig = {
    token,
    port,
    modelsDir: configModelsDir(root),
    ttsEnabled: enabled,
    ttsModel: configTtsModel(root),
    decisionEnabled: configDecisionEnabled(root),
  };
  writeConfig(root, cfg);
  return cfg;
}

/** Persist the Setup selector. The token, port, models directory, and switch stay. */
export function setConfigTtsModel(root: string, model: 'en' | 'zh'): AppConfig {
  ensureDir(root);
  const file = configPath(root);
  let token = '';
  let port = DEFAULT_PORT;
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppConfig>;
      if (typeof parsed.token === 'string') token = parsed.token;
      if (typeof parsed.port === 'number') port = parsed.port;
    } catch {
      /* unreadable config: keep the defaults and still record the model */
    }
  }
  if (token === '') token = newToken();
  const cfg: AppConfig = {
    token,
    port,
    modelsDir: configModelsDir(root),
    ttsEnabled: configTtsEnabled(root),
    ttsModel: model,
    decisionEnabled: configDecisionEnabled(root),
  };
  writeConfig(root, cfg);
  return cfg;
}

/**
 * Persist the Setup page's decision switch. The token, port, models directory,
 * and speech settings stay as they are.
 */
export function setConfigDecisionEnabled(root: string, enabled: boolean): AppConfig {
  ensureDir(root);
  const file = configPath(root);
  let token = '';
  let port = DEFAULT_PORT;
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppConfig>;
      if (typeof parsed.token === 'string') token = parsed.token;
      if (typeof parsed.port === 'number') port = parsed.port;
    } catch {
      /* unreadable config: keep the defaults and still record the switch */
    }
  }
  if (token === '') token = newToken();
  const cfg: AppConfig = {
    token,
    port,
    modelsDir: configModelsDir(root),
    ttsEnabled: configTtsEnabled(root),
    ttsModel: configTtsModel(root),
    decisionEnabled: enabled,
  };
  writeConfig(root, cfg);
  return cfg;
}

export function bearerToken(header: string | undefined): string | null {
  if (header == null || header === '') return null;
  const match = /^Bearer\s+(\S+)/i.exec(header);
  return match?.[1] ?? null;
}
