/**
 * Wires the decision queue to the resident process under `data/decision`.
 * Apple Silicon keeps one mlx-decision process. Other machines mount the
 * routes and refuse the download. Nothing is fetched here.
 */
import { configDecisionEnabled } from '../token';
import { modelReady, pythonReady, supportsDecision } from './layout';
import { DecisionQueue, type DecisionRunner } from './queue';
import { DecisionFailedError, DecisionSession } from './session';
import { DecisionSetup } from './setup';
import type { DecisionRoutesOptions } from './index';

export function createDecision(root: string): DecisionRoutesOptions {
  if (!supportsDecision()) {
    return { queue: new DecisionQueue(unavailable()), setup: new DecisionSetup({ root }) };
  }
  const session = new DecisionSession(root);
  const setup = new DecisionSetup({ root, session });
  if (configDecisionEnabled(root) && pythonReady(root) && modelReady(root)) {
    void session.load().catch((error: unknown) => {
      console.warn('[companion] decision load failed', error);
    });
  }
  return { queue: new DecisionQueue(session.runner()), setup };
}

function unavailable(): DecisionRunner {
  return {
    async run() {
      throw new DecisionFailedError('decision model is not available');
    },
  };
}
