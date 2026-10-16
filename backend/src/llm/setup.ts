/**
 * @fileoverview Setup state for the LLM Gateway.
 *
 * Nothing is fetched at boot. Download runs only when the Setup page asks.
 * Enable is refused until the binary is on disk, Codex auth exists, and a
 * checked Use proxy has a URL in Settings. Disable keeps the binary.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, llmDir } from '../paths';
import {
  configLlmEnabled,
  configLlmUseProxy,
  configProxyUrl,
  setConfigLlmEnabled,
  setConfigLlmUseProxy,
} from '../token';
import { HttpError } from '../types';
import { downloadVerified } from '../tts/download';
import { gatewayAsset, gatewayBinaryName } from './assets';
import {
  GATEWAY_HOST,
  authJsonPath,
  binaryPath,
  binaryReady,
  gatewayPort,
  incomingDir,
  isProxyUrl,
} from './layout';
import { gatewayArgs, gatewayEnv, spawnChild, type SpawnFn } from './process';

export type LlmStep = 'download' | 'login' | 'proxy' | 'port' | 'expired' | 'unsupported';

export interface LlmSetupFeature {
  id: 'llm';
  downloaded: boolean;
  enabled: boolean;
  downloading: boolean;
  received: number;
  total: number;
  error: string | null;
  useProxy: boolean;
  baseUrl: string | null;
  steps: LlmStep[];
}

export interface LlmSetupOptions {
  root: string;
  /** Companion's own listen port. The public base URL uses it, not 18080. */
  publicPort: number;
  gatewayPort?: number;
  authPath?: string;
  fetchImpl?: typeof fetch;
  spawnImpl?: SpawnFn;
  extract?: (archive: string, dest: string) => Promise<void>;
  platform?: string;
  arch?: string;
}

export class LlmSetup {
  private readonly root: string;
  private readonly publicPort: number;
  private readonly listenPort: number;
  private readonly authPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: SpawnFn;
  private readonly extract: (archive: string, dest: string) => Promise<void>;
  private readonly platform: string;
  private readonly arch: string;
  private job: Promise<void> | null = null;
  private received = 0;
  private total = 0;
  private error: string | null = null;
  private child: { kill: () => void } | null = null;
  private stopping = false;
  private running = false;
  private portBlocked = false;
  private unexpectedExit = false;

  constructor(options: LlmSetupOptions) {
    this.root = options.root;
    this.publicPort = options.publicPort;
    this.listenPort = options.gatewayPort ?? gatewayPort();
    this.authPath = options.authPath ?? authJsonPath();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.spawnImpl = options.spawnImpl ?? spawnChild;
    this.extract = options.extract ?? extractArchive;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
  }

  async view(): Promise<LlmSetupFeature> {
    const downloaded = this.downloaded();
    const enabled = this.running;
    return {
      id: 'llm',
      downloaded,
      enabled,
      downloading: this.job != null,
      received: this.job == null ? 0 : this.received,
      total: this.job == null ? 0 : this.total,
      error: this.error,
      useProxy: configLlmUseProxy(this.root),
      baseUrl: enabled ? `http://127.0.0.1:${this.publicPort}/codex/v1` : null,
      steps: this.steps(downloaded),
    };
  }

  downloaded(): boolean {
    return gatewayAsset(this.platform, this.arch) != null && binaryReady(this.root, this.platform);
  }

  /** Start the download, or report the one already running. A finished install is left alone. */
  startDownload(): Promise<LlmSetupFeature> {
    if (gatewayAsset(this.platform, this.arch) == null) {
      throw new HttpError(400, 'INVALID_PARAM', 'This computer has no gateway build');
    }
    if (this.job == null && !this.downloaded()) {
      this.error = null;
      this.job = this.runDownload().finally(() => {
        this.job = null;
      });
    }
    return this.view();
  }

