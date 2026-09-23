<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { toDataURL } from 'qrcode';
  import {
    deleteConnection,
    disableConnection,
    enableConnection,
    getConnection,
    getQr,
    saveWebhook,
    saveCloud,
    type Connection,
  } from './api';
import { t, tr } from './i18n';
import { accountLabel, cloudLabel, cloudTone, isLinked, isPaused, isWaiting, statusLabel } from './status';
import { cloudSaveEnabled } from './cloudLink';
import { tip } from './tooltip';

  let { id, onClose }: { id: string; onClose: (changed: boolean) => void } = $props();

  let connection = $state<Connection | null>(null);
  let qrDataUrl = $state<string | null>(null);
  let webhook = $state('');
  let webhookToken = $state('');
  let webhookDirty = $state(false);
  let cloudUrl = $state('');
  let cloudToken = $state('');
  let cloudDirty = $state(false);
  /**
   * Accordion state: the dialog reads as a short list of choices, so opening
   * one section closes the others (see `openOnly`). Unlink lives outside the
   * sections and shows only while every one of them is collapsed.
   */
  let pauseOpen = $state(false);
  let forwardOpen = $state(false);
  let cloudOpen = $state(false);
  let note = $state('');
  let error = $state('');
  let busy = $state(false);
  /** Unlink confirmation overlay — see `askUnlink`. */
  let confirming = $state(false);
  let confirmText = $state('');
  let timer: ReturnType<typeof setInterval> | undefined;
  let changed = false;

  /** Keep at most one section expanded: opening one collapses the rest. */
  function openOnly(section: 'pause' | 'forward' | 'cloud', event: Event): void {
    if (!(event.currentTarget instanceof HTMLDetailsElement) || !event.currentTarget.open) return;
    if (section !== 'pause') pauseOpen = false;
    if (section !== 'forward') forwardOpen = false;
    if (section !== 'cloud') cloudOpen = false;
  }

  /** Unlink is offered only when the dialog is back to its collapsed overview. */
  const noSectionOpen = $derived(!pauseOpen && !forwardOpen && !cloudOpen);

  // The QR branch unmounts the settings sections; drop their flags so a stale
  // `open` cannot keep Unlink hidden after they are gone.
  $effect(() => {
    if (!showConnectionSettings) {
      forwardOpen = false;
      cloudOpen = false;
    }
  });

  /**
   * Settings belong to a phone that is already paired; scanning is only for one
   * that is not. `POST /enable` returns in milliseconds with status `connecting`
   * and the session only reports `connected` seconds later, so gating on the
   * status alone flipped the panel to the scan prompt for ~3s on every resume.
   * A paired phone mid-reconnect is still paired.
   */
  const showConnectionSettings = $derived(
    connection != null &&
      (isLinked(connection.status) ||
        isPaused(connection.status) ||
        (connection.phone != null && isWaiting(connection.status))),
  );

  /**
   * `…Dirty` marks a field as mid-edit so the 2s poll cannot overwrite it.
   * `…Unsaved` is a different question — does the draft differ from what is
   * stored? — and drives the Save highlight. Comparing the saved values means
   * typing a change and undoing it clears the highlight again.
   */
  const webhookUnsaved = $derived.by(() => {
    if (connection == null) return false;
    const url = webhook.trim() === '' ? null : webhook.trim();
    if (url !== connection.webhookUrl) return true;
    // Save ignores the token once the url is cleared, so neither should this.
    if (url == null) return false;
    const token = webhookToken.trim() === '' ? null : webhookToken.trim();
    return token !== connection.webhookToken;
  });

  /**
   * A live link owns its fields: what is on screen is what the server saved, so
   * editing is locked and Save would only offer to overwrite a working link.
   */
  const cloudConnected = $derived(connection?.cloudStatus === 'connected');

  const cloudUnsaved = $derived.by(() => {
    if (connection == null) return false;
    const url = cloudUrl.trim() === '' ? null : cloudUrl.trim();
    if (url !== connection.cloudUrl) return true;
    if (url == null) return false;
    const token = cloudToken.trim() === '' ? null : cloudToken.trim();
    return token !== connection.cloudToken;
  });

  /**
   * Save and Connect is offered only when the request would actually connect:
   * a dialable ws(s) URL *and* a token. The one other submittable state is
   * clearing both fields while a link is configured — that is how the link is
   * turned off. Everything else (half-filled, wrong scheme) stays disabled.
   * Rules live in `cloudLink.ts` so they are testable without the dialog.
   */
  const cloudCanSave = $derived(cloudSaveEnabled(cloudUrl, cloudToken, connection?.cloudUrl));

  async function load(): Promise<void> {
    const { connection: next } = await getConnection(id);
    connection = next;
    if (!webhookDirty) {
      webhook = next.webhookUrl ?? '';
      webhookToken = next.webhookToken ?? '';
    }
    // Once the link is live, refresh even a mid-edit draft: the poll is the
    // only thing that would ever clear it, and a frozen draft in read-only
    // fields can no longer be saved anyway.
    if (!cloudDirty || next.cloudStatus === 'connected') {
      cloudUrl = next.cloudUrl ?? '';
      cloudToken = next.cloudToken ?? '';
      if (next.cloudStatus === 'connected') cloudDirty = false;
    }
    if (isWaiting(next.status) || next.status === 'disconnected' || next.status === 'error') {
      const pair = await getQr(next.id);
      qrDataUrl = pair.qr != null && pair.qr !== '' ? await toDataURL(pair.qr, { width: 220, margin: 1 }) : null;
    } else {
      qrDataUrl = null;
    }
  }

  onMount(() => {
    void load().catch((err: unknown) => {
      error = err instanceof Error ? err.message : String(err);
    });
    timer = setInterval(() => {
      void load().catch((err: unknown) => {
        error = err instanceof Error ? err.message : String(err);
      });
    }, 2000);
  });

  onDestroy(() => {
    if (timer != null) clearInterval(timer);
  });

  async function togglePause(): Promise<void> {
    if (connection == null) return;
    busy = true;
    error = '';
    try {
      const next = connection.enabled
        ? await disableConnection(connection.id)
        : await enableConnection(connection.id);
      connection = next.connection;
      changed = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function saveHook(): Promise<void> {
    if (connection == null) return;
    busy = true;
    error = '';
    try {
      const url = webhook.trim() === '' ? null : webhook.trim();
      const next = await saveWebhook(connection.id, url, url == null ? null : webhookToken.trim());
      connection = next.connection;
      webhook = next.connection.webhookUrl ?? '';
      webhookToken = next.connection.webhookToken ?? '';
      webhookDirty = false;
      note = url == null ? t('detail.forwardOff') : t('detail.forwardSaved');
      changed = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function saveCloudLink(): Promise<void> {
    if (connection == null || !cloudCanSave) return;
    busy = true;
    error = '';
    try {
      const url = cloudUrl.trim() === '' ? null : cloudUrl.trim();
      const next = await saveCloud(connection.id, url, url == null ? null : cloudToken.trim());
      connection = next.connection;
      cloudUrl = next.connection.cloudUrl ?? '';
      cloudToken = next.connection.cloudToken ?? '';
      cloudDirty = false;
      note = url == null ? t('detail.cloudOff') : t('detail.cloudSaved');
      changed = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  /**
   * Unlink is destructive, so it confirms first. The confirmation is in-app on
   * purpose: `window.confirm` is swallowed silently by sandboxed previews (no
   * `allow-modals`) and by some webviews, so the click appeared to do nothing.
   */
  function askUnlink(): void {
    if (connection == null) return;
    confirmText = t(connection.channel === 'line' ? 'detail.unlinkConfirmLine' : 'detail.unlinkConfirm', {
      name: connection.name,
    });
    confirming = true;
  }

  async function confirmUnlink(): Promise<void> {
    if (connection == null) return;
    confirming = false;
    busy = true;
    error = '';
    try {
      await deleteConnection(connection.id);
      onClose(true);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      busy = false;
    }
  }
</script>

{#snippet chevron()}
  <span class="chev" aria-hidden="true">
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
      <path
        d="M4.5 2.5 8 6l-3.5 3.5"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </span>
{/snippet}

<div class="backdrop" role="presentation">
  <div class="dialog" role="dialog" aria-labelledby="edit-title">
    <div class="dialog-head">
      <div>
        <h2 id="edit-title">{connection?.name ?? ''}</h2>
        <p class="hint">
          {#if connection?.user}
            {connection.user} ·
          {/if}
          {accountLabel(connection?.phone, $tr)} · {statusLabel(connection?.status ?? '', $tr)}
          {#if (connection?.disconnectCount ?? 0) > 0}
            · {$tr('status.disconnects24h', { count: connection?.disconnectCount ?? 0 })}
          {/if}
        </p>
      </div>
      <button
        class="icon-btn"
        type="button"
        use:tip={$tr('common.close')}
        aria-label={$tr('common.close')}
        onclick={() => onClose(changed)}
      >
        <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
          <path d="m3.5 3.5 8 8M11.5 3.5l-8 8" />
        </svg>
      </button>
    </div>

    {#if connection}
      <div class="stack">
        <details class="section" bind:open={pauseOpen} ontoggle={(event) => openOnly('pause', event)}>
          <summary class="section-head">
            <span class="section-title">{$tr('detail.pause')}</span>
            <span class="grow"></span>
            <button
              class="toggle"
              class:on={!connection.enabled}
              type="button"
              role="switch"
              aria-label={$tr('detail.pause')}
              aria-checked={!connection.enabled}
              disabled={busy}
              onclick={(event) => {
                // Keep the switch from also opening the section.
                event.preventDefault();
                event.stopPropagation();
                void togglePause();
              }}
            >
              <span></span>
            </button>
            {@render chevron()}
          </summary>
          <div class="section-body">
            {#if isPaused(connection.status)}
              <p>{$tr('detail.resumeHint')}</p>
            {:else}
              <p class="note">{$tr('detail.pauseHint')}</p>
            {/if}
          </div>
        </details>

        {#if showConnectionSettings}
          <details class="section" bind:open={forwardOpen} ontoggle={(event) => openOnly('forward', event)}>
            <summary class="section-head">
              <span class="section-title">{$tr('detail.forwardTitle')}</span>
              <span class="grow"></span>
              <span class="chip">{connection.webhookUrl ? $tr('detail.on') : $tr('detail.off')}</span>
              {@render chevron()}
            </summary>
            <div class="section-body">
              <p class="note">{$tr('detail.forwardHint')}</p>
              <label class="field">
                {$tr('detail.url')}
                <input
                  bind:value={webhook}
                  placeholder="https://…"
                  type="url"
                  oninput={() => (webhookDirty = true)}
                />
              </label>
              <label class="field">
                {$tr('detail.forwardToken')}
                <input
                  bind:value={webhookToken}
                  placeholder={$tr('detail.forwardTokenPlaceholder')}
                  oninput={() => (webhookDirty = true)}
                />
              </label>
              <div class="row">
                <button
                  class="btn"
                  class:dirty={webhookUnsaved}
                  type="button"
                  disabled={busy}
                  onclick={() => void saveHook()}
                >
                  {$tr('common.save')}
                </button>
              </div>
            </div>
          </details>

        <details class="section" bind:open={cloudOpen} ontoggle={(event) => openOnly('cloud', event)}>
          <summary class="section-head">
            <span class="section-title">{$tr('detail.cloudTitle')}</span>
              <span class="grow"></span>
              {#if connection.cloudUrl}
                {@const cloud = cloudTone(connection.cloudStatus)}
                <span class="chip tone-{cloud}" use:tip={connection.cloudError ?? $tr('table.cloudHint')}>
                  {cloudLabel(connection.cloudStatus, $tr)}
                </span>
              {:else}
                <span class="chip">{$tr('detail.off')}</span>
              {/if}
              {@render chevron()}
            </summary>
            <div class="section-body">
              <p class="note">{$tr('detail.cloudHint')}</p>
              {#if connection.cloudError}
                <p class="error">{connection.cloudError}</p>
              {/if}
              <label class="field">
                {$tr('detail.cloudUrl')}
                <input
                  bind:value={cloudUrl}
                  placeholder="wss://…"
                  readonly={cloudConnected}
                  oninput={() => (cloudDirty = true)}
                />
              </label>
              <label class="field">
                {$tr('detail.cloudToken')}
                <input
                  bind:value={cloudToken}
                  placeholder={$tr('detail.cloudTokenPlaceholder')}
                  readonly={cloudConnected}
                  oninput={() => (cloudDirty = true)}
                />
              </label>
              <!-- Learned from the server's hello, never entered here: read-only
                   so a typo can never break uploads. Showing "not offered" means
                   media travels inline in the frame. -->
              <label class="field">
                {$tr('detail.uploadUrl')}
                <input value={connection.uploadUrl ?? $tr('detail.uploadUrlNone')} readonly />
              </label>
              <p class="note">{$tr('detail.uploadUrlHint')}</p>
              {#if !cloudConnected}
                <div class="row">
                  <button
                    class="btn"
                    class:dirty={cloudUnsaved && cloudCanSave}
                    type="button"
                    disabled={busy || !cloudCanSave}
                    onclick={() => void saveCloudLink()}
                  >
                    {$tr('detail.cloudSave')}
                  </button>
                </div>
                {#if !cloudCanSave}
                  <p class="note">{$tr('detail.cloudSaveHint')}</p>
                {/if}
              {/if}
            </div>
          </details>
        {:else if !busy}
          <div class="section-body standalone">
            <p>{connection.channel === 'line' ? $tr('detail.scanHintLine') : $tr('detail.scanHint')}</p>
            <div class="row center">
              {#if qrDataUrl}
                <img
                  class="qr"
                  src={qrDataUrl}
                  alt={connection.channel === 'line' ? $tr('link.qrAltLine') : $tr('link.qrAlt')}
                />
              {:else}
                <div class="qr-slot">{$tr('link.waitingCode')}</div>
              {/if}
            </div>
            {#if connection.channel === 'line'}
              <p class="note">{$tr('link.pinLabel')}</p>
              <div class="pin-code">
                {connection.pin != null && connection.pin !== '' ? connection.pin : $tr('link.pinWait')}
              </div>
            {/if}
          </div>
        {/if}

        <!-- Unlink stays out of the way while a section is being edited: it
             shows only when no accordion is expanded. -->
        {#if noSectionOpen}
          <hr class="rule" />
          <div class="row end">
            <button class="btn ghost" type="button" disabled={busy} onclick={() => askUnlink()}>
              {$tr('common.unlink')}
            </button>
          </div>
        {/if}

        {#if note}
          <p class="note">{note}</p>
        {/if}
        {#if error}
          <p class="error">{error}</p>
        {/if}
      </div>
    {:else if error}
      <p class="error">{error}</p>
    {:else}
      <p class="note">{$tr('common.loading')}</p>
    {/if}
  </div>
</div>

{#if confirming}
  <div class="backdrop" role="presentation">
    <div
      class="dialog narrow"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="unlink-title"
      aria-describedby="unlink-text"
    >
      <h2 id="unlink-title">{$tr('common.unlink')}</h2>
      <div class="stack">
        <p id="unlink-text" class="muted">{confirmText}</p>
        <div class="row end">
          <button class="btn ghost" type="button" onclick={() => (confirming = false)}>
            {$tr('common.cancel')}
          </button>
          <button class="btn danger" type="button" disabled={busy} onclick={() => void confirmUnlink()}>
            {$tr('common.unlink')}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
