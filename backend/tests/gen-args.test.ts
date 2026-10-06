/**
 * The models directory is the difference between "this model exists and is
 * usable" and a misleading "model files are missing": the CLI defaults to its
 * own internal directory, so a model on an external drive is invisible unless
 * `--models-dir` is passed. These pin that it reaches every subcommand and that
 * a failure says which directory was searched.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArgs, resolveModelsDir, withSearchedDir } from '../src/gen/drawthings';
import { configModelsDir, loadOrCreateConfig, setConfigToken } from '../src/token';
import { configPath } from '../src/paths';
import type { GenJob } from '../src/gen/queue';

const job: GenJob = { prompt: 'a red cube', model: 'z_image_turbo_1.0_q8p.ckpt' };

describe('resolveModelsDir', () => {
  test('prefers the explicit option over any env', () => {
    expect(
      resolveModelsDir('/explicit', {
        COMPANION_DRAWTHINGS_MODELS_DIR: '/companion',
        DRAWTHINGS_MODELS_DIR: '/native',
      }),
    ).toBe('/explicit');
  });

  test("prefers Companion's own name over the CLI's native variable", () => {
    expect(
      resolveModelsDir(undefined, {
        COMPANION_DRAWTHINGS_MODELS_DIR: '/companion',
        DRAWTHINGS_MODELS_DIR: '/native',
      }),
    ).toBe('/companion');
  });

  test("falls back to the CLI's native variable so existing setups keep working", () => {
    expect(resolveModelsDir(undefined, { DRAWTHINGS_MODELS_DIR: '/native' })).toBe('/native');
  });

  test('returns undefined when nothing is configured', () => {
    expect(resolveModelsDir(undefined, {})).toBeUndefined();
  });

  test('treats blank values as unset rather than as a directory', () => {
    expect(resolveModelsDir(undefined, { COMPANION_DRAWTHINGS_MODELS_DIR: '   ' })).toBeUndefined();
    expect(resolveModelsDir('', { DRAWTHINGS_MODELS_DIR: '' })).toBeUndefined();
  });

  test('trims surrounding whitespace', () => {
    expect(resolveModelsDir(undefined, { DRAWTHINGS_MODELS_DIR: ' /models ' })).toBe('/models');
  });
});

describe('buildArgs', () => {
  test('omits --models-dir when unset, leaving the CLI to its default', () => {
    expect(buildArgs(job, '/tmp/out.png')).not.toContain('--models-dir');
  });

  test('emits --models-dir when configured', () => {
    const args = buildArgs(job, '/tmp/out.png', '/Volumes/drive/models');
    const at = args.indexOf('--models-dir');
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe('/Volumes/drive/models');
  });

  test('keeps the mandatory non-TTY flags alongside it', () => {
    const args = buildArgs(job, '/tmp/out.png', '/models');
    expect(args).toContain('--output');
    expect(args).toContain('--disable-preview');
    expect(args).toContain('--offline');
  });

  test('ignores an empty directory string rather than emitting a bare flag', () => {
    expect(buildArgs(job, '/tmp/out.png', '')).not.toContain('--models-dir');
  });

  test('still passes sampling overrides it was given', () => {
    const args = buildArgs({ ...job, width: 512, height: 512, steps: 8 }, '/tmp/o.png', '/models');
    expect(args).toContain('--width');
    expect(args).toContain('512');
    expect(args).toContain('--height');
    expect(args).toContain('--steps');
    expect(args).toContain('8');
  });
});

describe('withSearchedDir', () => {
  const missing =
    'Error: Offline mode is enabled and model files are missing: - z_image_turbo_1.0_q8p.ckpt';

  test('names the configured directory on a missing-files failure', () => {
    const out = withSearchedDir('model files are missing', '/Volumes/drive/models', missing);
    expect(out).toContain('/Volumes/drive/models');
    expect(out).toContain('searched models directory');
  });

  test('says so when no directory was configured, so the default is not a mystery', () => {
    const out = withSearchedDir('model files are missing', undefined, missing);
    expect(out).toContain('data/config.json');
  });

  test('also matches the single-file variant the CLI prints elsewhere', () => {
    const out = withSearchedDir('Missing file: x.ckpt', '/models', 'Missing file: x.ckpt');
    expect(out).toContain('/models');
  });

  test('leaves unrelated failures untouched', () => {
    const out = withSearchedDir('Failed to parse configuration override JSON', '/models', 'some other error');
    expect(out).toBe('Failed to parse configuration override JSON');
    expect(out).not.toContain('searched');
  });
});

/**
 * The models directory is persisted in `config.json` rather than left to the
 * environment because Companion's lifecycle is owned by an external supervisor
 * (Devctl) that spawns it with no env of its own — so a variable exported in a
 * developer's shell never reaches the running process.
 */
describe('persisted models directory', () => {
  function tempRoot(): string {
    return mkdtempSync(join(tmpdir(), 'companion-gen-cfg-'));
  }

  test('a fresh config defaults to null rather than inventing a path', () => {
    const root = tempRoot();
    try {
      expect(loadOrCreateConfig(root, 38888).modelsDir).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('round-trips a configured directory', () => {
    const root = tempRoot();
    try {
      writeFileSync(
        configPath(root),
        JSON.stringify({ token: 'abc123', port: 38888, modelsDir: '/Volumes/drive/models' }),
      );
      expect(loadOrCreateConfig(root, 38888).modelsDir).toBe('/Volumes/drive/models');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('survives a token change, so saving Settings cannot silently drop it', () => {
    const root = tempRoot();
    try {
      writeFileSync(
        configPath(root),
        JSON.stringify({ token: 'old', port: 38888, modelsDir: '/Volumes/drive/models' }),
      );
      const after = setConfigToken(root, 'new');
      expect(after.modelsDir).toBe('/Volumes/drive/models');
      // And it is still there on the next boot, not just in the returned value.
      expect(loadOrCreateConfig(root, 38888).modelsDir).toBe('/Volumes/drive/models');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('treats blank or malformed values as unset', () => {
    const root = tempRoot();
    try {
      writeFileSync(configPath(root), JSON.stringify({ token: 'abc', port: 38888, modelsDir: '  ' }));
      expect(configModelsDir(root)).toBeNull();

      writeFileSync(configPath(root), JSON.stringify({ token: 'abc', port: 38888, modelsDir: 42 }));
      expect(configModelsDir(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the persisted value reaches the runner and beats the environment', () => {
    // The precedence that matters in production: config first, env as fallback.
    const root = tempRoot();
    try {
      writeFileSync(
        configPath(root),
        JSON.stringify({ token: 'abc', port: 38888, modelsDir: '/from/config' }),
      );
      const cfg = loadOrCreateConfig(root, 38888);
      const resolved = resolveModelsDir(cfg.modelsDir ?? undefined, {
        COMPANION_DRAWTHINGS_MODELS_DIR: '/from/env',
      });
      expect(resolved).toBe('/from/config');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
