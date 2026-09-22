<script lang="ts">
  import { tr as translate } from './i18n';
  import { navigate } from './nav';
  import { pageRoute, PRIMARY_PAGES, ROUTES, type PageId } from './routes';

  /**
   * Reserved navigation rail. It is not shown yet: App.svelte passes
   * `open={false}` until there is more than one section, which keeps the
   * reserved grid column at 0px. The entries come from PRIMARY_PAGES, so the
   * rail needs no changes when a second top-level page lands.
   */
  let { open, current }: { open: boolean; current: PageId } = $props();
</script>

{#if open}
  <nav class="rail" aria-label={$translate('nav.rail')}>
    <p class="rail-title">{$translate('nav.rail')}</p>
    {#each PRIMARY_PAGES as id (id)}
      <button
        class="rail-item"
        class:active={id === current}
        type="button"
        aria-current={id === current ? 'page' : undefined}
        onclick={() => navigate(pageRoute(id))}
      >
        {$translate(ROUTES[id].navLabelKey)}
      </button>
    {/each}
  </nav>
{/if}
