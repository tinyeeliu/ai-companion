<script lang="ts">
  import { untrack } from 'svelte';
  import { regenerateToken, saveSettings } from './api';
  import { t, tr } from './i18n';
  import { tip } from './tooltip';

  /**
   * Set (or regenerate) the API bearer token. Opens from the edit control on
   * the Settings page. Reports the new token back so the page can update its
   * readout without a refetch; `null` means nothing changed.
   */
  let {
    token,
    onClose,
  }: {
    token: string;
    onClose: (result: { token: string; regenerated: boolean } | null) => void;
  } = $props();

  // Seed the draft once: the page can update `token` while this dialog is open.
  let draft = $state(untrack(() => token));
  /** Regenerate is destructive (it invalidates the old token), so it confirms. */
  let confirming = $state(false);
  let error = $state('');
  let busy = $state(false);

  async function save(): Promise<void> {
    const value = draft.trim();
    if (value === '') {
      error = t('settings.tokenRequired');
      return;
    }
    if (value === token) {
      onClose(null);
      return;
    }
    busy = true;
    error = '';
    try {
      const next = await saveSettings(value);
      onClose({ token: next.token, regenerated: false });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      busy = false;
    }
  }

  async function confirmRegenerate(): Promise<void> {
    confirming = false;
    busy = true;
    error = '';
    try {
      const next = await regenerateToken();
      onClose({ token: next.token, regenerated: true });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      busy = false;
    }
  }
</script>

<div class="backdrop" role="presentation">
  <div class="dialog narrow" role="dialog" aria-labelledby="token-title">
    <div class="dialog-head">
      <h2 id="token-title">{$tr('settings.setToken')}</h2>
      <button
        class="icon-btn"
        type="button"
        use:tip={$tr('common.close')}
        aria-label={$tr('common.close')}
        onclick={() => onClose(null)}
      >
        <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
          <path d="m3.5 3.5 8 8M11.5 3.5l-8 8" />
        </svg>
      </button>
    </div>
    <div class="stack">
      <label class="field">
        {$tr('settings.apiToken')}
        <input
          bind:value={draft}
          placeholder={$tr('settings.tokenPlaceholder')}
          oninput={() => (error = '')}
          onkeydown={(event) => {
            if (event.key === 'Enter') void save();
          }}
        />
      </label>
      {#if error}
        <p class="error">{error}</p>
      {/if}
      <div class="row">
        <button class="btn ghost" type="button" disabled={busy} onclick={() => (confirming = true)}>
          {$tr('settings.regenerate')}
        </button>
        <span class="grow"></span>
        <button class="btn ghost" type="button" disabled={busy} onclick={() => onClose(null)}>
          {$tr('common.cancel')}
        </button>
        <button class="btn primary" type="button" disabled={busy} onclick={() => void save()}>
          {$tr('common.save')}
        </button>
      </div>
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
      <h2 id="regen-title">{$tr('settings.regenerate')}</h2>
      <div class="stack">
        <p id="regen-text" class="muted">{$tr('settings.regenerateConfirm')}</p>
        <div class="row end">
          <button class="btn ghost" type="button" onclick={() => (confirming = false)}>
            {$tr('common.cancel')}
          </button>
          <button class="btn danger" type="button" disabled={busy} onclick={() => void confirmRegenerate()}>
            {$tr('settings.regenerate')}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
