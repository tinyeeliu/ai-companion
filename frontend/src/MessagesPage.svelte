<script lang="ts">
  import {
    getConnection,
    getMessage,
    listMessages,
    replayMessage,
    MESSAGE_STATUSES,
    MESSAGE_TYPES,
    type ChatMessageDetail,
    type ChatMessageListItem,
    type Connection,
    type MessageStatus,
  } from './api';
  import { locale, tr as translate } from './i18n';
  import { navigate, setCrumb } from './nav';
  import {
    messagesRoute,
    type DirectionFilter,
    type MessageFilters,
    type MessagesParams,
  } from './routes';
  import {
    formatTimestamp,
    messageStatusLabel,
    messageStatusTone,
    messageTypeLabel,
  } from './status';
  import MessageDetailDialog from './MessageDetailDialog.svelte';
  import SendMessageDialog from './SendMessageDialog.svelte';
  import { tip } from './tooltip';

  /**
   * Message history for one phone: both directions in one table, narrowed by the
   * filters above it. The frame's PageHeader owns the title, hint and back
   * control; this component publishes the connection name as a breadcrumb label
   * once it has loaded it.
   */
  let { params }: { params: MessagesParams } = $props();

  let connection = $state<Connection | null>(null);
  let messages = $state<ChatMessageListItem[]>([]);
  let total = $state(0);
  let limit = $state(10);
  let error = $state('');
  let loading = $state(true);
  let detail = $state<ChatMessageDetail | null>(null);
  let detailBusy = $state(false);
  let reply = $state<ChatMessageListItem | null>(null);
  let requestSeq = 0;
  /** Row awaiting replay confirmation; the click only opens the dialog. */
  let replayTarget = $state<ChatMessageListItem | null>(null);
  /** Row whose replay request is in flight. */
  let replayingId = $state<number | null>(null);
  /** Row replayed a moment ago, for the transient tick. */
  let replayedId = $state<number | null>(null);
  let replayTimer: ReturnType<typeof setTimeout> | undefined;

  const pages = $derived(Math.max(1, Math.ceil(total / Math.max(limit, 1))));
  const filtered = $derived(
    params.direction !== 'all' || params.type != null || params.status != null,
  );

  /** The other party: inbound senders, outbound recipients. */
  function replyTo(row: ChatMessageListItem): string {
    return row.direction === 'in' ? row.from : row.to;
  }

  /** Only the active filters, so a navigation never drags a stale page behind it. */
  function currentFilters(): MessageFilters {
    return { direction: params.direction, type: params.type, status: params.status };
  }

  function applyFilters(patch: MessageFilters): void {
    navigate(messagesRoute(params.connectionId, { ...currentFilters(), page: 1, ...patch }));
  }

  function goToPage(page: number): void {
    navigate(messagesRoute(params.connectionId, { ...currentFilters(), page }));
  }

  async function load(
    id: string,
    direction: DirectionFilter,
    type: string | null,
    status: MessageStatus | null,
    page: number,
  ): Promise<void> {
    const seq = ++requestSeq;
    loading = true;
    error = '';
    try {
      const [{ connection: next }, listed] = await Promise.all([
        getConnection(id),
        listMessages(id, { direction, type, status, page }),
      ]);
      if (seq !== requestSeq) return;
      connection = next;
      // Names the trail segment in the frame, and the window title with it.
      setCrumb('connectionId', next.name);
      messages = listed.messages;
      total = listed.total;
      limit = listed.limit;
    } catch (err) {
      if (seq !== requestSeq) return;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      if (seq === requestSeq) loading = false;
    }
  }

  $effect(() => {
    // Read the params synchronously: the effect re-runs when any of them change.
    void load(params.connectionId, params.direction, params.type, params.status, params.page);
  });

  async function openDetail(id: number): Promise<void> {
    detailBusy = true;
    error = '';
    try {
      const next = await getMessage(params.connectionId, id);
      detail = next.message;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      detailBusy = false;
    }
  }

  /**
   * Replay re-sends the message to the cloud, so it asks first. The click itself
   * never sends.
   */
  function askReplay(row: ChatMessageListItem): void {
    replayTarget = row;
  }

  async function confirmReplay(): Promise<void> {
    const row = replayTarget;
    if (row == null) return;
    replayTarget = null;
    replayingId = row.id;
    error = '';
    try {
      await replayMessage(params.connectionId, row.id);
      replayedId = row.id;
      if (replayTimer != null) clearTimeout(replayTimer);
      replayTimer = setTimeout(() => {
        replayedId = null;
      }, 2000);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      replayingId = null;
    }
  }
