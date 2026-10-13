/**
 * The operating system's own speech engine.
 * Mac is `say`. Windows is System.Speech. A voice id on the API is `os/` plus
 * the platform's voice name.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError } from '../types';
import { TtsFailedError, TtsTimeoutError, TTS_TIMEOUT_MS } from './engine';
import type { SpeechJob } from './parse';
import type { SpeechResult } from './queue';
import type { VoiceGender } from './catalog';
import { wavToPcm } from './wav';

export interface OsVoice {
  name: string;
  language: string;
  gender: VoiceGender;
}

let cached: OsVoice[] | null = null;

export async function listOsVoices(): Promise<OsVoice[]> {
  if (cached != null) return cached;
  try {
    cached = process.platform === 'win32' ? parseSapiListing(await runSapiList()) : parseSayListing(await runSayList());
  } catch {
    cached = [];
  }
  return cached;
}

/** `say -v '?'` lines. A name that contains `/` cannot be an `os/` id. */
export function parseSayListing(text: string): OsVoice[] {
  const voices: OsVoice[] = [];
  for (const line of text.split('\n')) {
    const match = /^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]+)\s+#/.exec(line.trim());
    if (match == null) continue;
    const name = match[1]?.trim() ?? '';
    const locale = match[2] ?? '';
    if (name === '' || name.includes('/')) continue;
    voices.push({ name, language: locale.replaceAll('_', '-'), gender: 'NEUTRAL' });
  }
  return voices;
}

/** Tab-separated `name, culture, gender` lines from System.Speech. */
export function parseSapiListing(text: string): OsVoice[] {
  const voices: OsVoice[] = [];
  for (const line of text.split('\n')) {
    const [rawName, rawLang, rawGender] = line.trim().split('\t');
    const name = rawName?.trim() ?? '';
    if (name === '' || name.includes('/')) continue;
    voices.push({
      name,
      language: (rawLang ?? 'en-US').trim() || 'en-US',
      gender: sapiGender(rawGender ?? ''),
    });
  }
  return voices;
}

export async function speakOs(job: SpeechJob): Promise<SpeechResult> {
  const name = job.voice.osName;
  if (name == null || name === '') {
    throw new HttpError(400, 'INVALID_PARAM', 'voice must name an OS voice');
  }
  const known = await listOsVoices();
  if (!known.some((voice) => voice.name === name)) {
    throw new HttpError(400, 'INVALID_PARAM', `OS voice not found: ${name}`);
  }
  const dir = await mkdtemp(join(tmpdir(), 'companion-os-'));
  const outputPath = join(dir, 'speech.wav');
  try {
    if (process.platform === 'win32') await speakSapi(name, job.input, job.speed, outputPath);
    else await speakSay(name, job.input, job.speed, outputPath);
    let wav: Uint8Array;
    try {
      wav = new Uint8Array(await readFile(outputPath));
    } catch {
      throw new TtsFailedError('the system voice wrote no audio');
    }
    if (job.format === 'pcm') return { audio: wavToPcm(wav), contentType: 'audio/pcm' };
    return { audio: wav, contentType: 'audio/wav' };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sapiGender(value: string): VoiceGender {
  const gender = value.trim().toLowerCase();
  if (gender === 'female') return 'FEMALE';
  if (gender === 'male') return 'MALE';
  return 'NEUTRAL';
}

function sayRate(speed: number): string {
  return String(Math.min(500, Math.max(80, Math.round(175 * speed))));
}

function sapiRate(speed: number): string {
  return String(Math.min(10, Math.max(-10, Math.round((speed - 1) * 4))));
}

function runSayList(): Promise<string> {
  return capture('say', ['-v', '?']);
}

function speakSay(name: string, text: string, speed: number, outputPath: string): Promise<void> {
  return run(
    'say',
    ['-v', name, '-o', outputPath, '--file-format=WAVE', '--data-format=LEI16@24000', '-r', sayRate(speed)],
    text,
  );
}

function runSapiList(): Promise<string> {
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    'foreach ($v in $s.GetInstalledVoices()) {',
    '  $i = $v.VoiceInfo',
    '  Write-Output ($i.Name + "`t" + $i.Culture.Name + "`t" + $i.Gender)',
    '}',
  ].join(' ');
  return capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

async function speakSapi(name: string, text: string, speed: number, outputPath: string): Promise<void> {
  const textPath = join(outputPath, '..', 'speech.txt');
  await writeFile(textPath, text, 'utf8');
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$s.SelectVoice($env:OS_VOICE)',
    '$s.Rate = [int]$env:OS_RATE',
    '$s.SetOutputToWaveFile($env:OS_WAV)',
    '$s.Speak([System.IO.File]::ReadAllText($env:OS_TEXT))',
    '$s.Dispose()',
  ].join('; ');
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], '', {
    OS_VOICE: name,
    OS_RATE: sapiRate(speed),
    OS_WAV: outputPath,
    OS_TEXT: textPath,
  });
}

function capture(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${bin} exited ${code}`));
    });
  });
}

function run(
  bin: string,
  args: string[],
  stdin: string,
  env: Record<string, string> = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new TtsTimeoutError(TTS_TIMEOUT_MS));
    }, TTS_TIMEOUT_MS);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new TtsFailedError(stderr.trim().split('\n').at(-1) || `${bin} exited ${code}`));
    });
    child.stdin.end(stdin);
  });
}
