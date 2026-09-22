<script lang="ts">
  import type { Connection, MessageDirection } from './api';
  import { tr as translate } from './i18n';
  import {
    accountLabel,
    channelLabel,
    cloudLabel,
    cloudTone,
    formatUptime,
    statusLabel,
    statusTone,
    userLabel,
  } from './status';
  import { tip } from './tooltip';

  /**
   * The phones list. The page title, hint and "Link a phone" action live in the
   * frame's PageHeader, so this component owns only the list itself.
   */
  let {
    connections,
    error,
    onRename,
    onEdit,
    onHistory,
  }: {
    connections: Connection[];
    error: string;
    onRename: (id: string) => void;
    onEdit: (id: string) => void;
    onHistory: (id: string, direction: MessageDirection) => void;
  } = $props();
</script>

<div class="page-body">
  {#if error && connections.length === 0}
    <p class="error">{error}</p>
  {/if}

  <div class="table-wrap">
    {#if connections.length === 0}
      <div class="empty">
        <p class="lede">{$translate('app.tagline')}</p>
        <p>{$translate('app.empty')}</p>
      </div>
    {:else}
      <table>
        <thead>
          <tr>
            <th>{$translate('table.name')}</th>
            <th>{$translate('table.channel')}</th>
            <th>{$translate('table.account')}</th>
            <th>{$translate('table.user')}</th>
            <th use:tip={$translate('table.statusHint')}>{$translate('table.status')}</th>
            <th>{$translate('table.online')}</th>
            <th use:tip={$translate('table.cloudHint')}>{$translate('table.cloud')}</th>
            <th class="num">{$translate('table.received')}</th>
            <th class="num">{$translate('table.sent')}</th>
            <th class="num" use:tip={$translate('table.disconnectsHint')}>
              {$translate('table.disconnects')}
            </th>
            <th class="action">{$translate('table.action')}</th>
          </tr>
        </thead>
        <tbody>
          {#each connections as row (row.id)}
            {@const tone = statusTone(row.status)}
            {@const cloud = cloudTone(row.cloudStatus)}
            <tr class={`tone-${tone}`}>
              <td>
                <button
                  class="name-btn"
                  type="button"
                  use:tip={$translate('table.rename', { name: row.name })}
                  aria-label={$translate('table.rename', { name: row.name })}
                  onclick={() => onRename(row.id)}
                >
                  {row.name}
                  <svg class="edit-icon" width="13" height="13" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="m9.9 2.1 3 3L5 13H2v-3z" />
                    <path d="m8.3 3.7 3 3" />
                  </svg>
                </button>
              </td>
              <td>{channelLabel(row.channel, $translate)}</td>
              <td>{accountLabel(row.phone, $translate)}</td>
              <td>{userLabel(row.user)}</td>
              <td>
                <span class="online" use:tip={$translate('table.statusHint')}>
                  <span
                    class="dot"
                    class:warn={tone === 'warning'}
                    class:danger={tone === 'danger'}
                    class:idle={tone === 'neutral'}
                    aria-hidden="true"
                  ></span>
                  {statusLabel(row.status, $translate)}
                </span>
              </td>
              <td class="uptime">
                <span class="online" use:tip={statusLabel(row.status, $translate)}>
                  <span
                    class="dot"
                    class:warn={tone === 'warning'}
                    class:danger={tone === 'danger'}
                    class:idle={tone === 'neutral'}
                    aria-hidden="true"
                  ></span>
                  {formatUptime(row.uptimeMs, $translate)}
                </span>
              </td>
              <td>
                <span class="online" use:tip={row.cloudError ?? $translate('table.cloudHint')}>
                  <span
                    class="dot"
                    class:warn={cloud === 'warning'}
                    class:danger={cloud === 'danger'}
                    class:idle={cloud === 'neutral'}
                    aria-hidden="true"
                  ></span>
                  {cloudLabel(row.cloudStatus, $translate)}
                </span>
              </td>
              <td class="num">
                <button
                  class="count-link"
                  type="button"
                  use:tip={$translate('history.openReceived', { name: row.name })}
                  onclick={() => onHistory(row.id, 'in')}
                >
                  {row.incomingCount}
                </button>
              </td>
              <td class="num">
                <button
                  class="count-link"
                  type="button"
                  use:tip={$translate('history.openSent', { name: row.name })}
                  onclick={() => onHistory(row.id, 'out')}
                >
                  {row.outgoingCount}
                </button>
              </td>
              <td
                class="num"
                class:drop-high={(row.disconnectCount ?? 0) >= 5}
                use:tip={$translate('table.disconnectsHint')}
              >
                {row.disconnectCount ?? 0}
              </td>
              <td class="action">
                <button
                  class="icon-btn"
                  type="button"
                  use:tip={$translate('table.manage', { name: row.name })}
                  aria-label={$translate('table.manage', { name: row.name })}
                  onclick={() => onEdit(row.id)}
                >
                  <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="m9.9 2.1 3 3L5 13H2v-3z" />
                    <path d="m8.3 3.7 3 3" />
                  </svg>
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</div>
