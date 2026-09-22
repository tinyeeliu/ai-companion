/**
 * The navigation model for the Companion window.
 *
 * Every page declares where it sits in the hierarchy once, here. The shell
 * (App.svelte) renders the frame from this metadata, so adding a page means
 * adding a record rather than editing the shell. The hash URLs are unchanged
 * from the previous `hash.ts`.
 */

import { isMessageStatus, type MessageStatus } from './api';

/** Merges both directions; the default so the page opens on the full history. */
export type DirectionFilter = 'all' | 'in' | 'out';

/**
 * Top-level pages carry no context, so they can be linked from anywhere
 * (breadcrumb, back control, rail). Keep this list in sync with
 * {@link PRIMARY_PAGES}.
 */
export type TopPageId = 'phones';

export type PageId = TopPageId | 'messages';

/** Values a page publishes at runtime so the breadcrumb can name it. */
export type CrumbKey = 'connectionId';

/** One breadcrumb segment: exactly one of `key` (dictionary) or `from` (runtime). */
export interface TrailSegment {
  /** Static label from the dictionary. */
  key?: string;
  /** Makes the segment clickable. */
  to?: TopPageId;
  /** Label read from a value the page published with `setCrumb`. */
  from?: CrumbKey;
}

export interface RouteMeta {
  /** Short name for navigation chrome and the back control. */
  navLabelKey: string;
  titleKey: string;
  hintKey: string;
  trail: TrailSegment[];
  /** Back target. `null` for top-level pages. */
  parent: TopPageId | null;
  /** `primary` pages are listed by the rail; `hidden` pages are reached from content. */
  nav: 'primary' | 'hidden';
}

export const ROUTES: Record<PageId, RouteMeta> = {
  phones: {
    navLabelKey: 'nav.phones',
    titleKey: 'app.phonesTitle',
    hintKey: 'app.phonesHint',
    trail: [{ key: 'nav.phones' }],
    parent: null,
    nav: 'primary',
  },
  messages: {
    navLabelKey: 'page.messages.title',
    titleKey: 'page.messages.title',
    hintKey: 'history.hint',
    trail: [{ key: 'nav.phones', to: 'phones' }, { from: 'connectionId' }],
    parent: 'phones',
    nav: 'hidden',
  },
};

/**
 * Pages the rail lists, in display order. The rail is not shown yet, so this
 * only reserves the shape; every entry also declares `nav: 'primary'` above.
 */
export const PRIMARY_PAGES: readonly TopPageId[] = ['phones'];

/**
 * The history view, filters included. These live in the hash query string so a
 * reload — or a link handed to someone else — restores the same view.
 */
export interface MessagesParams {
  connectionId: string;
  direction: DirectionFilter;
  type: string | null;
  status: MessageStatus | null;
  page: number;
}

export type MatchedRoute =
  | { id: 'phones'; params: null }
  | { id: 'messages'; params: MessagesParams };

/** Matched route for a top-level page. */
export function pageRoute(id: TopPageId): MatchedRoute {
  return { id, params: null };
}

/** Any subset of the filters; whatever is left out falls back to its default. */
export type MessageFilters = Partial<Omit<MessagesParams, 'connectionId'>>;

export function messagesRoute(connectionId: string, filters: MessageFilters = {}): MatchedRoute {
  return {
    id: 'messages',
    params: {
      connectionId,
      direction: filters.direction ?? 'all',
      type: filters.type ?? null,
      status: filters.status ?? null,
      page: filters.page ?? 1,
    },
  };
}

export function routeHash(route: MatchedRoute): string {
  if (route.id === 'phones') return '#/';
  const { connectionId, direction, type, status, page } = route.params;
  // Defaults stay out of the URL, so the unfiltered view is just the path.
  const query = new URLSearchParams();
  if (direction !== 'all') query.set('direction', direction);
  if (type != null && type !== '') query.set('type', type);
  if (status != null) query.set('status', status);
  if (page > 1) query.set('page', String(page));
  const suffix = query.toString();
  return `#/messages/${encodeURIComponent(connectionId)}${suffix === '' ? '' : `?${suffix}`}`;
}

function parseDirectionFilter(value: string | null): DirectionFilter {
  return value === 'in' || value === 'out' || value === 'all' ? value : 'all';
}

function parsePage(raw: string | null): number {
  const page = Number(raw ?? '1');
  return Number.isInteger(page) && page > 0 ? page : 1;
}

export function parseRoute(hash = typeof location !== 'undefined' ? location.hash : ''): MatchedRoute {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const url = new URL(raw === '' ? '/' : raw, 'http://companion.local');
  const parts = url.pathname.split('/').filter((part) => part !== '');
  if (parts[0] === 'messages' && parts[1] != null && parts[1] !== '') {
    // `received` / `sent` are the two legacy single-direction paths. They stay
    // readable so links saved before the merge keep resolving.
    const legacy = parts[2];
    const direction =
      legacy === 'received'
        ? 'in'
        : legacy === 'sent'
          ? 'out'
          : parseDirectionFilter(url.searchParams.get('direction'));
    const type = url.searchParams.get('type');
    const status = url.searchParams.get('status');
    return messagesRoute(decodeURIComponent(parts[1]), {
      direction,
      type: type != null && type.trim() !== '' ? type.trim() : null,
      status: isMessageStatus(status) ? status : null,
      page: parsePage(url.searchParams.get('page')),
    });
  }
  return pageRoute('phones');
}
