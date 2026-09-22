<script lang="ts">
  import LanguageSelect from './LanguageSelect.svelte';
  import { tr as translate } from './i18n';
  import { navigate } from './nav';
  import { pageRoute } from './routes';
  import { tip } from './tooltip';

  /**
   * App-level chrome. Mounted once by App.svelte, outside the route outlet, so
   * the brand and the backend health indicator never re-render with a page.
   *
   * Reserved slots, both off for now: `menu` is where the overflow menu button
   * goes, and the spacer is where a top nav strip goes once there are more than
   * a couple of live sections. The rail (NavRail) is the third slot.
   *
   * The brand is also the way home: it points at the first primary page, so it
   * keeps working when another page becomes the default.
   */
  let { running, menu = false }: { running: boolean; menu?: boolean } = $props();
</script>

<header class="titlebar">
  <button
    class="brand-btn"
    type="button"
    use:tip={$translate('nav.home')}
    onclick={() => navigate(pageRoute('phones'))}
  >
    <span class="brand-mark" aria-hidden="true">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
        <path
          d="M2.2 3.6h11.6v7.2H7.4L4 13.4v-2.6H2.2z"
          stroke="currentColor"
          stroke-width="1.35"
          stroke-linejoin="round"
        />
        <path d="M5.4 7.2h5.2" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
      </svg>
    </span>
    <span class="brand">AI Companion</span>
  </button>

  <span class="grow"></span>

  <span class="health" use:tip={$translate('nav.health')}>
    <span class="dot" class:warn={!running} aria-hidden="true"></span>
    {$translate(running ? 'app.ready' : 'app.offline')}
  </span>

  <LanguageSelect />

  {#if menu}
    <button class="icon-btn" type="button" use:tip={$translate('nav.menu')} aria-label={$translate('nav.menu')}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
        <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
      </svg>
    </button>
  {/if}
</header>
