import type { DisconnectReasonName } from './types';

function statusOf(error: unknown): number | undefined {
  if (error == null || typeof error !== 'object') return undefined;
  const output = (error as { output?: { statusCode?: number } }).output;
  return typeof output?.statusCode === 'number' ? output.statusCode : undefined;
}

/** Map Baileys/Boom close codes. Numbers match @whiskeysockets/baileys DisconnectReason. */
export function mapDisconnect(error: unknown): DisconnectReasonName {
  const status = statusOf(error);
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (status === 401) return 'logout';
  if (status === 440) return 'replaced';
  if (status === 405) return 'rate_limited';
  if (status === 515) return 'restart';
  if (status === 500 || message.includes('Bad MAC')) return 'auth_corrupt';
  return 'transient';
}
