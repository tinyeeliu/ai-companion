/**
 * Speech request parsing, the wav-to-pcm step, the checksum gate, and the
 * HTTP surface. The sherpa-onnx process is not spawned here.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { createApp } from '../src/app';
import { ConnectionManager } from '../src/manager';
import { ConnectionStore } from '../src/store';
import { setConfigTtsEnabled, setConfigToken } from '../src/token';
import { downloadVerified } from '../src/tts/download';
import { buildTtsArgs } from '../src/tts/engine';
import { kokoroVoice } from '../src/tts/catalog';
import { engineDir, mlxHubDir, modelDir, modelMarker, pythonBin, pythonDir, usesMlxEngine } from '../src/tts/layout';
import { parseSapiListing, parseSayListing } from '../src/tts/os';
import { speechLang } from '../src/tts/models';
import { parseSpeechRequest } from '../src/tts/parse';
import { TtsQueue, type SpeechResult, type SpeechRunner } from '../src/tts/queue';
import { TtsSetup } from '../src/tts/setup';
import { wavToPcm } from '../src/tts/wav';
import { DEFAULT_VOICE_ID } from '../src/tts/voices';
import { fakeFactory } from './fake-whatsapp';

const dirs: string[] = [];
const TOKEN = 'test-token';

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir != null) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'companion-tts-'));
  dirs.push(dir);
  return dir;
}

function pcmWav(samples: number[]): Uint8Array {
  const data = new Uint8Array(samples.length * 2);
  const view = new DataView(data.buffer);
  samples.forEach((sample, i) => view.setInt16(i * 2, sample, true));
  return wrapWav(data, 1, 16);
}

function wrapWav(data: Uint8Array, format: number, bits: number): Uint8Array {
  const out = new Uint8Array(44 + data.byteLength);
  const view = new DataView(out.buffer);
  writeText(out, 0, 'RIFF');
  view.setUint32(4, 36 + data.byteLength, true);
  writeText(out, 8, 'WAVE');
  writeText(out, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 24000 * bits / 8, true);
  view.setUint16(32, bits / 8, true);
  view.setUint16(34, bits, true);
  writeText(out, 36, 'data');
  view.setUint32(40, data.byteLength, true);
  out.set(data, 44);
  return out;
}

function writeText(bytes: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i);
}

/** Empty stand-ins for the files the readiness check looks for. */
function installFakeKokoro(root: string): void {
  if (usesMlxEngine()) {
    mkdirSync(dirname(modelMarker(root, 'en')), { recursive: true });
    writeFileSync(modelMarker(root, 'en'), 'mlx-community/Kokoro-82M-bf16\n');
    mkdirSync(dirname(pythonBin(root)), { recursive: true });
    writeFileSync(pythonBin(root), '');
    writeFileSync(join(pythonDir(root), 'python.ready'), 'ok\n');
    return;
  }
  const model = modelDir(root);
  mkdirSync(join(model, 'espeak-ng-data'), { recursive: true });
  mkdirSync(join(model, 'dict'), { recursive: true });
  for (const name of ['model.onnx', 'voices.bin', 'tokens.txt', 'lexicon-us-en.txt', 'lexicon-gb-en.txt', 'lexicon-zh.txt']) {
    writeFileSync(join(model, name), '');
  }
  const binDir = join(engineDir(root), 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'sherpa-onnx-offline-tts'), '');
}

function appWith(root: string, runner: SpeechRunner) {
  const manager = new ConnectionManager(new ConnectionStore(root), fakeFactory(new Map()), fetch);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ token: TOKEN, port: 38888, ttsEnabled: false }));
  const setup = new TtsSetup({ root, fetchImpl: fetch });
  const app = createApp({
    manager,
    token: TOKEN,
    port: 38888,
    configRoot: root,
    tts: { queue: new TtsQueue(runner), setup },
  });
  return { app, setup };
}

const WAV = pcmWav([0, 1000, -1000]);

function okRunner(jobs: ReturnType<typeof parseSpeechRequest>[] = []): SpeechRunner {
  return {
    async run(job): Promise<SpeechResult> {
      jobs.push(job);
      return { audio: WAV, contentType: job.format === 'pcm' ? 'audio/pcm' : 'audio/wav' };
    },
  };
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
}

