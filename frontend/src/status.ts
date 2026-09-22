import type { Translate } from './i18n';

export function statusLabel(status: string, tr: Translate): string {
  switch (status) {
    case 'connected':
      return tr('status.connected');
    case 'qr':
    case 'connecting':
      return tr('status.waiting');
    case 'disabled':
      return tr('status.paused');
    case 'disconnected':
    case 'error':
    default:
      return tr('status.scanAgain');
  }
}

export function statusTone(status: string): 'success' | 'warning' | 'neutral' | 'danger' {
  switch (status) {
    case 'connected':
      return 'success';
    case 'qr':
    case 'connecting':
      return 'warning';
    case 'disabled':
      return 'neutral';
    default:
      return 'danger';
  }
}

export function formatUptime(ms: number | undefined, tr: Translate): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const h = tr('time.hoursShort');
  const m = tr('time.minutesShort');
  const s = tr('time.secondsShort');
  if (hours > 0) return `${hours}${h} ${minutes}${m} ${seconds}${s}`;
  if (minutes > 0) return `${minutes}${m} ${seconds}${s}`;
  return `${seconds}${s}`;
}

export function formatTimestamp(ms: number | undefined, locale?: string): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—';
  return new Date(ms).toLocaleString(locale);
}

/**
 * Human-readable label for a stored message type. Unknown values come straight
 * from the backend, so they pass through unchanged rather than reading as blank.
 */
export function messageTypeLabel(type: string, tr: Translate): string {
  switch (type) {
    case 'text':
      return tr('msgtype.text');
    case 'image':
      return tr('msgtype.image');
    case 'audio':
      return tr('msgtype.audio');
    case 'video':
      return tr('msgtype.video');
    case 'document':
      return tr('msgtype.document');
    case 'sticker':
      return tr('msgtype.sticker');
    case 'location':
      return tr('msgtype.location');
    case 'contact':
      return tr('msgtype.contact');
    case 'unknown':
      return tr('msgtype.unknown');
    default:
      return type;
  }
}

export function accountLabel(phone: string | undefined, tr: Translate): string {
  if (phone == null || phone.trim() === '') return tr('status.notLinked');
  return phone;
}

export function userLabel(user: string | undefined): string {
  if (user == null || user.trim() === '') return '—';
  return user;
}

export function channelLabel(channel: string, tr: Translate): string {
  return channel === 'line' ? tr('channel.line') : tr('channel.whatsapp');
}

export function isWaiting(status: string): boolean {
  return status === 'qr' || status === 'connecting';
}

export function isLinked(status: string): boolean {
  return status === 'connected';
}

export function isPaused(status: string): boolean {
  return status === 'disabled';
}

/**
 * Delivery state of a queued message. `na` is history that was never queued and
 * has no label of its own, so the cell reads as an empty value.
 *
 * A failed row carries its attempt count: a give-up after retries reads
 * differently from a receiver that rejected it outright.
 */
export function messageStatusLabel(status: string, errorCount: number, tr: Translate): string {
  switch (status) {
    case 'pending':
      return tr('history.pending');
    case 'sent':
      return tr('history.sent');
    case 'failed': {
      const label = tr('history.failed');
      return errorCount > 0 ? `${label} (${errorCount})` : label;
    }
    default:
      return '—';
  }
}

export function messageStatusTone(status: string): 'success' | 'warning' | 'neutral' | 'danger' {
  switch (status) {
    case 'sent':
      return 'success';
    case 'pending':
      return 'warning';
    case 'failed':
      return 'danger';
    default:
      return 'neutral';
  }
}

/** Cloud link states, mirroring the backend `CloudStatus`. */
export type CloudTone = 'success' | 'warning' | 'neutral' | 'danger';

export function cloudLabel(status: string, tr: Translate): string {
  switch (status) {
    case 'connected':
      return tr('cloud.connected');
    case 'connecting':
      return tr('cloud.connecting');
    case 'retrying':
      return tr('cloud.retrying');
    case 'rejected':
      return tr('cloud.rejected');
    case 'off':
    default:
      return tr('cloud.off');
  }
}

export function cloudTone(status: string): CloudTone {
  switch (status) {
    case 'connected':
      return 'success';
    case 'connecting':
    case 'retrying':
      return 'warning';
    case 'rejected':
      return 'danger';
    case 'off':
    default:
      return 'neutral';
  }
}
