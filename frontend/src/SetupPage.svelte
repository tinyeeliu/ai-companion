<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    downloadDecision,
    downloadTts,
    getSetup,
    setDecisionEnabled,
    setTtsEnabled,
    setTtsModel,
    testDecision,
    testSpeech,
    testSpeechText,
    type DecisionSetupFeature,
    type TtsSetupFeature,
  } from './api';
  import { t, tr as translate } from './i18n';

  /**
   * Setup is a list of local features. Speech is the first card. Decision is
   * the second: download the model, turn it on, then ask one short question.
   */
  let speech = $state<TtsSetupFeature | null>(null);
  let decision = $state<DecisionSetupFeature | null>(null);
  let loadError = $state('');
  let speechError = $state('');
  let decisionError = $state('');
  let speechNote = $state('');
  let decisionNote = $state('');
  let spoken = $state('');
  let chosen = $state('');
  let testingSpeech = $state(false);
  let testingDecision = $state(false);
  let audioUrl = '';
  let timer: ReturnType<typeof setInterval> | undefined;

  function applySpeech(next: TtsSetupFeature): void {
    speech = next;
    if (next.error != null && next.error !== '') speechError = next.error;
    syncPolling();
  }

  function applyDecision(next: DecisionSetupFeature): void {
    decision = next;
    if (next.error != null && next.error !== '') decisionError = next.error;
    syncPolling();
  }

  async function load(): Promise<void> {
    const body = await getSetup();
    const tts = body.features.find((item): item is TtsSetupFeature => item.id === 'tts');
    const next = body.features.find((item): item is DecisionSetupFeature => item.id === 'decision');
    if (tts != null) applySpeech(tts);
    if (next != null) applyDecision(next);
  }

  function syncPolling(): void {
    if (speech?.downloading || decision?.downloading) startPolling();
    else stopPolling();
  }

  function startPolling(): void {
    if (timer != null) return;
    timer = setInterval(() => {
      void load().catch((err: unknown) => {
        loadError = err instanceof Error ? err.message : String(err);
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
      loadError = err instanceof Error ? err.message : String(err);
    });
  });

  onDestroy(() => {
    stopPolling();
    if (audioUrl !== '') URL.revokeObjectURL(audioUrl);
  });

  async function choose(model: string): Promise<void> {
    if (model !== 'en' && model !== 'zh') return;
    speechError = '';
    speechNote = '';
    spoken = '';
    try {
      applySpeech(await setTtsModel(model));
    } catch (err) {
      speechError = err instanceof Error ? err.message : String(err);
    }
  }

  async function downloadSpeech(): Promise<void> {
    speechError = '';
    speechNote = '';
    spoken = '';
    try {
      applySpeech(await downloadTts());
    } catch (err) {
      speechError = err instanceof Error ? err.message : String(err);
    }
  }

  async function setSpeechEnabled(enabled: boolean): Promise<void> {
    speechError = '';
    speechNote = '';
    spoken = '';
    try {
      applySpeech(await setTtsEnabled(enabled));
    } catch (err) {
      speechError = err instanceof Error ? err.message : String(err);
    }
  }

  async function testSpeechSample(): Promise<void> {
    speechError = '';
    speechNote = '';
    spoken = '';
    testingSpeech = true;
    const text = testSpeechText(speech?.model ?? null);
    const started = performance.now();
    try {
      const blob = await testSpeech(speech?.model ?? null);
      const delayMs = Math.round(performance.now() - started);
      if (audioUrl !== '') URL.revokeObjectURL(audioUrl);
      audioUrl = URL.createObjectURL(blob);
      await new Audio(audioUrl).play();
      spoken = text;
      speechNote = t('setup.tts.testOk', { ms: delayMs });
    } catch (err) {
      speechError = err instanceof Error ? err.message : String(err);
    } finally {
      testingSpeech = false;
    }
  }

  async function downloadDecisionModel(): Promise<void> {
    decisionError = '';
    decisionNote = '';
    chosen = '';
    try {
      applyDecision(await downloadDecision());
    } catch (err) {
      decisionError = err instanceof Error ? err.message : String(err);
    }
  }

  async function setDecision(enabled: boolean): Promise<void> {
    decisionError = '';
    decisionNote = '';
    chosen = '';
    try {
      applyDecision(await setDecisionEnabled(enabled));
    } catch (err) {
      decisionError = err instanceof Error ? err.message : String(err);
    }
  }

  async function testDecisionSample(): Promise<void> {
    decisionError = '';
    decisionNote = '';
    chosen = '';
    testingDecision = true;
    const started = performance.now();
    try {
      const body = await testDecision();
      const delayMs = Math.round(performance.now() - started);
      const answer = body.answers.team?.choice ?? '';
      chosen = answer;
      decisionNote = t('setup.decision.testOk', { answer, ms: delayMs });
    } catch (err) {
      decisionError = err instanceof Error ? err.message : String(err);
    } finally {
      testingDecision = false;
    }
  }

  function speechStatus(item: TtsSetupFeature): string {
    if (item.downloading) return t('setup.tts.downloading');
    if (!item.downloaded) return t('setup.tts.missing');
    return t(item.enabled ? 'setup.tts.on' : 'setup.tts.off');
  }

  function decisionStatus(item: DecisionSetupFeature): string {
    if (item.models.length === 0) return t('setup.decision.unavailable');
    if (item.downloading) return t('setup.decision.downloading');
    if (!item.downloaded) return t('setup.decision.missing');
    return t(item.enabled ? 'setup.decision.on' : 'setup.decision.off');
  }

  function bytes(value: number): string {
    if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
    return `${(value / (1024 * 1024)).toFixed(0)} MB`;
  }
</script>

<div class="page-body">
  {#if speech}
    <section class="settings-card">
      <h2 class="setup-title">{$translate('setup.tts.title')}</h2>
      <p class="note">{$translate('setup.tts.hint')}</p>
      {#if speech.models.length > 0 && speech.model}
        <label class="setup-model">
          <span>{$translate('setup.tts.model')}</span>
          <select
            value={speech.model}
            disabled={speech.downloading || testingSpeech}
            onchange={(event) => void choose(event.currentTarget.value)}
          >
            {#each speech.models as item (item.id)}
              <option value={item.id}>{$translate(item.id === 'zh' ? 'setup.tts.modelZh' : 'setup.tts.modelEn')}</option>
            {/each}
          </select>
        </label>
      {/if}
      <p class="setup-status" class:is-on={speech.enabled}>{speechStatus(speech)}</p>
      {#if speech.downloading && speech.total > 0}
        <p class="note">
          {$translate('setup.tts.progress', { received: bytes(speech.received), total: bytes(speech.total) })}
        </p>
        <div class="setup-bar" aria-hidden="true">
          <span style:width={`${Math.min(100, Math.round((speech.received / speech.total) * 100))}%`}></span>
        </div>
      {/if}
      <div class="setup-actions">
        {#if !speech.downloaded}
          <button class="btn primary" type="button" disabled={speech.downloading} onclick={() => void downloadSpeech()}>
            {$translate('setup.tts.download')}
          </button>
        {:else if speech.enabled}
          <button class="btn" type="button" onclick={() => void setSpeechEnabled(false)}>
            {$translate('setup.tts.disable')}
          </button>
        {:else}
          <button class="btn primary" type="button" onclick={() => void setSpeechEnabled(true)}>
            {$translate('setup.tts.enable')}
          </button>
        {/if}
        <button class="btn" type="button" disabled={!speech.enabled || testingSpeech} onclick={() => void testSpeechSample()}>
          {$translate(testingSpeech ? 'setup.tts.testing' : 'setup.tts.test')}
        </button>
      </div>
      {#if spoken}
        <p class="setup-spoken">{spoken}</p>
      {/if}
      {#if speechNote}
        <p class="note">{speechNote}</p>
      {/if}
      {#if speechError}
        <p class="error">{speechError}</p>
      {/if}
    </section>
  {/if}

  {#if decision}
    <section class="settings-card">
      <h2 class="setup-title">{$translate('setup.decision.title')}</h2>
      <p class="note">{$translate('setup.decision.hint')}</p>
      <p class="setup-status" class:is-on={decision.enabled}>{decisionStatus(decision)}</p>
      {#if decision.downloading && decision.total > 0}
        <p class="note">
          {$translate('setup.decision.progress', { received: bytes(decision.received), total: bytes(decision.total) })}
        </p>
        <div class="setup-bar" aria-hidden="true">
          <span style:width={`${Math.min(100, Math.round((decision.received / decision.total) * 100))}%`}></span>
        </div>
      {/if}
      {#if decision.models.length > 0}
        <div class="setup-actions">
          {#if !decision.downloaded}
            <button class="btn primary" type="button" disabled={decision.downloading} onclick={() => void downloadDecisionModel()}>
              {$translate('setup.decision.download')}
            </button>
          {:else if decision.enabled}
            <button class="btn" type="button" onclick={() => void setDecision(false)}>
              {$translate('setup.decision.disable')}
            </button>
          {:else}
            <button class="btn primary" type="button" onclick={() => void setDecision(true)}>
              {$translate('setup.decision.enable')}
            </button>
          {/if}
          <button class="btn" type="button" disabled={!decision.enabled || testingDecision} onclick={() => void testDecisionSample()}>
            {$translate(testingDecision ? 'setup.decision.testing' : 'setup.decision.test')}
          </button>
        </div>
      {/if}
      {#if chosen}
        <p class="setup-spoken">{chosen}</p>
      {/if}
      {#if decisionNote}
        <p class="note">{decisionNote}</p>
      {/if}
      {#if decisionError}
        <p class="error">{decisionError}</p>
      {/if}
    </section>
  {:else if loadError}
    <p class="error">{loadError}</p>
  {/if}
</div>
