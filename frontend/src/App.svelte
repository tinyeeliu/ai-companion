<script lang="ts">
  import { onMount } from 'svelte';
  import DetailDialog from './DetailDialog.svelte';
  import LinkDialog from './LinkDialog.svelte';
  import MessagesPage from './MessagesPage.svelte';
  import NavRail from './NavRail.svelte';
  import PageHeader from './PageHeader.svelte';
  import PhonesPage from './PhonesPage.svelte';
  import RenameDialog from './RenameDialog.svelte';
  import TitleBar from './TitleBar.svelte';
  import { bootstrap, fetchHealth, listConnections, type Connection, type MessageDirection } from './api';
  import { tr as translate } from './i18n';
  import { initNav, navigate, route } from './nav';
  import { messagesRoute, pageRoute, type TopPageId } from './routes';

  /**
   * Reserved slots, off until there is more than one section: the rail column
   * and the title bar's overflow menu. See NavRail.svelte and TitleBar.svelte.
   */
  const railOpen = false;
  const menuOpen = false;

  let running = $state(false);
  let bootstrapped = $state(false);
  let connections = $state<Connection[]>([]);
  let error = $state('');
  let showLink = $state(false);
  let editId = $state<string | null>(null);
  let renameId = $state<string | null>(null);

  const current = $derived($route);
  /** Non-null only on the messages route, so the branches below stay type-safe. */
  const history = $derived(current.id === 'phones' ? null : current.params);

  async function refreshList(): Promise<void> {
    const listed = await listConnections();
    connections = listed.connections;
  }

  async function ping(): Promise<void> {
    const health = await fetchHealth();
    running = health.ok;
  }

  async function tick(): Promise<void> {
    try {
      await ping();
      if ($route.id === 'phones') await refreshList();
      error = '';
    } catch (err) {
      running = false;
      error = err instanceof Error ? err.message : String(err);
    }
  }

  onMount(() => {
    const stopNav = initNav();
    void (async () => {
      try {
        await bootstrap();
        await tick();
      } catch (err) {
        running = false;
        error = err instanceof Error ? err.message : String(err);
      } finally {
        bootstrapped = true;
      }
    })();
    const timer = setInterval(() => {
      if (bootstrapped) void tick();
    }, 2000);
    return () => {
      stopNav();
      clearInterval(timer);
    };
  });

  function openLink(): void {
    editId = null;
    showLink = true;
  }

  function openEdit(id: string): void {
    showLink = false;
    editId = id;
  }

  function openRename(id: string): void {
    renameId = id;
  }

  function openHistory(id: string, direction: MessageDirection): void {
    showLink = false;
    editId = null;
    navigate(messagesRoute(id, { direction }));
  }

  function goTo(id: TopPageId): void {
    showLink = false;
    editId = null;
    navigate(pageRoute(id));
  }

  const renaming = $derived(renameId == null ? null : (connections.find((row) => row.id === renameId) ?? null));
</script>

{#snippet phoneActions()}
  <button class="btn primary" type="button" onclick={openLink}>{$translate('app.linkPhone')}</button>
{/snippet}

<div class="frame" data-rail={railOpen ? 'open' : 'closed'}>
  <TitleBar running={running} menu={menuOpen} />
  <NavRail open={railOpen} current={current.id} />

  <main class="page">
    <PageHeader
      id={current.id}
      params={current.params}
      onNavigate={goTo}
      actions={current.id === 'phones' ? phoneActions : undefined}
    />

    {#if !bootstrapped}
      <div class="page-body">
        <p class="hint">{$translate('common.loading')}</p>
      </div>
    {:else if history != null}
      <MessagesPage params={history} />
    {:else}
      <PhonesPage
        {connections}
        {error}
        onRename={openRename}
        onEdit={openEdit}
        onHistory={openHistory}
      />
    {/if}
  </main>
</div>

{#if showLink}
  <LinkDialog
    onClose={(changed) => {
      showLink = false;
      if (changed) void refreshList();
    }}
  />
{/if}

{#if editId}
  <DetailDialog
    id={editId}
    onClose={(changed) => {
      editId = null;
      if (changed) void refreshList();
    }}
  />
{/if}

{#if renaming}
  <RenameDialog
    connection={renaming}
    onClose={(changed) => {
      renameId = null;
      if (changed) void refreshList();
    }}
  />
{/if}
