import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { configPath, ensureDir } from './paths';
import { DEFAULT_PORT, type AppConfig } from './types';

export function loadOrCreateConfig(root: string, port: number = DEFAULT_PORT): AppConfig {
  ensureDir(root);
  const file = configPath(root);
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppConfig>;
    if (typeof parsed.token === 'string' && parsed.token !== '') {
      const cfg: AppConfig = {
        token: parsed.token,
        port: typeof parsed.port === 'number' ? parsed.port : port,
      };
      if (cfg.port !== port) {
        cfg.port = port;
        writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
      }
      return cfg;
    }
  }
  const cfg: AppConfig = { token: randomBytes(24).toString('hex'), port };
  writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return cfg;
}

export function bearerToken(header: string | undefined): string | null {
  if (header == null || header === '') return null;
  const match = /^Bearer\s+(\S+)/i.exec(header);
  return match?.[1] ?? null;
}
