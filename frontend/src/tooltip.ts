const GAP = 8;
const EDGE = 4;

/**
 * Native `title` tooltips are slow and get clipped by the scrollable table wrap
 * and dialogs, so icon-only buttons use this instead. The host is a single
 * fixed-position element on `document.body`, which keeps tooltips above every
 * `overflow` ancestor. The button keeps its `aria-label`, so the accessible
 * name does not depend on this.
 */
let host: HTMLDivElement | null = null;
let shownFor: HTMLElement | null = null;

function hostElement(): HTMLDivElement {
  if (host == null || !host.isConnected) {
    host = document.createElement('div');
    host.className = 'tooltip';
    host.setAttribute('role', 'tooltip');
    document.body.appendChild(host);
  }
  return host;
}

function hide(): void {
  if (host != null) host.classList.remove('is-visible');
  shownFor = null;
}

function place(node: HTMLElement, text: string): void {
  const el = hostElement();
  el.textContent = text;
  el.classList.add('is-visible');
  shownFor = node;

  // Measured after the text is set so the tooltip size is current.
  const anchor = node.getBoundingClientRect();
  const width = el.offsetWidth;
  const height = el.offsetHeight;

  let top = anchor.top - height - GAP;
  // Flip below when there is no room above.
  if (top < EDGE) top = Math.min(anchor.bottom + GAP, window.innerHeight - height - EDGE);

  const centered = anchor.left + anchor.width / 2 - width / 2;
  const maxLeft = Math.max(EDGE, window.innerWidth - width - EDGE);
  const left = Math.min(Math.max(EDGE, centered), maxLeft);

  el.style.top = `${Math.round(top)}px`;
  el.style.left = `${Math.round(left)}px`;
}

function onScroll(): void {
  hide();
}

/** `use:tip={label}` — shows a styled tooltip while hovered or focused. */
export function tip(
  node: HTMLElement,
  label: string,
): { update: (next: string) => void; destroy: () => void } {
  let text = label;

  const show = (): void => place(node, text);
  const leave = (): void => {
    if (shownFor === node) hide();
  };

  node.addEventListener('pointerenter', show);
  node.addEventListener('pointerleave', leave);
  node.addEventListener('focus', show);
  node.addEventListener('blur', leave);
  window.addEventListener('scroll', onScroll, true);

  return {
    update(next: string): void {
      text = next;
      // Reflect a label change mid-hover (e.g. Copy → Copied).
      if (shownFor === node) place(node, text);
    },
    destroy(): void {
      node.removeEventListener('pointerenter', show);
      node.removeEventListener('pointerleave', leave);
      node.removeEventListener('focus', show);
      node.removeEventListener('blur', leave);
      window.removeEventListener('scroll', onScroll, true);
      leave();
    },
  };
}
