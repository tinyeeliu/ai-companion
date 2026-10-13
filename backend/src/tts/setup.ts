/**
 * @fileoverview Setup state for local speech.
 *
 * Nothing is fetched at boot. Download runs only when the Setup page asks, one
 * archive at a time, and Enable is refused until both the model and the engine
 * are on disk. Disable keeps the files and only clears the switch in config.json.
 */
import { spawn } from 'node:child_process';
import { chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir } from '../paths';
import { configTtsEnabled, setConfigTtsEnabled } from '../token';
import { HttpError } from '../types';
import { MODEL_ASSET, engineAsset, type ArchiveAsset } from './assets';
import { downloadVerified } from './download';
import {
  engineDir,
  findEngineBinary,
  incomingDir,
  modelDir,
  modelReady,
} from './layout';
import { ttsDir } from '../paths';

export interface SetupFeature {
  id: 'tts';
  downloaded: boolean;
  enabled: boolean;
  /** True while a download is in flight. Received and total are 0 otherwise. */
  downloading: boolean;
  received: number;
  total: number;
  error: string | null;
}

export interface TtsSetupOptions {
  root: string;
  fetchImpl?: typeof fetch;
  /** Test double for `tar`. Default extracts a .tar.bz2 into `dest`. */
  extract?: (archive: string, dest: string) => Promise<void>;
}

export class TtsSetup {
  private readonly root: string;
  private readonly fetchImpl: typeof fetch;
  private readonly extract: (archive: string, dest: string) => Promise<void>;
  private job: Promise<void> | null = null;
  private received = 0;
  private total = 0;
  private error: string | null = null;

  constructor(options: TtsSetupOptions) {
    this.root = options.root;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.extract = options.extract ?? extractArchive;
  }

  async downloaded(): Promise<boolean> {
    return modelReady(this.root) && (await findEngineBinary(this.root)) != null;
  }

  enabled(): boolean {
    return configTtsEnabled(this.root);
  }

  async view(): Promise<SetupFeature> {
    const downloaded = await this.downloaded();
    return {
      id: 'tts',
      downloaded,
      enabled: downloaded && this.enabled(),
      downloading: this.job != null,
      received: this.job == null ? 0 : this.received,
      total: this.job == null ? 0 : this.total,
      error: this.error,
    };
  }

  /**
   * Start the download, or report the one already running. A finished install
   * is left alone: calling this again does not re-fetch hundreds of megabytes.
   */
  startDownload(): Promise<SetupFeature> {
    const asset = engineAsset();
    if (asset == null) {
      throw new HttpError(400, 'INVALID_PARAM', `No speech engine build for ${process.platform}-${process.arch}`);
    }
    if (this.job == null) {
      this.error = null;
      this.job = this.run(asset).finally(() => {
        this.job = null;
      });
    }
    return this.view();
  }

  async setEnabled(enabled: boolean): Promise<SetupFeature> {
    if (enabled && !(await this.downloaded())) {
      throw new HttpError(400, 'INVALID_PARAM', 'Download speech before turning it on');
    }
    setConfigTtsEnabled(this.root, enabled);
    return this.view();
  }

  private async run(engine: ArchiveAsset): Promise<void> {
    const modelBytes = (await modelReady(this.root)) ? MODEL_ASSET.bytes : 0;
    const engineBytes = (await findEngineBinary(this.root)) != null ? engine.bytes : 0;
    this.total = MODEL_ASSET.bytes + engine.bytes;
    this.received = modelBytes + engineBytes;
    try {
      ensureDir(incomingDir(this.root));
      if (!(await modelReady(this.root))) {
        // The archive already contains the `kokoro-multi-lang-v1_0` folder, so
        // it is extracted into `data/tts`, not into that folder.
        await rm(modelDir(this.root), { recursive: true, force: true });
        await this.fetchExtract(MODEL_ASSET, ttsDir(this.root), modelDir(this.root), (got) => {
          this.received = got + engineBytes;
        });
        this.received = MODEL_ASSET.bytes + engineBytes;
      }
      if ((await findEngineBinary(this.root)) == null) {
        await rm(engineDir(this.root), { recursive: true, force: true });
        await this.fetchExtract(engine, engineDir(this.root), engineDir(this.root), (got) => {
          this.received = MODEL_ASSET.bytes + got;
        });
        const bin = await findEngineBinary(this.root);
        if (bin != null && process.platform !== 'win32') await chmod(bin, 0o755);
      }
      this.received = this.total;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private async fetchExtract(
    asset: ArchiveAsset,
    dest: string,
    cleanup: string,
    onProgress: (received: number) => void,
  ): Promise<void> {
    const finalPath = join(incomingDir(this.root), asset.filename);
    const partialPath = `${finalPath}.partial`;
    await downloadVerified(asset.url, partialPath, finalPath, asset.sha256, onProgress, this.fetchImpl);
    ensureDir(dest);
    try {
      await this.extract(finalPath, dest);
    } catch (error) {
      await rm(cleanup, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(finalPath, { force: true });
    }
  }
}

function extractArchive(archive: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xjf', archive, '-C', dest], { stdio: ['ignore', 'ignore', 'pipe'] });
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
