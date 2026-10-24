<!--
  Chrome for a single panel (title bar + content area + empty state).

  It does not care about content semantics: plugins only contribute a
  `PanelDto` (declarative description); the main process fetches data over
  the event bus according to `panel.command`, and the shape is up to the
  plugin (classified by dto-guards into table / json / empty / invalid).
-->
<script lang="ts">
  import { ipc } from '../../lib/ipc-client'
  import { channels, events } from '../../../shared/ipc-contract'
  import type { PanelDto } from '../../lib/bridge-types'
  import { parsePanelData } from '../../lib/dto-guards'

  let { panel }: { panel: PanelDto } = $props()

  let data = $state<unknown>(undefined)
  let loading = $state<boolean>(false)
  let error = $state<string | undefined>(undefined)

  const parsed = $derived(parsePanelData(data))

  async function reload(): Promise<void> {
    loading = true
    error = undefined
    try {
      data = await ipc.request(channels.panelData, { panelId: panel.panelId })
    } catch (e) {
      error = (e as Error).message
    } finally {
      loading = false
    }
  }

  // Refetch when the active panel changes, and consume pushed refreshes
  // (a plugin emitting panel.data-changed for this panel updates in place).
  $effect(() => {
    const panelId = panel.panelId
    const unsub = ipc.subscribe(events.panelDataChanged, (payload) => {
      const p = payload as { panelId?: unknown; data?: unknown } | null
      if (p && typeof p.panelId === 'string' && p.panelId === panelId) {
        data = p.data
        error = undefined
      }
    })
    void reload()
    return () => unsub()
  })

  function onRefresh(): void {
    // Notify the plugin first (failure is silent: the plugin may not care),
    // then re-fetch locally so the refresh is visible even without a push.
    void ipc
      .request(channels.uiEvent, { panelId: panel.panelId, kind: 'refresh' })
      .catch(() => undefined)
    void reload()
  }
</script>

<section class="panel">
  <header class="panel-head">
    <span class="icon">{panel.icon}</span>
    <h2>{panel.title}</h2>
    <button type="button" onclick={onRefresh}>Refresh</button>
  </header>
  <div class="panel-body">
    {#if loading}
      <p class="muted">Loading…</p>
    {:else if error}
      <p class="error">{error}</p>
    {:else if parsed.kind === 'table'}
      <table>
        <thead>
          <tr>
            {#each parsed.columns as col}
              <th>{col}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each parsed.rows as row}
            <tr>
              {#each row as cell}
                <td>{cell}</td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    {:else if parsed.kind === 'json'}
      <pre>{parsed.text}</pre>
    {:else if parsed.kind === 'invalid'}
      <p class="error">{parsed.reason}</p>
    {:else}
      <p class="muted">This panel provides no data</p>
    {/if}
  </div>
</section>

<style>
  .panel {
    border: 1px solid var(--rem2-color-border);
    border-radius: 6px;
    background: var(--rem2-color-surface);
  }
  .panel-head {
    display: flex;
    gap: var(--rem2-space-sm);
    align-items: center;
    padding: var(--rem2-space-sm) var(--rem2-space-md);
    border-bottom: 1px solid var(--rem2-color-border);
  }
  .panel-head h2 {
    margin: 0;
    font-size: 14px;
    flex: 1;
  }
  .panel-body {
    padding: var(--rem2-space-md);
  }
  pre {
    margin: 0;
    font-family: var(--rem2-font-mono);
    font-size: 12px;
    white-space: pre-wrap;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-family: var(--rem2-font-mono);
    font-size: 12px;
  }
  th {
    text-align: left;
    padding: var(--rem2-space-xs) var(--rem2-space-sm);
    border: 1px solid var(--rem2-color-border);
    background: var(--rem2-color-surface);
    color: var(--rem2-color-text-muted);
  }
  td {
    padding: var(--rem2-space-xs) var(--rem2-space-sm);
    border: 1px solid var(--rem2-color-border);
    color: var(--rem2-color-text);
  }
  .muted {
    color: var(--rem2-color-text-muted);
    margin: 0;
  }
  .error {
    color: #ff6b6b;
    margin: 0;
  }
</style>
