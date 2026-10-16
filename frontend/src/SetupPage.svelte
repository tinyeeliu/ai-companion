<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    decisionExampleCurl,
    downloadDecision,
    downloadLlm,
    downloadTts,
    fetchHealth,
    getSetup,
    llmExampleCurls,
    setDecisionEnabled,
    setLlmEnabled,
    setLlmUseProxy,
    setTtsEnabled,
    setTtsModel,
    speechExampleCurl,
    testDecision,
    testLlm,
    testSpeech,
    testSpeechText,
    type DecisionSetupFeature,
    type LlmSetupFeature,
    type LlmStep,
    type TtsSetupFeature,
  } from './api';
  import ExampleDialog from './ExampleDialog.svelte';
  import { t, tr as translate } from './i18n';

  /**
   * Setup is a list of local features. Speech is the first card. Decision is
   * the second: download the model, turn it on, then ask one short question.
   */
  let speech = $state<TtsSetupFeature | null>(null);
  let decision = $state<DecisionSetupFeature | null>(null);
  let llm = $state<LlmSetupFeature | null>(null);
  let loadError = $state('');
  let speechError = $state('');
  let decisionError = $state('');
  let llmError = $state('');
  let speechNote = $state('');
  let decisionNote = $state('');
  let llmNote = $state('');
  let spoken = $state('');
  let chosen = $state('');
  let replied = $state('');
  let testingSpeech = $state(false);
  let testingDecision = $state(false);
  let testingLlm = $state(false);
  let apiPort = $state(38000);
  let example = $state<{ title: string; snippets: { label: string; text: string }[] } | null>(null);

  const STEP_KEY: Record<LlmStep, string> = {
    download: 'setup.llm.step.download',
    login: 'setup.llm.step.login',
    proxy: 'setup.llm.step.proxy',
    port: 'setup.llm.step.port',
    expired: 'setup.llm.step.expired',
    unsupported: 'setup.llm.unavailable',
  };
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

  function applyLlm(next: LlmSetupFeature): void {
    llm = next;
    if (next.error != null && next.error !== '') llmError = next.error;
    syncPolling();
  }

  async function load(): Promise<void> {
    const body = await getSetup();
    const tts = body.features.find((item): item is TtsSetupFeature => item.id === 'tts');
    const next = body.features.find((item): item is DecisionSetupFeature => item.id === 'decision');
    const gateway = body.features.find((item): item is LlmSetupFeature => item.id === 'llm');
    if (tts != null) applySpeech(tts);
    if (next != null) applyDecision(next);
    if (gateway != null) applyLlm(gateway);
  }

  function syncPolling(): void {
    if (speech?.downloading || decision?.downloading || llm?.downloading) startPolling();
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
    void fetchHealth()
      .then((health) => {
        if (health.port > 0) apiPort = health.port;
      })
      .catch(() => undefined);
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

  function openSpeechExample(): void {
    example = {
      title: t('setup.tts.title'),
      snippets: [{ label: t('setup.example.speech'), text: speechExampleCurl(apiPort) }],
    };
  }

  function openDecisionExample(): void {
    example = {
      title: t('setup.decision.title'),
      snippets: [{ label: t('setup.example.decision'), text: decisionExampleCurl(apiPort) }],
    };
  }

  function openLlmExample(): void {
    const curls = llmExampleCurls(apiPort);
    example = {
      title: t('setup.llm.title'),
      snippets: [
        { label: t('setup.example.llm'), text: curls.direct },
        { label: t('setup.example.llmRouter'), text: curls.router },
        { label: t('setup.example.llmResponses'), text: curls.responses },
        { label: t('setup.example.llmResponsesRouter'), text: curls.responsesRouter },
      ],
    };
  }

  async function downloadGateway(): Promise<void> {
    llmError = '';
    llmNote = '';
    replied = '';
    try {
      applyLlm(await downloadLlm());
    } catch (err) {
      llmError = err instanceof Error ? err.message : String(err);
    }
  }

  async function setGateway(enabled: boolean): Promise<void> {
    llmError = '';
    llmNote = '';
    replied = '';
    try {
      applyLlm(await setLlmEnabled(enabled));
    } catch (err) {
      llmError = err instanceof Error ? err.message : String(err);
    }
  }

  async function setGatewayProxy(useProxy: boolean): Promise<void> {
    llmError = '';
    try {
      applyLlm(await setLlmUseProxy(useProxy));
    } catch (err) {
      llmError = err instanceof Error ? err.message : String(err);
    }
  }

  async function testGateway(): Promise<void> {
    llmError = '';
    llmNote = '';
    replied = '';
    testingLlm = true;
    const started = performance.now();
    try {
      const body = await testLlm();
      const delayMs = Math.round(performance.now() - started);
      replied = body.text;
      llmNote = t('setup.llm.testOk', { ms: body.ms || delayMs });
    } catch (err) {
      llmError = err instanceof Error ? err.message : String(err);
    } finally {
      testingLlm = false;
    }
  }

  function llmStatus(item: LlmSetupFeature): string {
    if (item.steps.includes('unsupported')) return t('setup.llm.unavailable');
    if (item.downloading) return t('setup.llm.downloading');
    if (!item.downloaded) return t('setup.llm.missing');
    return t(item.enabled ? 'setup.llm.on' : 'setup.llm.off');
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
        <button class="btn" type="button" onclick={openSpeechExample}>
          {$translate('setup.example')}
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
          <button class="btn" type="button" onclick={openDecisionExample}>
            {$translate('setup.example')}
          </button>
        </div>
      {:else}
        <div class="setup-actions">
          <button class="btn" type="button" onclick={openDecisionExample}>
            {$translate('setup.example')}
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
  {/if}

  {#if llm}
    <section class="settings-card">
      <h2 class="setup-title">{$translate('setup.llm.title')}</h2>
      <p class="note">{$translate('setup.llm.hint')}</p>
      <p class="setup-status" class:is-on={llm.enabled}>{llmStatus(llm)}</p>
      {#if llm.baseUrl}
        <p class="note">{llm.baseUrl}</p>
      {/if}
      {#if llm.downloading && llm.total > 0}
        <p class="note">
          {$translate('setup.llm.progress', { received: bytes(llm.received), total: bytes(llm.total) })}
        </p>
        <div class="setup-bar" aria-hidden="true">
          <span style:width={`${Math.min(100, Math.round((llm.received / llm.total) * 100))}%`}></span>
        </div>
      {/if}
      {#if !llm.steps.includes('unsupported')}
        <label class="setup-check">
          <input
            type="checkbox"
            checked={llm.useProxy}
            disabled={llm.downloading}
            onchange={(event) => void setGatewayProxy(event.currentTarget.checked)}
          />
          <span>{$translate('setup.llm.useProxy')}</span>
        </label>
        <div class="setup-actions">
          {#if !llm.downloaded}
            <button class="btn primary" type="button" disabled={llm.downloading} onclick={() => void downloadGateway()}>
              {$translate('setup.llm.download')}
            </button>
          {:else if llm.enabled}
            <button class="btn" type="button" onclick={() => void setGateway(false)}>
              {$translate('setup.llm.disable')}
            </button>
          {:else}
            <button class="btn primary" type="button" onclick={() => void setGateway(true)}>
              {$translate('setup.llm.enable')}
            </button>
          {/if}
          <button class="btn" type="button" disabled={!llm.enabled || testingLlm} onclick={() => void testGateway()}>
            {$translate(testingLlm ? 'setup.llm.testing' : 'setup.llm.test')}
          </button>
          <button class="btn" type="button" onclick={openLlmExample}>
            {$translate('setup.example')}
          </button>
        </div>
      {:else}
        <div class="setup-actions">
          <button class="btn" type="button" onclick={openLlmExample}>
            {$translate('setup.example')}
          </button>
        </div>
      {/if}
      {#if llm.steps.length > 0}
        <ol class="setup-steps">
          {#each llm.steps as step (step)}
            <li>{$translate(STEP_KEY[step])}</li>
          {/each}
        </ol>
      {/if}
      {#if replied}
        <p class="setup-spoken">{replied}</p>
      {/if}
      {#if llmNote}
        <p class="note">{llmNote}</p>
      {/if}
      {#if llmError}
        <p class="error">{llmError}</p>
      {/if}
    </section>
  {/if}

  {#if loadError && !speech && !decision && !llm}
    <p class="error">{loadError}</p>
  {/if}
</div>

{#if example}
  <ExampleDialog title={example.title} snippets={example.snippets} onClose={() => (example = null)} />
{/if}
