<script lang="ts">
  import {
    getConnection,
    getMessage,
    listMessages,
    MESSAGE_STATUSES,
    MESSAGE_TYPES,
    type ChatMessageDetail,
    type ChatMessageListItem,
    type Connection,
    type MessageStatus,
  } from './api';
  import { tr as translate } from './i18n';
  import { navigate, setCrumb } from './nav';
  import {
    messagesRoute,
    type DirectionFilter,
    type MessageFilters,
    type MessagesParams,
  } from './routes';
  import { formatTimestamp, messageStatusLabel, messageStatusTone } from './status';
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
          <option value={type}>{type}</option>
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
              <td>{formatTimestamp(row.timestamp)}</td>
              <td>{row.type}</td>
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
                      <path d="M6.5 3.5 3 7l3.5 3.5" />
                      <path d="M3 7h5.5A3.5 3.5 0 0 1 12 10.5V12" />
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
                    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M1.5 7.5S4 3.5 7.5 3.5 13.5 7.5 13.5 7.5 11 11.5 7.5 11.5 1.5 7.5 1.5 7.5Z" />
                      <circle cx="7.5" cy="7.5" r="2.2" />
                    </svg>
                  </button>
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