</script>

<div class="page-body">
  {#if error}
    <p class="error">{error}</p>
  {/if}

  <div class="filters">
    <label class="filter">
      <span>{$translate('filter.direction')}</span>
      <select
        value={params.direction}
        onchange={(event) =>
          applyFilters({ direction: event.currentTarget.value as DirectionFilter })}
      >
        <option value="all">{$translate('filter.all')}</option>
        <option value="in">{$translate('page.received.title')}</option>
        <option value="out">{$translate('page.sent.title')}</option>
      </select>
    </label>

    <label class="filter">
      <span>{$translate('filter.type')}</span>
      <select
        value={params.type ?? ''}
        onchange={(event) => {
          const value = event.currentTarget.value;
          applyFilters({ type: value === '' ? null : value });
        }}
      >
        <option value="">{$translate('filter.all')}</option>
        {#each MESSAGE_TYPES as type (type)}
          <option value={type}>{messageTypeLabel(type, $translate)}</option>
        {/each}
      </select>
    </label>

    <label class="filter">
      <span>{$translate('filter.status')}</span>
      <select
        value={params.status ?? ''}
        onchange={(event) => {
          const value = event.currentTarget.value;
          applyFilters({ status: value === '' ? null : (value as MessageStatus) });
        }}
      >
        <option value="">{$translate('filter.all')}</option>
        {#each MESSAGE_STATUSES as status (status)}
          <option value={status}>
            {status === 'na'
              ? $translate('history.statusNa')
              : messageStatusLabel(status, 0, $translate)}
          </option>
        {/each}
      </select>
    </label>

    {#if filtered}
      <button
        class="btn ghost"
        type="button"
        onclick={() => applyFilters({ direction: 'all', type: null, status: null })}
      >
        {$translate('filter.clear')}
      </button>
    {/if}
  </div>

  <div class="table-wrap">
    {#if loading && messages.length === 0}
      <div class="empty">{$translate('common.loading')}</div>
    {:else if messages.length === 0}
      <div class="empty">
        {$translate(filtered ? 'history.emptyFiltered' : 'history.empty')}
      </div>
    {:else}
      <table>
        <thead>
          <tr>
            <th>{$translate('history.timestamp')}</th>
            <th>{$translate('history.type')}</th>
            <th>{$translate('history.summary')}</th>
            <th>{$translate('history.from')}</th>
            <th>{$translate('history.to')}</th>
            <th>{$translate('history.status')}</th>
            <th class="action">{$translate('table.action')}</th>
          </tr>
        </thead>
        <tbody>
          {#each messages as row (row.id)}
            <tr>
              <td>{formatTimestamp(row.timestamp, $locale)}</td>
              <td>{messageTypeLabel(row.type, $translate)}</td>
              <td class="summary">{row.summary || '—'}</td>
              <td>{row.from || '—'}</td>
              <td>{row.to || '—'}</td>
              <td class="status">
                {#if row.status === 'na'}
                  <span class="muted">—</span>
                {:else}
                  <span class="chip tone-{messageStatusTone(row.status)}">
                    {messageStatusLabel(row.status, row.errorCount, $translate)}
                  </span>
                {/if}
              </td>
              <td class="action">
                <div class="row center">
                  <button
                    class="icon-btn"
                    type="button"
                    use:tip={$translate('history.reply')}
                    aria-label={$translate('history.reply')}
                    onclick={() => (reply = row)}
                  >
                    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M13.75 1.25 6.875 8.125" />
                      <path d="M13.75 1.25 9.375 13.75 6.875 8.125 1.25 5.625Z" />
                    </svg>
                  </button>
                  <button
                    class="icon-btn"
                    type="button"
                    use:tip={$translate('history.view')}
                    aria-label={$translate('history.view')}
                    disabled={detailBusy}
                    onclick={() => void openDetail(row.id)}
                  >
                    <svg width="17" height="17" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M5.88 1.7 C4.26 1.7 4.4 3.32 4.4 4.4 C4.4 5.88 3.72 6.96 1.97 7.5 C3.72 8.04 4.4 9.12 4.4 10.61 C4.4 11.69 4.26 13.31 5.88 13.31" />
                      <path d="M9.12 1.7 C10.74 1.7 10.6 3.32 10.6 4.4 C10.6 5.88 11.28 6.96 13.03 7.5 C11.28 8.04 10.6 9.12 10.6 10.61 C10.6 11.69 10.74 13.31 9.12 13.31" />
                    </svg>
                  </button>
                  {#if row.direction === 'in'}
                    {@const replaying = replayingId === row.id}
                    {@const replayed = replayedId === row.id}
                    <button
                      class="icon-btn"
                      type="button"
                      use:tip={$translate(replayed ? 'history.replayed' : 'history.replay')}
                      aria-label={$translate(replayed ? 'history.replayed' : 'history.replay')}
                      disabled={replaying}
                      onclick={() => askReplay(row)}
                    >
                      {#if replayed}
                        <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          <path d="M3.5 8 6.2 10.7 11.5 4.5" />
                        </svg>
                      {:else}
                        <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          <path d="M2.5 7.5a5 5 0 0 1 8.6-3.4" />
                          <path d="M12.5 7.5a5 5 0 0 1-8.6 3.4" />
                          <path d="M11.3 1.6v2.6H8.7" />
                          <path d="M3.7 13.4v-2.6h2.6" />
                        </svg>
                      {/if}
                    </button>
                  {/if}
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>

  {#if total > 0}
    <div class="pager">
      <button
        class="btn ghost"
        type="button"
        disabled={params.page <= 1}
        onclick={() => goToPage(params.page - 1)}
      >
        {$translate('history.prev')}
      </button>
      <span class="note">{$translate('history.page', { page: params.page, pages })}</span>
      <button
        class="btn ghost"
        type="button"
        disabled={params.page >= pages}
        onclick={() => goToPage(params.page + 1)}
      >
        {$translate('history.next')}
      </button>
    </div>
  {/if}
</div>

{#if detail}
  <MessageDetailDialog message={detail} onClose={() => (detail = null)} />
{/if}

{#if reply && connection}
  <SendMessageDialog
    {connection}
    initialTo={replyTo(reply)}
    context={{ summary: reply.summary }}
    onClose={(sent) => {
      reply = null;
      if (sent) void load(params.connectionId, params.direction, params.type, params.status, params.page);
    }}
  />
{/if}

{#if replayTarget}
  <div class="backdrop" role="presentation">
    <div
      class="dialog narrow"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="replay-title"
      aria-describedby="replay-text"
    >
      <h2 id="replay-title">{$translate('history.replayConfirmTitle')}</h2>
      <div class="stack">
        <p id="replay-text" class="muted">{$translate('history.replayConfirm')}</p>
        <div class="row end">
          <button class="btn ghost" type="button" onclick={() => (replayTarget = null)}>
            {$translate('common.cancel')}
          </button>
          <button class="btn primary" type="button" onclick={() => void confirmReplay()}>
            {$translate('history.replay')}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