  async setEnabled(enabled: boolean): Promise<LlmSetupFeature> {
    this.error = null;
    if (!enabled) {
      this.stop();
      setConfigLlmEnabled(this.root, false);
      return this.view();
    }
    if (gatewayAsset(this.platform, this.arch) == null) {
      throw new HttpError(400, 'INVALID_PARAM', 'This computer has no gateway build');
    }
    if (!this.downloaded()) {
      throw new HttpError(400, 'INVALID_PARAM', 'Download the gateway before turning it on');
    }
    if (!existsSync(this.authPath)) {
      throw new HttpError(400, 'INVALID_PARAM', 'Run codex login, then turn the gateway on again');
    }
    if (configLlmUseProxy(this.root) && configProxyUrl(this.root) === '') {
      throw new HttpError(400, 'INVALID_PARAM', 'Open Settings and save a proxy URL');
    }
    try {
      await this.start();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      throw error instanceof HttpError ? error : new HttpError(500, 'LLM_FAILED', this.error);
    }
    setConfigLlmEnabled(this.root, true);
    return this.view();
  }

  async setUseProxy(useProxy: boolean): Promise<LlmSetupFeature> {
    this.error = null;
    setConfigLlmUseProxy(this.root, useProxy);
    if (this.running) await this.restartOrStop();
    return this.view();
  }

  /** Settings saved a new proxy URL. Restart only when this feature is using it. */
  async applyProxyUrl(): Promise<void> {
    if (!configLlmEnabled(this.root) && !this.running) return;
    if (!configLlmUseProxy(this.root)) return;
    if (configProxyUrl(this.root) === '') {
      this.stop();
      return;
    }
    if (this.running || configLlmEnabled(this.root)) await this.restartOrStop();
  }

