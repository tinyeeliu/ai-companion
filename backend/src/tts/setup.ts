/**
 * @fileoverview Setup state for local speech.
 *
 * Nothing is fetched at boot. Download runs only when the Setup page asks.
 * Apple Silicon fetches uv, a Python environment, and the selected Kokoro
 * checkpoint. Windows fetches the sherpa archive and the Kokoro onnx model.
 * Enable is refused until that machine's files are on disk. Disable keeps the
 * files, unloads the weights, and clears the switch in config.json.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, ttsDir } from '../paths';
import { configTtsEnabled, configTtsModel, setConfigTtsEnabled, setConfigTtsModel } from '../token';
import { HttpError } from '../types';
import { MISAKI_SPEC, MLX_AUDIO_SPEC, MODEL_ASSET, SPACY_MODEL_SPEC, UV_ASSET, engineAsset, type ArchiveAsset } from './assets';
import { downloadVerified } from './download';
import {
  engineDir,
  findEngineBinary,
  incomingDir,
  mlxModelReady,
  modelDir,
  modelReady,
  pythonBin,
  pythonDir,
  pythonReady,
  usesMlxEngine,
  uvBin,
  workerEnv,
} from './layout';
import { downloadMlxModel, type MlxSession } from './mlx';
import { parseTtsModel, type TtsModelId } from './models';

export interface SetupFeature {
  id: 'tts';
  downloaded: boolean;
  enabled: boolean;
  /** True while a download is in flight. Received and total are 0 otherwise. */
  downloading: boolean;
  received: number;
  total: number;
  error: string | null;
  /** Apple Silicon selector. Null where this computer has a single engine. */
  model: TtsModelId | null;
  models: { id: TtsModelId; downloaded: boolean }[];
}

export interface TtsSetupOptions {
  root: string;
  fetchImpl?: typeof fetch;
  /** Test double for `tar`. Default extracts an archive into `dest`. */
  extract?: (archive: string, dest: string, flags: string[]) => Promise<void>;
  session?: MlxSession | null;
}

export class TtsSetup {
  private readonly root: string;
  private readonly fetchImpl: typeof fetch;
  private readonly extract: (archive: string, dest: string, flags: string[]) => Promise<void>;
  private readonly session: MlxSession | null;
  private job: Promise<void> | null = null;
  private received = 0;
  private total = 0;
  private error: string | null = null;
  private target: TtsModelId | null = null;

  constructor(options: TtsSetupOptions) {
    this.root = options.root;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.extract = options.extract ?? extractArchive;
    this.session = options.session ?? null;
  }

  model(): TtsModelId {
    return configTtsModel(this.root);
  }

  dataRoot(): string {
    return this.root;
  }

  async downloaded(): Promise<boolean> {
    if (usesMlxEngine()) return pythonReady(this.root) && mlxModelReady(this.root, this.model());
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
      model: usesMlxEngine() ? this.model() : null,
      models: usesMlxEngine()
        ? (['en', 'zh'] as const).map((id) => ({ id, downloaded: mlxModelReady(this.root, id) }))
        : [],
    };
  }

  /**
   * Start the download, or report the one already running. A finished install
   * is left alone: calling this again does not re-fetch hundreds of megabytes.
   */
  startDownload(): Promise<SetupFeature> {
    if (usesMlxEngine()) {
      if (this.job == null) {
        this.error = null;
        this.target = this.model();
        this.job = this.runMlx().finally(() => {
          this.job = null;
        });
      }
      return this.view();
    }
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
    if (!enabled) {
      await this.session?.unload().catch(() => undefined);
      setConfigTtsEnabled(this.root, false);
      return this.view();
    }
    try {
      if (usesMlxEngine()) await this.session?.load(this.model());
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      throw error instanceof HttpError ? error : new HttpError(500, 'TTS_FAILED', this.error);
    }
    setConfigTtsEnabled(this.root, true);
    return this.view();
  }

  async setModel(model: string): Promise<SetupFeature> {
    if (!usesMlxEngine()) {
      throw new HttpError(400, 'INVALID_PARAM', 'This computer has one speech model');
    }
    const id = parseTtsModel(model);
    if (id == null) throw new HttpError(400, 'INVALID_PARAM', 'model must be en or zh');
    setConfigTtsModel(this.root, id);
    this.error = null;
    if (!pythonReady(this.root) || !mlxModelReady(this.root, id)) {
      if (this.job == null) return this.startDownload();
      return this.view();
    }
    if (this.enabled()) {
      try {
        await this.session?.load(id);
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        throw error instanceof HttpError ? error : new HttpError(500, 'TTS_FAILED', this.error);
      }
    }
    return this.view();
  }

  private async runMlx(): Promise<void> {
    const target = this.target ?? this.model();
    try {
      await this.ensurePython();
      if (!mlxModelReady(this.root, target)) {
        await downloadMlxModel(this.root, target, (got, total) => {
          this.received = got;
          if (total > 0) this.total = total;
        });
      }
      this.received = this.total;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      return;
    }
    if (this.model() !== target && !mlxModelReady(this.root, this.model())) {
      this.target = this.model();
      await this.runMlx();
      return;
    }
    if (this.enabled() && mlxModelReady(this.root, this.model())) {
      try {
        await this.session?.load(this.model());
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
      'pip', 'install', '--python', pythonBin(this.root), MLX_AUDIO_SPEC, MISAKI_SPEC, SPACY_MODEL_SPEC,
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
      await this.extract(finalPath, dest, ['-xjf']);
    } catch (error) {
      await rm(cleanup, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(finalPath, { force: true });
    }
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
