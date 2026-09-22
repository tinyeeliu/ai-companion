<script lang="ts">
  import type { Snippet } from 'svelte';
  import { tr as translate } from './i18n';
  import { crumbs, navigate } from './nav';
  import { pageRoute, ROUTES, type MessagesParams, type PageId, type TopPageId } from './routes';

  /**
   * Per-page header: where you are, how to go up, and what this page is.
   * Everything except `actions` comes from the route registry, so a page never
   * has to describe its own place in the hierarchy.
   */
  let {
    id,
    params = null,
    onNavigate,
    actions,
  }: {
    id: PageId;
    params?: MessagesParams | null;
    onNavigate: (id: TopPageId) => void;
    actions?: Snippet;
  } = $props();

  const meta = $derived(ROUTES[id]);
  const parent = $derived(meta.parent);

  const trail = $derived(
    meta.trail.map((segment) => {
      const from = segment.from;
      const key = segment.key;
      // Fall back to the raw id until the page publishes the connection name.
      const label =
        from != null
          ? ($crumbs[from] ?? (from === 'connectionId' ? (params?.connectionId ?? '') : ''))
          : key != null
            ? $translate(key)
            : '';
      return { label, to: segment.to ?? null };
    }),
  );
</script>

<div class="pageheader">
  <div class="trail">
    {#if parent}
      <button class="back" type="button" onclick={() => onNavigate(parent)}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path
            d="M7.5 2.5 4 6l3.5 3.5"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        {$translate(ROUTES[parent].navLabelKey)}
      </button>
    {/if}

    {#each trail as segment, index (index)}
      {@const to = segment.to}
      {#if index > 0}
        <span class="trail-sep" aria-hidden="true">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
            <path
              d="M4.5 2.5 8 6l-3.5 3.5"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>
      {/if}
      {#if to}
        <button class="trail-link" type="button" onclick={() => onNavigate(to)}>
          {segment.label}
        </button>
      {:else}
        <span class="trail-here">{segment.label}</span>
      {/if}
    {/each}
  </div>

  <div class="pagehead">
    <div class="grow">
      <h1 class="page-title">{$translate(meta.titleKey)}</h1>
      <p class="hint">{$translate(meta.hintKey)}</p>
    </div>
    {#if actions}{@render actions()}{/if}
  </div>
</div>