  /** Boot: start only when the switch is on and every requirement is already met. */
  async restore(): Promise<void> {
    if (!configLlmEnabled(this.root)) return;
    if (!this.downloaded() || !existsSync(this.authPath)) return;
    if (configLlmUseProxy(this.root) && configProxyUrl(this.root) === '') return;
    try {
      await this.start();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  /** POST a JSON body to a path on the local gateway. Defaults to chat completions. */
  forward(body: Record<string, unknown>, upstreamPath = '/v1/chat/completions'): Promise<Response> {
    return this.forwardRequest('POST', upstreamPath, JSON.stringify(body));
  }

  /**
   * Forward one HTTP call to the local gateway. `upstreamPath` is a path plus
   * optional query, and must stay under the chat or responses routes.
   */
  async forwardRequest(method: string, upstreamPath: string, body: string | null): Promise<Response> {
    if (!upstreamPath.startsWith('/v1/chat/completions') && !upstreamPath.startsWith('/v1/responses')) {
      throw new HttpError(404, 'NOT_FOUND', 'Unknown gateway path');
    }
    if (!this.running) {
      if (!configLlmEnabled(this.root) && !this.unexpectedExit) {
        throw new HttpError(503, 'LLM_DISABLED', 'LLM Gateway is turned off');
      }
      throw new HttpError(503, 'LLM_NOT_READY', 'LLM Gateway is not running');
    }
    let upstream: Response;
    try {
      upstream = await this.fetchImpl(`http://${GATEWAY_HOST}:${this.listenPort}${upstreamPath}`, {
        method,
        headers: body == null ? {} : { 'content-type': 'application/json' },
        body: body ?? undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(502, 'LLM_FAILED', message);
    }
    const type = upstream.headers.get('content-type') ?? 'application/json';
    return new Response(upstream.body, { status: upstream.status, headers: { 'content-type': type } });
  }

  private steps(downloaded: boolean): LlmStep[] {
    if (gatewayAsset(this.platform, this.arch) == null) return ['unsupported'];
    const steps: LlmStep[] = [];
    if (!downloaded) steps.push('download');
    if (downloaded && !existsSync(this.authPath)) steps.push('login');
    if (configLlmUseProxy(this.root) && configProxyUrl(this.root) === '') steps.push('proxy');
    if (this.portBlocked) steps.push('port');
    if (this.unexpectedExit) steps.push('expired');
    return steps;
  }

  private async start(): Promise<void> {
    if (this.running) return;
    if (await this.reachable()) {
      this.portBlocked = true;
      throw new HttpError(400, 'LLM_PORT_IN_USE', `Port ${this.listenPort} is already in use`);
    }
    this.portBlocked = false;
    this.unexpectedExit = false;
    this.stopping = false;
    const bin = binaryPath(this.root, this.platform);
    const child = this.spawnImpl(
      bin,
      gatewayArgs(this.listenPort, this.authPath),
      gatewayEnv(configLlmUseProxy(this.root), configProxyUrl(this.root)),
    );
    this.child = child;
    child.onExit(() => {
      if (this.child !== child) return;
      this.child = null;
      const wasRunning = this.running;
      this.running = false;
      if (!this.stopping && wasRunning) this.unexpectedExit = true;
    });
    try {
      await this.waitUntilReachable();
    } catch (error) {
      this.stop();
      throw error;
    }
    this.running = true;
  }

  private stop(): void {
    this.stopping = true;
    const current = this.child;
    this.child = null;
    this.running = false;
    this.unexpectedExit = false;
    current?.kill();
  }

  private async restartOrStop(): Promise<void> {
    const proxyBlocked = configLlmUseProxy(this.root) && configProxyUrl(this.root) === '';
    this.stop();
    if (proxyBlocked || !configLlmEnabled(this.root)) return;
    if (!existsSync(this.authPath) || !this.downloaded()) return;
    try {
      await this.start();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private async reachable(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`http://${GATEWAY_HOST}:${this.listenPort}/healthz`, {
        signal: AbortSignal.timeout(400),
      });
      return res.status > 0;
    } catch {
      return false;
    }
  }

  private async waitUntilReachable(): Promise<void> {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (this.child == null) {
        this.unexpectedExit = true;
        throw new HttpError(500, 'LLM_FAILED', 'The gateway stopped. Run codex login again, then turn it on');
      }
      if (await this.reachable()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new HttpError(500, 'LLM_FAILED', 'The gateway did not become ready');
  }

  private async runDownload(): Promise<void> {
    const asset = gatewayAsset(this.platform, this.arch);
    if (asset == null) return;
    try {
      ensureDir(llmDir(this.root));
      ensureDir(incomingDir(this.root));
      const archive = join(incomingDir(this.root), asset.filename);
      this.total = asset.bytes;
      this.received = 0;
      await downloadVerified(
        asset.url,
        `${archive}.partial`,
        archive,
        asset.sha256,
        (got) => {
          this.received = got;
        },
        this.fetchImpl,
      );
      const extractTo = join(incomingDir(this.root), 'extract');
      await rm(extractTo, { recursive: true, force: true });
      ensureDir(extractTo);
      try {
        await this.extract(archive, extractTo);
        const found = await findBinary(extractTo, gatewayBinaryName(this.platform));
        if (found == null) throw new Error('gateway binary was not in the archive');
        const dest = binaryPath(this.root, this.platform);
        await copyFile(found, dest);
        if (this.platform !== 'win32') await chmod(dest, 0o755);
      } finally {
        await rm(archive, { force: true });
        await rm(extractTo, { recursive: true, force: true });
      }
      this.received = this.total;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }
}

export function isProxyUrlOrEmpty(value: string): boolean {
  return isProxyUrl(value);
}

function extractArchive(archive: string, dest: string): Promise<void> {
  const flags = archive.endsWith('.zip') ? ['-xf'] : ['-xzf'];
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

async function findBinary(dir: string, name: string): Promise<string | null> {
  const entries = await readdir(dir, { recursive: true });
  for (const entry of entries) {
    const rel = String(entry);
    if (rel === name || rel.endsWith(`/${name}`) || rel.endsWith(`\\${name}`)) return join(dir, rel);
  }
  return null;
}
