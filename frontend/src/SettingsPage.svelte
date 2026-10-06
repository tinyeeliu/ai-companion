<script lang="ts">
  import { onMount } from 'svelte';
  import { getSettings } from './api';
  import TokenDialog from './TokenDialog.svelte';
  import { t, tr as translate } from './i18n';
  import { tip } from './tooltip';

  /**
   * Settings page. For now it owns one thing: the API bearer token. Callers on
   * this machine need no token; anything reaching the sidecar over the network
   * must send this value as `Authorization: Bearer <token>`.
   */
  let token = $state('');
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let editing = $state(false);
  let note = $state('');
  let error = $state('');

  async function load(): Promise<void> {
    const settings = await getSettings();
    token = settings.token;
  }

  onMount(() => {
    void load().catch((err: unknown) => {
      error = err instanceof Error ? err.message : String(err);
    });
  });

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

  async function copyToken(): Promise<void> {
    copied = true;
    if (copyTimer != null) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copied = false;
    }, 2000);
    try {
      await writeClipboard(token);
    } catch {
      // keep the Copied label even if the clipboard API throws
    }
  }

  /** The dialog reports the stored value back, so no refetch is needed. */
  function onDialogClose(result: { token: string; regenerated: boolean } | null): void {
    editing = false;
    if (result == null) return;
    token = result.token;
    note = t(result.regenerated ? 'settings.regenerated' : 'settings.saved');
  }
</script>

<div class="page-body">
  <div class="settings-card">
    <div class="stack">
      <div class="field-head">
        <span class="field-label">{$translate('settings.apiToken')}</span>
        <span class="field-actions">
          <button
            class="icon-btn"
            type="button"
            aria-label={$translate('settings.setToken')}
            use:tip={$translate('settings.setToken')}
            onclick={() => {
              note = '';
              editing = true;
            }}
          >
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m9.9 2.1 3 3L5 13H2v-3z" />
              <path d="m8.3 3.7 3 3" />
            </svg>
          </button>
          <button
            class="icon-btn copy-btn"
            class:is-copied={copied}
            type="button"
            aria-label={copied ? $translate('common.copied') : $translate('common.copy')}
            use:tip={copied ? $translate('common.copied') : $translate('common.copy')}
            onclick={() => void copyToken()}
          >
            {#if copied}
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3.5 8 6.2 10.7 11.5 4.5" />
              </svg>
              <span class="copy-label" aria-live="polite">{$translate('common.copied')}</span>
            {:else}
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="5" y="5" width="7.5" height="7.5" rx="1.2" />
                <path d="M3.5 10V3.5H10" />
              </svg>
              <span class="copy-label">{$translate('common.copy')}</span>
            {/if}
          </button>
        </span>
      </div>
      <input class="token-readout" value={token} readonly aria-label={$translate('settings.apiToken')} />
      <p class="note">{$translate('settings.tokenHint')}</p>
      <p class="note">{$translate('settings.localNote')}</p>
      {#if note}
        <p class="note">{note}</p>
      {/if}
      {#if error}
        <p class="error">{error}</p>
      {/if}
    </div>
  </div>
</div>

{#if editing}
  <TokenDialog {token} onClose={onDialogClose} />
{/if}
