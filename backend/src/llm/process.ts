/**
 * Supervises one openai-api-server-via-codex child. The port is loopback-only
 * and is not the address clients use.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { GATEWAY_HOST, childEnv } from './layout';

export interface Spawned {
  kill: () => void;
  onExit: (cb: (code: number | null) => void) => void;
}

export type SpawnFn = (bin: string, args: string[], env: NodeJS.ProcessEnv) => Spawned;

const live = new Set<Spawned>();
let hooked = false;

function hookExit(): void {
  if (hooked) return;
  hooked = true;
  process.on('exit', () => {
    for (const child of live) child.kill();
  });
}

export function spawnChild(bin: string, args: string[], env: NodeJS.ProcessEnv): Spawned {
  const child: ChildProcess = spawn(bin, args, {
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  let exitCb: (code: number | null) => void = () => undefined;
  const spawned: Spawned = {
    kill() {
      child.kill();
    },
    onExit(cb) {
      exitCb = cb;
    },
  };
  child.on('exit', (code) => {
    live.delete(spawned);
    exitCb(code);
  });
  child.on('error', () => {
    live.delete(spawned);
    exitCb(null);
  });
  live.add(spawned);
  hookExit();
  return spawned;
}

export function gatewayArgs(port: number, authPath: string): string[] {
  return [
    '--host', GATEWAY_HOST,
    '--port', String(port),
    '--auth-json', authPath,
    '--drop-params', 'temperature',
  ];
}

export function gatewayEnv(useProxy: boolean, proxyUrl: string): NodeJS.ProcessEnv {
  return childEnv(useProxy, proxyUrl);
}