describe('parseSpeechRequest', () => {
  test('default voice is af_heart and the format defaults to wav', () => {
    const job = parseSpeechRequest({ model: 'kokoro-82m', input: 'Hello', voice: 'default' });
    expect(job.voice).toEqual({ id: DEFAULT_VOICE_ID, sid: 3 });
    expect(job.format).toBe('wav');
    expect(job.speed).toBe(1);
  });

  test('accepts a voice object, an OpenAI name, and the supported options', () => {
    const job = parseSpeechRequest({
      model: 'kokoro-82m',
      input: 'Hello',
      voice: { id: 'default' },
      response_format: 'pcm',
      speed: 1.1,
      instructions: 'Speak calmly.',
      stream_format: 'audio',
    });
    expect(job.voice.id).toBe('af_heart');
    expect(job.format).toBe('pcm');
    expect(job.speed).toBe(1.1);
    const named = parseSpeechRequest({ model: 'kokoro-82m', input: 'Hello', voice: 'nova' });
    expect(named.voice).toEqual({ id: 'af_nova', sid: 7 });
  });

  test('rejects an unknown field, a missing encoder format, and sse', () => {
    expect(() => parseSpeechRequest({ model: 'kokoro-82m', input: 'Hi', voice: 'default', seed: 1 })).toThrow(
      /unsupported field/,
    );
    expect(() => parseSpeechRequest({ model: 'kokoro-82m', input: 'Hi', voice: 'default', response_format: 'mp3' })).toThrow(
      /wav or pcm/,
    );
    expect(() => parseSpeechRequest({ model: 'kokoro-82m', input: 'Hi', voice: 'default', stream_format: 'sse' })).toThrow(
      /audio/,
    );
    expect(() => parseSpeechRequest({ model: 'kokoro-82m', input: 'Hi', voice: 'shimmer' })).toThrow(/voice/);
  });
});

describe('buildTtsArgs', () => {
  test('points the CLI at the wav path and the default speaker', () => {
    const paths = {
      model: '/m/model.onnx',
      voices: '/m/voices.bin',
      tokens: '/m/tokens.txt',
      espeak: '/m/espeak-ng-data',
      dict: '/m/dict',
      lexiconUs: '/m/lexicon-us-en.txt',
      lexiconGb: '/m/lexicon-gb-en.txt',
      lexiconZh: '/m/lexicon-zh.txt',
    };
    const job = parseSpeechRequest({ model: 'kokoro-82m', input: 'Hello', voice: 'default', speed: 1.1 });
    const args = buildTtsArgs(paths, job, '/tmp/speech.wav');
    expect(args).toContain('--sid=3');
    expect(args).toContain('--kokoro-length-scale=0.9091');
    expect(args).toContain('--output-filename=/tmp/speech.wav');
    expect(args.at(-1)).toBe('Hello');
    expect(args.some((arg) => arg.includes('lexicon-us-en.txt'))).toBe(true);
  });
});

describe('speech model selection', () => {
  test('English default voice is af_heart and British voices use lang b', () => {
    const job = parseSpeechRequest({ model: 'kokoro-82m', input: 'Hello', voice: 'default' }, 'en');
    expect(job.voice).toEqual({ id: 'af_heart', sid: 3 });
    expect(speechLang('en', job.voice.id)).toBe('a');
    const british = parseSpeechRequest({ model: 'kokoro-82m', input: 'Hello', voice: 'fable' }, 'en');
    expect(british.voice.id).toBe('bm_fable');
    expect(speechLang('en', british.voice.id)).toBe('b');
  });

  test('Chinese default voice is zf_001 and a pack id is accepted', () => {
    const job = parseSpeechRequest({ model: 'kokoro-82m', input: '你好', voice: 'default' }, 'zh');
    expect(job.voice).toEqual({ id: 'zf_001', sid: 0 });
    expect(speechLang('zh', job.voice.id)).toBe('z');
    const named = parseSpeechRequest({ model: 'kokoro-82m', input: '你好', voice: 'zf_026' }, 'zh');
    expect(named.voice.id).toBe('zf_026');
    expect(() => parseSpeechRequest({ model: 'kokoro-82m', input: '你好', voice: 'shimmer' }, 'zh')).toThrow(/voice/);
  });
});

describe('wavToPcm', () => {
  test('strips a 16-bit mono wav down to its samples', () => {
    const pcm = wavToPcm(pcmWav([1, -2, 3]));
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    expect(view.getInt16(0, true)).toBe(1);
    expect(view.getInt16(2, true)).toBe(-2);
    expect(view.getInt16(4, true)).toBe(3);
  });
});

describe('downloadVerified', () => {
  test('deletes a file whose checksum does not match and keeps one that does', async () => {
    const root = tempDir();
    const bytes = new TextEncoder().encode('kokoro');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const fetchImpl = (async () =>
      new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } })) as unknown as typeof fetch;
    const partial = join(root, 'model.partial');
    const finalPath = join(root, 'model.tar.bz2');
    await expect(downloadVerified('https://example.test/m', partial, finalPath, 'deadbeef', () => {}, fetchImpl)).rejects.toThrow(
      /checksum/,
    );
    expect(() => readFileSync(partial)).toThrow();
    expect(() => readFileSync(finalPath)).toThrow();

    await downloadVerified('https://example.test/m', partial, finalPath, sha, () => {}, fetchImpl);
    expect(readFileSync(finalPath).toString()).toBe('kokoro');
    expect(() => readFileSync(partial)).toThrow();
  });
});

