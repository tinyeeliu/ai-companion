<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { downloadTts, getSetup, setTtsEnabled, testSpeech, type SetupFeature } from './api';
  import { t, tr as translate } from './i18n';

  /**
   * Setup is a list of local features. Speech is the first card: download the
   * model, turn it on, then play a short sample through the speech endpoint.
   */
  let feature = $state<SetupFeature | null>(null);
  let error = $state('');
  let note = $state('');
  let testing = $state(false);
  let audioUrl = '';
  let timer: ReturnType<typeof setInterval> | undefined;

  function apply(next: SetupFeature): void {
    feature = next;
    if (next.error != null && next.error !== '') error = next.error;
    if (next.downloading) startPolling();
    else stopPolling();
  }

  async function load(): Promise<void> {
    const body = await getSetup();
    const tts = body.features.find((item) => item.id === 'tts');
    if (tts != null) apply(tts);
  }

  function startPolling(): void {
    if (timer != null) return;
    timer = setInterval(() => {
      void load().catch((err: unknown) => {
        error = err instanceof Error ? err.message : String(err);
      });
    }, 500);
  }

  function stopPolling(): void {
    if (timer == null) return;
    clearInterval(timer);
    timer = undefined;
  }

  onMount(() => {
    void load().catch((err: unknown) => {
      error = err instanceof Error ? err.message : String(err);
    });
  });

  onDestroy(() => {
    stopPolling();
    if (audioUrl !== '') URL.revokeObjectURL(audioUrl);
  });

  async function download(): Promise<void> {
    error = '';
    note = '';
    try {
      apply(await downloadTts());
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function setEnabled(enabled: boolean): Promise<void> {
    error = '';
    note = '';
    try {
      apply(await setTtsEnabled(enabled));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function test(): Promise<void> {
    error = '';
    note = '';
    testing = true;
    const started = performance.now();
    try {
      const blob = await testSpeech();
      const delayMs = Math.round(performance.now() - started);
      if (audioUrl !== '') URL.revokeObjectURL(audioUrl);
      audioUrl = URL.createObjectURL(blob);
      await new Audio(audioUrl).play();
      note = t('setup.tts.testOk', { ms: delayMs });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      testing = false;
    }
  }

  function statusLabel(item: SetupFeature): string {
    if (item.downloading) return t('setup.tts.downloading');
    if (!item.downloaded) return t('setup.tts.missing');
    return t(item.enabled ? 'setup.tts.on' : 'setup.tts.off');
  }

  function bytes(value: number): string {
    if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
    return `${(value / (1024 * 1024)).toFixed(0)} MB`;
  }
</script>

<div class="page-body">
  {#if feature}
    <section class="settings-card">
      <h2 class="setup-title">{$translate('setup.tts.title')}</h2>
      <p class="note">{$translate('setup.tts.hint')}</p>
      <p class="setup-status" class:is-on={feature.enabled}>{statusLabel(feature)}</p>
      {#if feature.downloading && feature.total > 0}
        <p class="note">
          {$translate('setup.tts.progress', { received: bytes(feature.received), total: bytes(feature.total) })}
        </p>
        <div class="setup-bar" aria-hidden="true">
          <span style:width={`${Math.min(100, Math.round((feature.received / feature.total) * 100))}%`}></span>
        </div>
      {/if}
      <div class="setup-actions">
        {#if !feature.downloaded}
          <button class="btn primary" type="button" disabled={feature.downloading} onclick={() => void download()}>
            {$translate('setup.tts.download')}
          </button>
        {:else if feature.enabled}
          <button class="btn" type="button" onclick={() => void setEnabled(false)}>
            {$translate('setup.tts.disable')}
          </button>
        {:else}
          <button class="btn primary" type="button" onclick={() => void setEnabled(true)}>
            {$translate('setup.tts.enable')}
          </button>
        {/if}
        <button class="btn" type="button" disabled={!feature.enabled || testing} onclick={() => void test()}>
          {$translate(testing ? 'setup.tts.testing' : 'setup.tts.test')}
        </button>
      </div>
      {#if note}
        <p class="note">{note}</p>
      {/if}
      {#if error}
        <p class="error">{error}</p>
      {/if}
    </section>
  {:else if error}
    <p class="error">{error}</p>
  {/if}
</div>
