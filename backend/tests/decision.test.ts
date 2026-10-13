/**
 * System One parsing and the Setup gates. The mlx-decision process is not
 * spawned here, and nothing is downloaded.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { createApp } from '../src/app';
import { modelMarker, pythonBin, pythonDir } from '../src/decision/layout';
import { parseDecisionRequest } from '../src/decision/parse';
import { DecisionQueue } from '../src/decision/queue';
import type { DecisionEngine } from '../src/decision/session';
import { DecisionSetup } from '../src/decision/setup';
import { ConnectionManager } from '../src/manager';
import { ConnectionStore } from '../src/store';
import { setConfigDecisionEnabled, setConfigToken } from '../src/token';
import { fakeFactory } from './fake-whatsapp';

const dirs: string[] = [];
const TOKEN = 'test-token';

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'companion-decision-'));
  dirs.push(root);
  return root;
}

/** Empty stand-ins for the files the readiness check looks for. */
function installFakeModel(root: string): void {
  mkdirSync(dirname(modelMarker(root)), { recursive: true });
  writeFileSync(modelMarker(root), 'convaiinnovations/laya-multilingual\n');
  mkdirSync(dirname(pythonBin(root)), { recursive: true });
  writeFileSync(pythonBin(root), '');
  writeFileSync(join(pythonDir(root), 'python.ready'), 'ok\n');
}

const QUESTION = {
  team: {
    type: 'choice',
    instructions: 'Which team should handle this?',
    criteria: { returns: 'Damaged goods', billing: 'Payments', other: 'Anything else' },
  },
};

function appWith(root: string, session: DecisionEngine, accelerated = true) {
  const manager = new ConnectionManager(new ConnectionStore(root), fakeFactory(new Map()), fetch);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ token: TOKEN, port: 38888, decisionEnabled: false }));
  let fetched = false;
  const setup = new DecisionSetup({
    root,
    session,
    accelerated,
    fetchImpl: (async () => {
      fetched = true;
      throw new Error('download was called');
    }) as unknown as typeof fetch,
  });
  const app = createApp({
    manager,
    token: TOKEN,
    port: 38888,
    configRoot: root,
    decision: {
      queue: new DecisionQueue({
        async run() {
          throw new Error('decision ran');
        },
      }),
      setup,
    },
  });
  return {
    app,
    setup,
    downloaded: () => fetched,
  };
}

function idleEngine(): DecisionEngine & { loads: number } {
  const engine = {
    loads: 0,
    async load() {
      engine.loads += 1;
    },
    async unload() {},
    runner: () => ({
      async run() {
        throw new Error('decision ran');
      },
    }),
  };
  return engine;
}

describe('parseDecisionRequest', () => {
  test('accepts a System One body and an omitted model', () => {
    const job = parseDecisionRequest({ state: '盒子破了', questions: QUESTION });
    expect(job.state).toBe('盒子破了');
    expect(job.questions.team).toEqual(QUESTION.team);
    const named = parseDecisionRequest({
      state: { text: '盒子破了' },
      model: 'laya-multilingual',
      questions: QUESTION,
    });
    expect(named.state).toEqual({ text: '盒子破了' });
  });

  test('rejects another model, an empty question map, and a bad choice', () => {
    expect(() => parseDecisionRequest({ state: 'hi', model: 'jev-latest', questions: QUESTION })).toThrow(
      /laya-multilingual/,
    );
    expect(() => parseDecisionRequest({ state: 'hi', questions: {} })).toThrow(/at least one question/);
    expect(() => parseDecisionRequest({
      state: 'hi',
      questions: { team: { type: 'choice', criteria: {} } },
    })).toThrow(/criteria/);
    expect(() => parseDecisionRequest({ state: 'hi', questions: QUESTION, images: [] })).toThrow(/unsupported field/);
  });
});

describe('decision route', () => {
  test('a missing download is not ready', async () => {
    const root = tempRoot();
    const { app, downloaded } = appWith(root, idleEngine());
    writeFileSync(join(root, 'config.json'), JSON.stringify({ token: TOKEN, port: 38888, decisionEnabled: true }));
    const res = await app.request('/api/v1/systemone.json', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: '盒子破了', questions: QUESTION }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'DECISION_NOT_READY' });
    expect(downloaded()).toBe(false);
  });

  test('a downloaded model that is switched off is disabled', async () => {
    const root = tempRoot();
    installFakeModel(root);
    const { app } = appWith(root, idleEngine());
    const res = await app.request('/api/v1/systemone.json', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: '盒子破了', questions: QUESTION }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'DECISION_DISABLED' });
  });

  test('enable with planted files loads and does not download', async () => {
    const root = tempRoot();
    installFakeModel(root);
    const engine = idleEngine();
    const { app, downloaded } = appWith(root, engine);
    const res = await app.request('/api/v1/setup/decision.json', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    const view = await res.json() as { enabled: boolean; model: string; downloaded: boolean };
    expect(view.enabled).toBe(true);
    expect(view.downloaded).toBe(true);
    expect(view.model).toBe('laya-multilingual');
    expect(engine.loads).toBe(1);
    expect(downloaded()).toBe(false);
    const list = await app.request('/api/v1/setup.json');
    const body = await list.json() as { features: { id: string }[] };
    expect(body.features.map((item) => item.id)).toEqual(['decision']);
  });

  test('a machine without Metal has no model and refuses download', async () => {
    const root = tempRoot();
    const { app } = appWith(root, idleEngine(), false);
    const view = await (await app.request('/api/v1/setup.json')).json() as {
      features: { id: string; model: string | null; models: unknown[] }[];
    };
    expect(view.features[0]).toMatchObject({ id: 'decision', model: null, models: [] });
    const res = await app.request('/api/v1/setup/decision/download.json', { method: 'POST' });
    expect(res.status).toBe(400);
  });
});

describe('config', () => {
  test('a token change keeps the decision switch and the speech settings', () => {
    const root = tempRoot();
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ token: 'old', port: 38000, ttsEnabled: true, ttsModel: 'zh', decisionEnabled: true }),
    );
    const after = setConfigToken(root, 'new');
    expect(after.decisionEnabled).toBe(true);
    expect(after.ttsEnabled).toBe(true);
    expect(after.ttsModel).toBe('zh');
    const toggled = setConfigDecisionEnabled(root, false);
    expect(toggled.decisionEnabled).toBe(false);
    expect(toggled.ttsEnabled).toBe(true);
    expect(toggled.ttsModel).toBe('zh');
  });
});
