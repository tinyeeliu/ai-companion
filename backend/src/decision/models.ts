/**
 * The one accelerated decision model Companion installs.
 * mlx-decision 0.8.1 lists this repo in its Laya family. The PyTorch `laya`
 * package is a different install and is not used.
 */
export const MODEL_ID = 'laya-multilingual';
export const REPO_ID = 'convaiinnovations/laya-multilingual';
export const MLX_DECISION_SPEC = 'mlx-decision==0.8.1';

/** Files the Laya family loader reads. Matches mlx-decision's registry. */
export const DOWNLOAD_PATTERNS = [
  'model.safetensors',
  'encoder/*',
  'tokenizer/*',
  'README.md',
  'LICENSE*',
  'rl_agent_config.json',
  '*.json',
];
