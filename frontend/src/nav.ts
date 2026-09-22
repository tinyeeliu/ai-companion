import { derived, writable } from 'svelte/store';
import { locale, resolve } from './i18n';
import { ROUTES, parseRoute, routeHash, type CrumbKey, type MatchedRoute } from './routes';

export const APP_TITLE = 'AI Companion';

/** Current route, kept in sync with `location.hash`. Call `initNav()` to start. */
export const route = writable<MatchedRoute>(parseRoute());

/** Labels published by the active page, keyed by `CrumbKey`. */
export const crumbs = writable<Partial<Record<CrumbKey, string>>>({});

/**
 * Window title, e.g. `Received · WhatsappSide · AI Companion`. Derived so a
 * page only has to publish its crumb — no page sets the title directly.
 */
export const documentTitle = derived([route, crumbs, locale], ([$route, $crumbs, $locale]) => {
  const meta = ROUTES[$route.id];
  const parts = [resolve($locale, meta.titleKey)];
  for (const segment of meta.trail) {
    if (segment.from == null) continue;
    const value = $crumbs[segment.from];
    if (value != null && value !== '') parts.push(value);
  }
  parts.push(APP_TITLE);
  return parts.join(' · ');
});

/** Track the hash and keep the window title current. Returns the teardown. */
export function initNav(): () => void {
  const sync = (): void => {
    // Crumbs describe the page being left; the next page publishes its own.
    crumbs.set({});
    route.set(parseRoute());
  };
  const stopTitle = documentTitle.subscribe((value) => {
    document.title = value;
  });
  window.addEventListener('hashchange', sync);
  sync();
  return () => {
    window.removeEventListener('hashchange', sync);
    stopTitle();
  };
}

export function navigate(next: MatchedRoute): void {
  location.hash = routeHash(next);
}

/** Publish a breadcrumb label for the active route. Pass `null` to clear it. */
export function setCrumb(key: CrumbKey, value: string | null): void {
  crumbs.update((current) => {
    if ((current[key] ?? null) === value) return current;
    const next = { ...current };
    if (value == null || value === '') delete next[key];
    else next[key] = value;
    return next;
  });
}
