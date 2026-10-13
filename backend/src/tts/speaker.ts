/**
 * Plays a wav on this machine's speaker and keeps nothing.
 * Calls are serialized so two requests cannot talk over each other.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TtsFailedError, TTS_TIMEOUT_MS } from './engine';

let chain: Promise<void> = Promise.resolve();

export function playOnSpeaker(wav: Uint8Array): Promise<void> {
  const run = chain.then(() => playFile(wav));
  chain = run.then(() => undefined, () => undefined);
  return run;
}

async function playFile(wav: Uint8Array): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'companion-speaker-'));
  const path = join(dir, 'speech.wav');
  try {
    await writeFile(path, wav);
    if (process.platform === 'darwin') {
      await run('afplay', [path]);
      return;
    }
    if (process.platform === 'win32') {
      const script = [
        'Add-Type -AssemblyName System.Media',
        '$p = New-Object System.Media.SoundPlayer $env:SPEAKER_WAV',
        '$p.PlaySync()',
        '$p.Dispose()',
      ].join('; ');
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { SPEAKER_WAV: path });
      return;
    }
    throw new TtsFailedError('this computer has no speaker playback');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(bin: string, args: string[], env: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new TtsFailedError(`speaker playback timed out after ${TTS_TIMEOUT_MS}ms`));
    }, TTS_TIMEOUT_MS);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new TtsFailedError(error.message));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new TtsFailedError(stderr.trim().split('\n').at(-1) || `${bin} exited ${code}`));
    });
  });
}
