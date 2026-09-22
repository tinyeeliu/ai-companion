<script lang="ts">
  import { untrack } from 'svelte';
  import { renameConnection, type Connection } from './api';
  import { t, tr } from './i18n';
  import { tip } from './tooltip';

  let { connection, onClose }: { connection: Connection; onClose: (changed: boolean) => void } = $props();

  // Seed the draft once: polling refreshes `connection` while this dialog is open,
  // and we must not clobber what the user is typing.
  let nameDraft = $state(untrack(() => connection.name));
  let error = $state('');
  let busy = $state(false);

  async function save(): Promise<void> {
    const nextName = nameDraft.trim();
    if (nextName === '') {
      error = t('detail.nameRequired');
      return;
    }
    if (nextName === connection.name) {
      onClose(false);
      return;
    }
    busy = true;
    error = '';
    try {
      await renameConnection(connection.id, nextName);
      onClose(true);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      busy = false;
    }
  }
</script>

<div class="backdrop" role="presentation">
  <div class="dialog narrow" role="dialog" aria-labelledby="rename-title">
    <div class="dialog-head">
      <h2 id="rename-title">{$tr('detail.renameTitle')}</h2>
      <button
        class="icon-btn"
        type="button"
        use:tip={$tr('common.close')}
        aria-label={$tr('common.close')}
        onclick={() => onClose(false)}
      >
        <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
          <path d="m3.5 3.5 8 8M11.5 3.5l-8 8" />
        </svg>
      </button>
    </div>
    <div class="stack">
      <label class="field">
        {$tr('table.name')}
        <input
          bind:value={nameDraft}
          maxlength="64"
          oninput={() => (error = '')}
          onkeydown={(event) => {
            if (event.key === 'Enter') void save();
          }}
        />
      </label>
      {#if error}
        <p class="error">{error}</p>
      {/if}
      <div class="row end">
        <button class="btn ghost" type="button" disabled={busy} onclick={() => onClose(false)}>
          {$tr('common.cancel')}
        </button>
        <button class="btn primary" type="button" disabled={busy} onclick={() => void save()}>
          {$tr('common.save')}
        </button>
      </div>
    </div>
  </div>
</div>
