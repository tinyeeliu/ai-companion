<script lang="ts">
  import { onMount } from 'svelte';
  import { getSettings, regenerateToken, saveSettings } from './api';
  import { t, tr as translate } from './i18n';
  import { tip } from './tooltip';

  /**
   * Settings page. For now it owns one thing: the API bearer token. Callers on
   * this machine need no token; anything reaching the sidecar over the network
   * must send this value as `Authorization: Bearer <token>`.
   */
  let token = $state('');
  let draft = $state('');
  let draftDirty = $state(false);
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let confirming = $state(false);
  let note = $state('');
  let error = $state('');
  let busy = $state(false);

  const unsaved = $derived(draftDirty && draft.trim() !== '' && draft.trim() !== token);

  async function load(): Promise<void> {
    const settings = await getSettings();
    token = settings.token;
    if (!draftDirty) draft = settings.token;
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

  async function save(): Promise<void> {
    const value = draft.trim();
    if (value === '') {
      error = t('settings.tokenRequired');
      return;
    }
    busy = true;
    error = '';
    note = '';
    try {
      const next = await saveSettings(value);
      token = next.token;
      draft = next.token;
      draftDirty = false;
      note = t('settings.saved');
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function confirmRegenerate(): Promise<void> {
    confirming = false;
    busy = true;
    error = '';
    note = '';
    try {
      const next = await regenerateToken();
      token = next.token;
      draft = next.token;
      draftDirty = false;
      note = t('settings.regenerated');
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<div class="page-body">
  <div class="settings-card">
    <div class="stack">
      <div class="field-head">
        <span class="field-label">{$translate('settings.apiToken')}</span>
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
      </div>
      <input class="token-readout" value={token} readonly aria-label={$translate('settings.apiToken')} />
      <p class="note">{$translate('settings.tokenHint')}</p>
      <p class="note">{$translate('settings.localNote')}</p>
    </div>
  </div>

  <div class="settings-card">
    <div class="stack">
      <label class="field">
        {$translate('settings.setToken')}
        <input
          bind:value={draft}
          placeholder={$translate('settings.tokenPlaceholder')}
          oninput={() => (draftDirty = true)}
        />
      </label>
      <div class="row">
        <button class="btn" class:dirty={unsaved} type="button" disabled={busy} onclick={() => void save()}>
          {$translate('common.save')}
        </button>
        <button class="btn ghost" type="button" disabled={busy} onclick={() => (confirming = true)}>
          {$translate('settings.regenerate')}
        </button>
      </div>
      {#if note}
        <p class="note">{note}</p>
      {/if}
      {#if error}
        <p class="error">{error}</p>
      {/if}
    </div>
  </div>
</div>

{#if confirming}
  <div class="backdrop" role="presentation">
    <div
      class="dialog narrow"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="regen-title"
      aria-describedby="regen-text"
    >
      <h2 id="regen-title">{$translate('settings.regenerate')}</h2>
      <div class="stack">
        <p id="regen-text" class="muted">{$translate('settings.regenerateConfirm')}</p>
        <div class="row end">
          <button class="btn ghost" type="button" onclick={() => (confirming = false)}>
            {$translate('common.cancel')}
          </button>
          <button class="btn danger" type="button" disabled={busy} onclick={() => void confirmRegenerate()}>
            {$translate('settings.regenerate')}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
