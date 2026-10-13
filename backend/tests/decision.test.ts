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
import { parseDecisionRequest, type DecisionJob } from '../src/decision/parse';
import { DecisionQueue, type DecisionResult } from '../src/decision/queue';
import { openaiToSystemOne, systemOneToOpenai } from '../src/decision/translate';
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

function appWith(
  root: string,
  session: DecisionEngine,
  accelerated = true,
  run: (job: DecisionJob) => Promise<DecisionResult> = async () => {
    throw new Error('decision ran');
  },
) {
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
      queue: new DecisionQueue({ run }),
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

describe('openaiToSystemOne', () => {
  const body = {
    model: 'gpt-6-luna',
    input: [{ role: 'user', content: [{ type: 'input_text', text: '盒子破了' }] }],
    questions: [
      { type: 'predicate', name: 'damaged', instructions: 'Is it damaged?' },
      {
        type: 'choice',
        name: 'ok',
        instructions: 'Is the report accepted?',
        choices: [{ value: true, description: 'yes' }, { value: false, description: 'no' }],
      },
      {
        type: 'score',
        instructions: 'How urgent is it?',
        levels: [{ label: 'low' }, { label: 'high', description: 'Act today' }],
      },
    ],
  };

  test('maps predicate, a boolean choice, and score labels', () => {
    const { job, trace } = openaiToSystemOne(body);
    expect(job.state).toBe('盒子破了');
    expect(job.questions.damaged).toEqual({ type: 'noul', instructions: 'Is it damaged?' });
    expect(job.questions.ok).toEqual({
      type: 'choice',
      instructions: 'Is the report accepted?',
      criteria: { true: 'yes', false: 'no' },
    });
    expect(job.questions['#2']).toEqual({
      type: 'score',
      instructions: 'How urgent is it?',
      criteria: ['low', 'Act today'],
    });
    const result: DecisionResult = {
      model: 'laya-multilingual',
      answers: {
        damaged: { type: 'noul', noul: 0.95 },
        ok: { type: 'choice', choice: 'true', confidence: 0.8, probabilities: { true: 0.8, false: 0.2 } },
        '#2': { type: 'score', score: 1.3, confidence: 0.6, probabilities: { '0': 0.1, '1': 0.9 } },
      },
      usage: { input_tokens: 44, output_tokens: 0 },
    };
    expect(systemOneToOpenai(result, trace)).toEqual({
      model: 'laya-multilingual',
      answers: [
        { type: 'predicate', name: 'damaged', probability: 0.95 },
        {
          type: 'choice',
          name: 'ok',
          choice: true,
          confidence: 0.8,
          probabilities: [
            { value: true, probability: 0.8 },
            { value: false, probability: 0.2 },
          ],
        },
        {
          type: 'score',
          name: null,
          score: 1.3,
          confidence: 0.6,
          probabilities: [
            { value: 0, label: 'low', probability: 0.1 },
            { value: 1, label: 'high', probability: 0.9 },
          ],
        },
      ],
      usage: { input_tokens: 44, output_tokens: 0, total_tokens: 44 },
    });
  });

  test('refuses an image and a repeated choice value', () => {
    expect(() => openaiToSystemOne({
      input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,aa' }] }],
      questions: [{ type: 'predicate', name: 'seen', instructions: 'Is it visible?' }],
    })).toThrow(/images/);
    expect(() => openaiToSystemOne({
      input: 'hi',
      questions: [{
        type: 'choice',
        name: 'ok',
        instructions: 'Pick',
        choices: [{ value: true }, { value: 'true' }],
      }],
    })).toThrow(/repeats choice/);
    expect(() => openaiToSystemOne({
      input: 'hi',
      questions: [
        { type: 'predicate', name: 'same', instructions: 'A' },
        { type: 'predicate', name: 'same', instructions: 'B' },
      ],
    })).toThrow(/duplicate question name/);
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

  test('the OpenAI route is not ready until the model is downloaded', async () => {
    const root = tempRoot();
    const { app } = appWith(root, idleEngine());
    const res = await app.request('/api/v1/decisions.json', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-6-luna',
        input: 'hi',
        questions: [{ type: 'predicate', name: 'ok', instructions: 'Is it ok?' }],
      }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'DECISION_NOT_READY' });
  });

  test('the OpenAI route returns answers in question order', async () => {
    const root = tempRoot();
    installFakeModel(root);
    const { app } = appWith(root, idleEngine(), true, async () => ({
      model: 'laya-multilingual',
      answers: {
        damaged: { type: 'noul', noul: 0.95 },
        queue: {
          type: 'choice',
          choice: 'shipping',
          confidence: 0.81,
          probabilities: { billing: 0.19, shipping: 0.81 },
        },
      },
      usage: { input_tokens: 10, output_tokens: 0 },
    }));
    writeFileSync(join(root, 'config.json'), JSON.stringify({ token: TOKEN, port: 38888, decisionEnabled: true }));
    const res = await app.request('/api/v1/decisions.json', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-6-luna',
        input: 'The screen is broken.',
        questions: [
          { type: 'predicate', name: 'damaged', instructions: 'Is it damaged?' },
          {
            type: 'choice',
            name: 'queue',
            instructions: 'Which team?',
            choices: [
              { value: 'billing', description: 'Payments' },
              { value: 'shipping', description: 'Delivery' },
            ],
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { model: string; answers: { type: string; name: string }[]; usage: { total_tokens: number } };
    expect(body.model).toBe('laya-multilingual');
    expect(body.answers.map((item) => item.type)).toEqual(['predicate', 'choice']);
    expect(body.answers[1]).toMatchObject({ name: 'queue', choice: 'shipping' });
    expect(body.usage.total_tokens).toBe(10);
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
