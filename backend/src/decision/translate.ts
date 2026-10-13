/**
 * Turns an OpenAI Decisions body into a System One job, and the answer back.
 *
 * The model never sees the OpenAI shape. A later model that accepts a System
 * One job gets both HTTP formats from these two functions. No model name, no
 * worker, and no route lives here.
 */
import { HttpError } from '../types';
import type { DecisionJob } from './parse';
import type { DecisionResult } from './queue';

const FIELDS = new Set(['model', 'input', 'questions']);

export interface ChoiceValue {
  key: string;
  value: string | boolean;
}

export interface ScoreLevel {
  label: string;
}

export interface QuestionTrace {
  id: string;
  name: string | null;
  type: 'predicate' | 'choice' | 'score';
  choiceValues?: ChoiceValue[];
  scoreLevels?: ScoreLevel[];
}

export interface OpenaiDecision {
  model: string;
  answers: Record<string, unknown>[];
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
}

export function openaiToSystemOne(body: Record<string, unknown>): { job: DecisionJob; trace: QuestionTrace[] } {
  for (const key of Object.keys(body)) {
    if (!FIELDS.has(key)) throw new HttpError(400, 'INVALID_PARAM', `unsupported field ${key}`);
  }
  if (body.model != null && typeof body.model !== 'string') {
    throw new HttpError(400, 'INVALID_PARAM', 'model must be a string');
  }
  const questions = body.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new HttpError(400, 'INVALID_PARAM', 'questions must be a non-empty array');
  }
  const trace: QuestionTrace[] = [];
  const taken = new Set<string>();
  const systemQuestions: Record<string, unknown> = {};
  questions.forEach((question, index) => {
    const item = readQuestion(question, index, taken);
    trace.push(item.trace);
    systemQuestions[item.trace.id] = item.question;
  });
  return { job: { state: readInput(body.input), questions: systemQuestions }, trace };
}

export function systemOneToOpenai(result: DecisionResult, trace: QuestionTrace[]): OpenaiDecision {
  const inputTokens = numberOrZero(result.usage?.input_tokens);
  const outputTokens = numberOrZero(result.usage?.output_tokens);
  return {
    model: result.model,
    answers: trace.map((item) => toAnswer(item, result.answers?.[item.id])),
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
  };
}

function readInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input) || input.length === 0) {
    throw new HttpError(400, 'INVALID_PARAM', 'input must be a string or user messages');
  }
  const parts: string[] = [];
  for (const message of input) {
    if (message == null || typeof message !== 'object' || Array.isArray(message)) {
      throw new HttpError(400, 'INVALID_PARAM', 'input must be a string or user messages');
    }
    const record = message as Record<string, unknown>;
    if (record.role !== 'user') throw new HttpError(400, 'INVALID_PARAM', 'input messages must be from the user');
    parts.push(readContent(record.content));
  }
  return parts.join('\n');
}

function readContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new HttpError(400, 'INVALID_PARAM', 'input content must be text');
  const texts: string[] = [];
  for (const part of content) {
    if (part == null || typeof part !== 'object' || Array.isArray(part)) {
      throw new HttpError(400, 'INVALID_PARAM', 'input content must be text');
    }
    const record = part as Record<string, unknown>;
    if (record.type === 'input_image') throw new HttpError(400, 'INVALID_PARAM', 'input images are not supported');
    if (record.type !== 'input_text' || typeof record.text !== 'string') {
      throw new HttpError(400, 'INVALID_PARAM', 'input content must be text');
    }
    texts.push(record.text);
  }
  return texts.join('\n');
}

function readQuestion(
  question: unknown,
  index: number,
  taken: Set<string>,
): { trace: QuestionTrace; question: Record<string, unknown> } {
  if (question == null || typeof question !== 'object' || Array.isArray(question)) {
    throw new HttpError(400, 'INVALID_PARAM', `questions[${index}] must be an object`);
  }
  const record = question as Record<string, unknown>;
  const type = record.type;
  if (type !== 'predicate' && type !== 'choice' && type !== 'score') {
    throw new HttpError(400, 'INVALID_PARAM', `questions[${index}].type must be predicate, choice, or score`);
  }
  if (typeof record.instructions !== 'string') {
    throw new HttpError(400, 'INVALID_PARAM', `questions[${index}].instructions must be a string`);
  }
  const name = readName(record.name, index, taken);
  const id = name ?? generatedId(index, taken);
  taken.add(id);
  const trace: QuestionTrace = { id, name, type };
  if (type === 'predicate') {
    return { trace, question: { type: 'noul', instructions: record.instructions } };
  }
  if (type === 'choice') {
    const choiceValues = readChoices(record.choices, index);
    trace.choiceValues = choiceValues;
    const criteria: Record<string, string> = {};
    for (const item of choiceValues) criteria[item.key] = item.key;
    applyDescriptions(criteria, record.choices);
    return { trace, question: { type: 'choice', instructions: record.instructions, criteria } };
  }
  const scoreLevels = readLevels(record.levels, index);
  trace.scoreLevels = scoreLevels;
  return {
    trace,
    question: {
      type: 'score',
      instructions: record.instructions,
      criteria: levelTexts(record.levels, scoreLevels),
    },
  };
}

