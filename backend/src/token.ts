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
export function configModelsDir(root: string): string | null {
  const file = configPath(root);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppConfig>;
    return typeof parsed.modelsDir === 'string' && parsed.modelsDir.trim() !== ''
      ? parsed.modelsDir.trim()
      : null;
  } catch {
    return null;
  }
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
      };
      if (cfg.port !== port) {
        cfg.port = port;
        writeConfig(root, cfg);
      }
      return cfg;
    }
  }
  const cfg: AppConfig = { token: newToken(), port, modelsDir: null };
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
  const cfg: AppConfig = { token, port, modelsDir: configModelsDir(root) };
  writeConfig(root, cfg);
  return cfg;
}

export function bearerToken(header: string | undefined): string | null {
  if (header == null || header === '') return null;
  const match = /^Bearer\s+(\S+)/i.exec(header);
  return match?.[1] ?? null;
}
