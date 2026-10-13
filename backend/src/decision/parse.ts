/**
 * The System One body Companion accepts.
 * `model` is `laya-multilingual` or omitted. Any other name is refused.
 * Question shape follows mlx-decision: choice, noul, and score.
 */
import { HttpError } from '../types';
import { MODEL_ID } from './models';

const FIELDS = new Set(['state', 'questions', 'model']);
const QUESTION_TYPES = new Set(['choice', 'noul', 'score']);

export interface DecisionJob {
  state: unknown;
  questions: Record<string, unknown>;
}

export function parseDecisionRequest(body: Record<string, unknown>): DecisionJob {
  for (const key of Object.keys(body)) {
    if (!FIELDS.has(key)) throw new HttpError(400, 'INVALID_PARAM', `unsupported field ${key}`);
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'state')) {
    throw new HttpError(400, 'INVALID_PARAM', 'state is required');
  }
  if (body.model != null && body.model !== MODEL_ID) {
    throw new HttpError(400, 'INVALID_PARAM', `model must be ${MODEL_ID}`);
  }
  const questions = body.questions;
  if (questions == null || typeof questions !== 'object' || Array.isArray(questions)) {
    throw new HttpError(400, 'INVALID_PARAM', 'questions must be an object');
  }
  const entries = Object.entries(questions);
  if (entries.length === 0) throw new HttpError(400, 'INVALID_PARAM', 'at least one question is required');
  for (const [id, question] of entries) {
    if (id.trim() === '') throw new HttpError(400, 'INVALID_PARAM', 'question ids must not be empty');
    checkQuestion(id, question);
  }
  return { state: body.state, questions: questions as Record<string, unknown> };
}

function checkQuestion(id: string, question: unknown): void {
  if (question == null || typeof question !== 'object' || Array.isArray(question)) {
    throw new HttpError(400, 'INVALID_PARAM', `questions.${id} must be an object`);
  }
  const record = question as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== 'string' || !QUESTION_TYPES.has(type)) {
    throw new HttpError(400, 'INVALID_PARAM', `questions.${id}.type must be choice, noul, or score`);
  }
  if (record.instructions != null && !isJson(record.instructions)) {
    throw new HttpError(400, 'INVALID_PARAM', `questions.${id}.instructions is not JSON data`);
  }
  if (type === 'choice') {
    const criteria = record.criteria;
    if (criteria == null || typeof criteria !== 'object' || Array.isArray(criteria) || Object.keys(criteria).length === 0) {
      throw new HttpError(400, 'INVALID_PARAM', `questions.${id}.criteria must map option ids to descriptions`);
    }
  } else if (type === 'score') {
    const criteria = record.criteria;
    if (!Array.isArray(criteria) || criteria.length < 2) {
      throw new HttpError(400, 'INVALID_PARAM', `questions.${id}.criteria must list at least two levels`);
    }
  } else if (record.criteria != null) {
    const criteria = record.criteria;
    if (criteria == null || typeof criteria !== 'object' || Array.isArray(criteria)) {
      throw new HttpError(400, 'INVALID_PARAM', `questions.${id}.criteria must describe true and false`);
    }
    for (const key of Object.keys(criteria)) {
      if (key !== 'true' && key !== 'false') {
        throw new HttpError(400, 'INVALID_PARAM', `questions.${id}.criteria can only describe true and false`);
      }
    }
  }
}

function isJson(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}
