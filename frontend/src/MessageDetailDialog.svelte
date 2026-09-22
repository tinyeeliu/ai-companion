<script lang="ts">
  import { locale, t, tr as translate } from './i18n';
  import { formatTimestamp, messageTypeLabel } from './status';
  import { tip } from './tooltip';
  import type { ChatMessageDetail } from './api';

  let { message, onClose }: { message: ChatMessageDetail; onClose: () => void } = $props();

  let copied = $state<'in' | 'out' | null>(null);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  function hasJson(value: unknown): boolean {
    return value != null;
  }

  function pretty(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  async function writeClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  async function copy(which: 'in' | 'out', value: unknown): Promise<void> {
    copied = which;
    if (copyTimer != null) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copied = null;
    }, 2000);
    try {
      await writeClipboard(pretty(value));
    } catch {
      // keep the Copied label even if the clipboard API throws
    }
  }
</script>

{#snippet jsonBlock(which: 'in' | 'out', label: string, value: unknown)}
  {@const isCopied = copied === which}
  <div class="json-pane">
    <div class="json-head">
      <strong>{label}</strong>
      <button
        class="icon-btn copy-btn"
        class:is-copied={isCopied}
        type="button"
        aria-label={isCopied ? $translate('common.copied') : $translate('common.copy')}
        use:tip={isCopied ? $translate('common.copied') : $translate('common.copy')}
        onclick={() => void copy(which, value)}
      >
        {#if isCopied}
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3.5 8 6.2 10.7 11.5 4.5" />
          </svg>
          <span class="copy-label" aria-live="polite">{$translate('common.copied')}</span>
        {:else}
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="5" y="5" width="7.5" height="7.5" rx="1.2" />
            <path d="M3.5 10V3.5H10" />
          </svg>
        {/if}
      </button>
    </div>
    <pre class="json-block">{pretty(value)}</pre>
  </div>
{/snippet}

<div class="backdrop" role="presentation">
  <div class="dialog wide" role="dialog" aria-labelledby="msg-title">
    <div class="dialog-head">
      <div>
        <h2 id="msg-title">{$translate('history.detail')}</h2>
        <p class="hint">{formatTimestamp(message.timestamp, $locale)} · {messageTypeLabel(message.type, $translate)}</p>
      </div>
      <button
        class="icon-btn"
        type="button"
        use:tip={$translate('common.close')}
        aria-label={$translate('common.close')}
        onclick={onClose}
      >
        <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
          <path d="m3.5 3.5 8 8M11.5 3.5l-8 8" />
        </svg>
      </button>
    </div>
    <div class="stack">
      {#if hasJson(message.rawIn)}
        {@render jsonBlock('in', $translate('history.rawIn'), message.rawIn)}
      {/if}
      {#if hasJson(message.rawOut)}
        {@render jsonBlock('out', $translate('history.rawOut'), message.rawOut)}
      {/if}
      <div class="row end">
        <button class="btn" type="button" onclick={onClose}>{t('common.close')}</button>
      </div>
    </div>
  </div>
</div>
