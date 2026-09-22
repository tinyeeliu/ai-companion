<script lang="ts">
  import { onDestroy } from 'svelte';
  import { toDataURL } from 'qrcode';
  import {
    createConnection,
    deleteConnection,
    getConnection,
    getQr,
    type Channel,
    type Connection,
  } from './api';
  import { tr } from './i18n';

  let { onClose }: { onClose: (changed: boolean) => void } = $props();

  let channel = $state<Channel>('whatsapp');
  let started = $state(false);
  let connection = $state<Connection | null>(null);
  let qrDataUrl = $state<string | null>(null);
  let pin = $state<string | null>(null);
  let error = $state('');
  let creating = $state(false);
  let timer: ReturnType<typeof setInterval> | undefined;
  let changed = false;
  let closed = false;

  const isLine = $derived(channel === 'line');

  function finish(didChange: boolean): void {
    if (closed) return;
    closed = true;
    if (timer != null) {
      clearInterval(timer);
      timer = undefined;
    }
    onClose(didChange);
  }

  async function refreshQr(): Promise<void> {
    if (connection == null || closed) return;
    const { connection: next } = await getConnection(connection.id);
    connection = next;
    if (next.status === 'connected') {
      qrDataUrl = null;
      pin = null;
      finish(true);
      return;
    }
    const pair = await getQr(next.id);
    pin = pair.pin;
    qrDataUrl = pair.qr != null && pair.qr !== '' ? await toDataURL(pair.qr, { width: 220, margin: 1 }) : null;
  }

  async function start(): Promise<void> {
    creating = true;
    error = '';
    started = true;
    try {
      const created = await createConnection({ channel });
      connection = created.connection;
      changed = true;
      creating = false;
      await refreshQr();
      if (closed) return;
      timer = setInterval(() => {
        void refreshQr().catch((err: unknown) => {
          error = err instanceof Error ? err.message : String(err);
        });
      }, 2000);
    } catch (err) {
      creating = false;
      error = err instanceof Error ? err.message : String(err);
    }
  }

  onDestroy(() => {
    if (timer != null) clearInterval(timer);
  });

  async function cancel(): Promise<void> {
    if (connection != null && connection.status !== 'connected') {
      try {
        await deleteConnection(connection.id);
        changed = true;
      } catch {
        /* keep closing */
      }
    }
    finish(changed);
  }
</script>

<div class="backdrop" role="presentation">
  <div class="dialog narrow" role="dialog" aria-labelledby="link-title">
    <div class="dialog-head">
      <h2 id="link-title">{$tr('link.title')}</h2>
    </div>
    <div class="stack">
      {#if !started}
        <p class="muted">{$tr('link.pickHint')}</p>
        <div class="choice">
          <button
            class="btn"
            class:primary={channel === 'whatsapp'}
            type="button"
            onclick={() => (channel = 'whatsapp')}
          >
            {$tr('channel.whatsapp')}
          </button>
          <button
            class="btn"
            class:primary={channel === 'line'}
            type="button"
            onclick={() => (channel = 'line')}
          >
            {$tr('channel.line')}
          </button>
        </div>
        {#if error}
          <p class="error">{error}</p>
        {/if}
        <div class="row end">
          <button class="btn ghost" type="button" onclick={() => void cancel()}>
            {$tr('link.cancel')}
          </button>
          <button class="btn primary" type="button" onclick={() => void start()}>
            {$tr('link.continue')}
          </button>
        </div>
      {:else}
        <p class="muted">{isLine ? $tr('link.stepsLine') : $tr('link.steps')}</p>
        <div class="row center">
          {#if qrDataUrl}
            <img class="qr" src={qrDataUrl} alt={isLine ? $tr('link.qrAltLine') : $tr('link.qrAlt')} />
          {:else}
            <div class="qr-slot">
              {creating ? $tr('link.gettingCode') : $tr('link.waitingCode')}
            </div>
          {/if}
        </div>
        {#if isLine && connection?.status !== 'connected'}
          <p class="note">{$tr('link.pinLabel')}</p>
          <div class="pin-code">{pin != null && pin !== '' ? pin : $tr('link.pinWait')}</div>
        {/if}
        <p class="note">{isLine ? $tr('link.keepOpenLine') : $tr('link.keepOpen')}</p>
        {#if error}
          <p class="error">{error}</p>
        {/if}
        <div class="row end">
          <button class="btn ghost" type="button" onclick={() => void cancel()}>
            {$tr('link.cancel')}
          </button>
        </div>
      {/if}
    </div>
  </div>
</div>