describe('speech routes', () => {
  test('refuses to speak until the model is downloaded and enabled', async () => {
    const root = tempDir();
    const { app } = appWith(root, okRunner());
    const missing = await app.request('/api/v1/audio/speech', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'kokoro-82m', input: 'Hello', voice: 'default' }),
    });
    expect(missing.status).toBe(503);
    expect(((await missing.json()) as { error: string }).error).toBe('TTS_NOT_READY');

    const denied = await app.request('/api/v1/setup/tts.json', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ enabled: true }),
    });
    expect(denied.status).toBe(400);

    installFakeKokoro(root);
    const off = await app.request('/api/v1/audio/speech', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'kokoro-82m', input: 'Hello', voice: 'default' }),
    });
    expect(off.status).toBe(503);
    expect(((await off.json()) as { error: string }).error).toBe('TTS_DISABLED');
  });

  test('returns wav bytes once speech is on', async () => {
    const root = tempDir();
    installFakeKokoro(root);
    const jobs: ReturnType<typeof parseSpeechRequest>[] = [];
    const { app } = appWith(root, okRunner(jobs));
    setConfigTtsEnabled(root, true);
    const res = await app.request('/api/v1/audio/speech', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'kokoro-82m', input: 'Hello', voice: 'default' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from(WAV));
    expect(jobs[0]?.voice.sid).toBe(3);
  });

  test('a token change keeps the speech switch and the selected model', () => {
    const root = tempDir();
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ token: 'old', port: 38000, ttsEnabled: true, ttsModel: 'zh' }),
    );
    const after = setConfigToken(root, 'new');
    expect(after.ttsEnabled).toBe(true);
    expect(after.ttsModel).toBe('zh');
    expect(after.token).toBe('new');
  });
});

describe('voice catalog', () => {
  test('Kokoro ids carry a display name, locale, and gender', () => {
    expect(kokoroVoice('af_heart')).toEqual({
      id: 'af_heart',
      name: 'Heart',
      language_codes: ['en-US'],
      gender: 'FEMALE',
      vendor: 'kokoro',
    });
    expect(kokoroVoice('bm_fable')).toMatchObject({ name: 'Fable', language_codes: ['en-GB'], gender: 'MALE' });
    expect(kokoroVoice('zf_001')).toMatchObject({ name: 'zf_001', language_codes: ['zh-CN'], gender: 'FEMALE' });
  });

  test('say and SAPI listings become os/ voices', () => {
    const say = parseSayListing([
      'Tingting            zh_CN    # 你好！我叫婷婷。',
      'Eddy (Chinese (China mainland)) zh_CN    # 你好！我叫Eddy。',
      'Bad/Name            en_US    # skipped',
    ].join('\n'));
    expect(say).toEqual([
      { name: 'Tingting', language: 'zh-CN', gender: 'NEUTRAL' },
      { name: 'Eddy (Chinese (China mainland))', language: 'zh-CN', gender: 'NEUTRAL' },
    ]);
    expect(parseSapiListing('Microsoft Zira Desktop\ten-US\tFemale\nWeird/Name\ten-US\tMale')).toEqual([
      { name: 'Microsoft Zira Desktop', language: 'en-US', gender: 'FEMALE' },
    ]);
  });

  test('an os/ voice is accepted and does not require Kokoro', () => {
    const job = parseSpeechRequest({ model: 'kokoro-82m', input: 'Hello', voice: 'os/Tingting' }, 'zh');
    expect(job.voice).toEqual({ id: 'os/Tingting', sid: 0, osName: 'Tingting' });
    expect(() => parseSpeechRequest({ model: 'kokoro-82m', input: 'Hello', voice: 'os/' })).toThrow(/voice/);
    expect(() => parseSpeechRequest({ model: 'kokoro-82m', input: 'Hello', voice: 'os/a/b' })).toThrow(/voice/);
  });

  test('lists downloaded Kokoro voices and the OS voices', async () => {
    const root = tempDir();
    const voices = join(mlxHubDir(root), 'models--mlx-community--Kokoro-82M-bf16', 'snapshots', 'test', 'voices');
    mkdirSync(voices, { recursive: true });
    writeFileSync(join(voices, 'af_heart.safetensors'), '');
    writeFileSync(join(voices, 'af_heart.pt'), '');
    const { app } = appWith(root, okRunner());
    const res = await app.request('/api/v1/voices.json', { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { voices: { id: string; vendor: string; name: string }[] };
    expect(body.voices.find((voice) => voice.id === 'af_heart')).toMatchObject({
      name: 'Heart',
      vendor: 'kokoro',
    });
    expect(body.voices.some((voice) => voice.id === 'af_heart.pt' || voice.vendor === 'kokoro' && voice.id.endsWith('.pt'))).toBe(false);
    if (process.platform === 'darwin' || process.platform === 'win32') {
      expect(body.voices.some((voice) => voice.vendor === 'os' && voice.id.startsWith('os/'))).toBe(true);
    }
    if (process.platform === 'darwin') {
      expect(body.voices.some((voice) => voice.id === 'os/Tingting')).toBe(true);
    }
  });

  test('an installed OS voice speaks without Kokoro', async () => {
    if (process.platform !== 'darwin') return;
    const root = tempDir();
    const { app } = appWith(root, okRunner());
    const res = await app.request('/api/v1/audio/speech', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'kokoro-82m', input: 'Hello.', voice: 'os/Tingting' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(44);
  });
});