function readName(name: unknown, index: number, taken: Set<string>): string | null {
  if (name == null) return null;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new HttpError(400, 'INVALID_PARAM', `questions[${index}].name must be a non-empty string`);
  }
  if (taken.has(name)) throw new HttpError(400, 'INVALID_PARAM', `duplicate question name ${name}`);
  return name;
}

function generatedId(index: number, taken: Set<string>): string {
  let id = `#${index}`;
  let extra = 0;
  while (taken.has(id)) {
    extra += 1;
    id = `#${index}-${extra}`;
  }
  return id;
}

function readChoices(choices: unknown, index: number): ChoiceValue[] {
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new HttpError(400, 'INVALID_PARAM', `questions[${index}].choices must list at least one option`);
  }
  const values: ChoiceValue[] = [];
  const keys = new Set<string>();
  for (const choice of choices) {
    if (choice == null || typeof choice !== 'object' || Array.isArray(choice)) {
      throw new HttpError(400, 'INVALID_PARAM', `questions[${index}].choices must list options`);
    }
    const value = (choice as Record<string, unknown>).value;
    if (typeof value !== 'string' && typeof value !== 'boolean') {
      throw new HttpError(400, 'INVALID_PARAM', `questions[${index}].choices values must be strings or booleans`);
    }
    const key = String(value);
    if (keys.has(key)) {
      throw new HttpError(400, 'INVALID_PARAM', `questions[${index}] repeats choice ${key}`);
    }
    keys.add(key);
    values.push({ key, value });
  }
  return values;
}

function applyDescriptions(criteria: Record<string, string>, choices: unknown): void {
  if (!Array.isArray(choices)) return;
  for (const choice of choices) {
    if (choice == null || typeof choice !== 'object' || Array.isArray(choice)) continue;
    const record = choice as Record<string, unknown>;
    if (typeof record.value !== 'string' && typeof record.value !== 'boolean') continue;
    if (typeof record.description === 'string') criteria[String(record.value)] = record.description;
  }
}

function readLevels(levels: unknown, index: number): ScoreLevel[] {
  if (!Array.isArray(levels) || levels.length < 2) {
    throw new HttpError(400, 'INVALID_PARAM', `questions[${index}].levels must list at least two levels`);
  }
  return levels.map((level) => {
    if (level == null || typeof level !== 'object' || Array.isArray(level)) {
      throw new HttpError(400, 'INVALID_PARAM', `questions[${index}].levels must list labels`);
    }
    const label = (level as Record<string, unknown>).label;
    if (typeof label !== 'string' || label === '') {
      throw new HttpError(400, 'INVALID_PARAM', `questions[${index}].levels must list labels`);
    }
    return { label };
  });
}

function levelTexts(levels: unknown, parsed: ScoreLevel[]): string[] {
  if (!Array.isArray(levels)) return parsed.map((level) => level.label);
  return parsed.map((level, index) => {
    const item = levels[index];
    if (item != null && typeof item === 'object' && !Array.isArray(item)) {
      const description = (item as Record<string, unknown>).description;
      if (typeof description === 'string') return description;
    }
    return level.label;
  });
}

function toAnswer(trace: QuestionTrace, answer: unknown): Record<string, unknown> {
  const record = asRecord(answer);
  if (trace.type === 'predicate') {
    return { type: 'predicate', name: trace.name, probability: numberOrZero(record.noul) };
  }
  if (trace.type === 'choice') {
    const probabilities = asRecord(record.probabilities);
    const values = trace.choiceValues ?? [];
    const chosen = values.find((item) => item.key === record.choice) ?? values[0];
    return {
      type: 'choice',
      name: trace.name,
      choice: chosen?.value ?? record.choice,
      confidence: numberOrZero(record.confidence),
      probabilities: values.map((item) => ({ value: item.value, probability: numberOrZero(probabilities[item.key]) })),
    };
  }
  const probabilities = asRecord(record.probabilities);
  const levels = trace.scoreLevels ?? [];
  return {
    type: 'score',
    name: trace.name,
    score: numberOrZero(record.score),
    confidence: numberOrZero(record.confidence),
    probabilities: levels.map((level, index) => ({
      value: index,
      label: level.label,
      probability: numberOrZero(probabilities[String(index)]),
    })),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value != null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
