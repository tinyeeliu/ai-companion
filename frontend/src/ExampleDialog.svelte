<script lang="ts">
  import { tr } from './i18n';
  import { tip } from './tooltip';

  /**
   * A curl the user can paste into a terminal. One snippet for speech and
   * decision; the gateway dialog has chat and responses, each on the direct
   * path and the model router.
   */
  let {
    title,
    snippets,
    onClose,
  }: {
    title: string;
    snippets: { label: string; text: string }[];
    onClose: () => void;
  } = $props();

  let copied = $state(-1);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  async function writeClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }

  async function copy(index: number, text: string): Promise<void> {
    copied = index;
    if (copyTimer != null) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copied = -1;
    }, 2000);
    try {
      await writeClipboard(text);
    } catch {
      copied = -1;
    }
  }
</script>

<div class="backdrop" role="presentation">
  <div class="dialog wide" role="dialog" aria-labelledby="example-title">
    <div class="dialog-head">
      <h2 id="example-title">{title}</h2>
      <button
        class="icon-btn"
        type="button"
        use:tip={$tr('common.close')}
        aria-label={$tr('common.close')}
        onclick={onClose}
      >
        <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
          <path d="m3.5 3.5 8 8M11.5 3.5l-8 8" />
        </svg>
      </button>
    </div>
    <div class="stack">
      <p class="note">{$tr('setup.example.hint')}</p>
      {#each snippets as snippet, index (snippet.label)}
        <div class="example-block">
          {#if snippets.length > 1}
            <span class="field-label">{snippet.label}</span>
          {/if}
          <pre class="example-curl">{snippet.text}</pre>
          <button class="btn" type="button" onclick={() => void copy(index, snippet.text)}>
            {$tr(copied === index ? 'common.copied' : 'common.copy')}
          </button>
        </div>
      {/each}
    </div>
  </div>
</div>
