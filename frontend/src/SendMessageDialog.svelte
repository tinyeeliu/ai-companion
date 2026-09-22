<script lang="ts">
  import { untrack } from 'svelte';
  import { sendMessage, type Connection } from './api';
  import { t, tr } from './i18n';
  import { tip } from './tooltip';

  let {
    connection,
    initialTo = '',
    context = null,
    onClose,
  }: {
    connection: Connection;
    initialTo?: string;
    /** Original message shown for reference when replying. */
    context?: { summary: string } | null;
    onClose: (sent: boolean) => void;
  } = $props();

  // Seed once so a caller's polling cannot clobber what the user is typing.
  let to = $state(untrack(() => initialTo));
  let text = $state('');
  let note = $state('');
  let error = $state('');
  let busy = $state(false);
  let sent = false;

  async function send(): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    note = '';
    try {
      await sendMessage(connection.id, to, text);
      note = t('detail.sentNote', { to });
      text = '';
      sent = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<div class="backdrop" role="presentation">
  <div class="dialog narrow" role="dialog" aria-labelledby="send-title">
    <div class="dialog-head">
      <h2 id="send-title">{$tr('detail.sendTitle')}</h2>
      <button
        class="icon-btn"
        type="button"
        use:tip={$tr('common.close')}
        aria-label={$tr('common.close')}
        onclick={() => onClose(sent)}
      >
        <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
          <path d="m3.5 3.5 8 8M11.5 3.5l-8 8" />
        </svg>
      </button>
    </div>
    <div class="stack">
      {#if context}
        <p class="note">{$tr('history.replyContext', { summary: context.summary || '—' })}</p>
      {/if}
      <label class="field">
        {connection.channel === 'line' ? $tr('detail.lineUserId') : $tr('detail.phoneNumber')}
        <input
          bind:value={to}
          placeholder={connection.channel === 'line'
            ? $tr('detail.lineUserPlaceholder')
            : $tr('detail.phonePlaceholder')}
        />
      </label>
      <label class="field">
        {$tr('detail.message')}
        <textarea bind:value={text} rows="2" placeholder={$tr('detail.messagePlaceholder')}></textarea>
      </label>
      {#if note}
        <p class="note">{note}</p>
      {/if}
      {#if error}
        <p class="error">{error}</p>
      {/if}
      <div class="row end">
        <button class="btn ghost" type="button" onclick={() => onClose(sent)}>
          {$tr('common.close')}
        </button>
        <button class="btn primary" type="button" disabled={busy} onclick={() => void send()}>
          {$tr('common.send')}
        </button>
      </div>
    </div>
  </div>
</div>
