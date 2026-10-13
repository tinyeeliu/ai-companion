/**
 * @fileoverview Setup state for local decision.
 *
 * Nothing is fetched at boot. Download runs only when the Setup page asks,
 * and only on Apple Silicon: uv, a Python 3.12 environment under
 * `data/decision/python/`, pinned mlx-decision, and the laya-multilingual
 * weights. Enable is refused until those files are on disk. Disable keeps
 * the files, unloads the weights, and clears the switch in config.json.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir } from '../paths';
import { configDecisionEnabled, setConfigDecisionEnabled } from '../token';
import { HttpError } from '../types';
import { UV_ASSET } from '../tts/assets';
import { downloadVerified } from '../tts/download';
import { MLX_DECISION_SPEC, MODEL_ID } from './models';
import {
  incomingDir,
  modelReady,
  pythonBin,
  pythonDir,
  pythonReady,
  supportsDecision,
  uvBin,
  workerEnv,
} from './layout';
import { downloadDecisionModel, type DecisionEngine } from './session';

export interface SetupFeature {
  id: 'decision';
  downloaded: boolean;
  enabled: boolean;
  downloading: boolean;
  received: number;
  total: number;
  error: string | null;
  /** Null where this computer has no accelerated model. */
  model: typeof MODEL_ID | null;
  models: { id: typeof MODEL_ID; downloaded: boolean }[];
}

export interface DecisionSetupOptions {
  root: string;
  fetchImpl?: typeof fetch;
  extract?: (archive: string, dest: string, flags: string[]) => Promise<void>;
  session?: DecisionEngine | null;
  /** Test double. Default is this machine. */
  accelerated?: boolean;
}

export class DecisionSetup {
  private readonly root: string;
  private readonly fetchImpl: typeof fetch;
  private readonly extract: (archive: string, dest: string, flags: string[]) => Promise<void>;
  private readonly session: DecisionEngine | null;
  private readonly accelerated: boolean;
  private job: Promise<void> | null = null;
  private received = 0;
  private total = 0;
  private error: string | null = null;

  constructor(options: DecisionSetupOptions) {
    this.root = options.root;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.extract = options.extract ?? extractArchive;
    this.session = options.session ?? null;
    this.accelerated = options.accelerated ?? supportsDecision();
  }

  dataRoot(): string {
    return this.root;
  }

  async downloaded(): Promise<boolean> {
    if (!this.accelerated) return false;
    return pythonReady(this.root) && modelReady(this.root);
  }

  enabled(): boolean {
    return configDecisionEnabled(this.root);
  }

  async view(): Promise<SetupFeature> {
    const downloaded = await this.downloaded();
    return {
      id: 'decision',
      downloaded,
      enabled: downloaded && this.enabled(),
      downloading: this.job != null,
      received: this.job == null ? 0 : this.received,
      total: this.job == null ? 0 : this.total,
      error: this.error,
      model: this.accelerated ? MODEL_ID : null,
      models: this.accelerated ? [{ id: MODEL_ID, downloaded }] : [],
    };
  }

  /**
   * Start the download, or report the one already running. A finished install
   * is left alone. Other machines are refused: there is no CPU fallback.
   */
  startDownload(): Promise<SetupFeature> {
    if (!this.accelerated) {
      throw new HttpError(400, 'INVALID_PARAM', 'This computer has no accelerated decision model');
    }
    if (this.job == null) {
      this.error = null;
      this.job = this.run().finally(() => {
        this.job = null;
      });
    }
    return this.view();
  }

  async setEnabled(enabled: boolean): Promise<SetupFeature> {
    this.error = null;
    if (enabled && !(await this.downloaded())) {
      throw new HttpError(400, 'INVALID_PARAM', 'Download the decision model before turning it on');
    }
    if (!enabled) {
      await this.session?.unload().catch(() => undefined);
      setConfigDecisionEnabled(this.root, false);
      return this.view();
    }
    try {
      if (this.session == null) {
        throw new HttpError(500, 'DECISION_FAILED', 'decision process is not available');
      }
      await this.session.load();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      throw error instanceof HttpError ? error : new HttpError(500, 'DECISION_FAILED', this.error);
    }
    setConfigDecisionEnabled(this.root, true);
    return this.view();
  }

  private async run(): Promise<void> {
    try {
      await this.ensurePython();
      if (!modelReady(this.root)) {
        await downloadDecisionModel(this.root, (got, total) => {
          this.received = got;
          if (total > 0) this.total = total;
        });
      }
      this.received = this.total;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    if (this.enabled() && modelReady(this.root)) {
      try {
        await this.session?.load();
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    }
  }

  private async ensurePython(): Promise<void> {
    if (pythonReady(this.root)) return;
    await this.ensureUv();
    const venv = join(pythonDir(this.root), 'venv');
    if (!existsSync(pythonBin(this.root))) {
      await this.runCmd(uvBin(this.root), ['venv', '--python', '3.12', venv]);
    }
    await this.runCmd(uvBin(this.root), [
      'pip', 'install', '--python', pythonBin(this.root), MLX_DECISION_SPEC,
    ]);
    await writeFile(join(pythonDir(this.root), 'python.ready'), 'ok\n');
  }

  private async ensureUv(): Promise<void> {
    const dest = uvBin(this.root);
    if (existsSync(dest)) return;
    ensureDir(pythonDir(this.root));
    ensureDir(incomingDir(this.root));
    const archive = join(incomingDir(this.root), UV_ASSET.filename);
    this.total = UV_ASSET.bytes;
    await downloadVerified(
      UV_ASSET.url,
      `${archive}.partial`,
      archive,
      UV_ASSET.sha256,
      (got) => {
        this.received = got;
      },
      this.fetchImpl,
    );
    const extractTo = join(pythonDir(this.root), 'uv-extract');
    await rm(extractTo, { recursive: true, force: true });
    ensureDir(extractTo);
    try {
      await this.extract(archive, extractTo, ['-xzf']);
      await copyFile(join(extractTo, 'uv-aarch64-apple-darwin', 'uv'), dest);
      await chmod(dest, 0o755);
    } finally {
      await rm(archive, { force: true });
      await rm(extractTo, { recursive: true, force: true });
    }
  }

  private runCmd(bin: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { env: workerEnv(this.root), stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim().split('\n').at(-1) || `${bin} exited ${code}`));
      });
    });
  }
}

function extractArchive(archive: string, dest: string, flags: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', [...flags, archive, '-C', dest], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `tar exited ${code}`));
    });
  });
}
