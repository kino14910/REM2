<!--
  Chrome for a single panel (title bar + content area + empty state).

  It does not care about content semantics: plugins only contribute a
  `PanelDto` (declarative description); the main process fetches data over
  the event bus according to `panel.command`, and the shape is up to the plugin.
-->
<script lang="ts">
  import { ipc } from '../../lib/ipc-client'
  import { channels } from '../../../shared/ipc-contract'
  import type { PanelDto } from '../../lib/bridge-types'

  let { panel }: { panel: PanelDto } = $props()

  let data = $state<unknown>(undefined)
  let loading = $state<boolean>(false)
  let error = $state<string | undefined>(undefined)

  // Refetch data whenever the active panel changes.
  $effect(() => {
    const panelId = panel.panelId
    loading = true
    void ipc
      .request(channels.panelData, { panelId })
      .then((d) => {
        data = d
        error = undefined
      })
      .catch((e: Error) => {
        error = e.message
      })
      .finally(() => {
        loading = false
      })
  })

  function report(kind: string, payload?: unknown): void {
    void ipc.request(channels.uiEvent, { panelId: panel.panelId, kind, payload })
  }
</script>

<section class="panel">
  <header class="panel-head">
    <span class="icon">{panel.icon}</span>
    <h2>{panel.title}</h2>
    <button type="button" onclick={() => report('refresh')}>Refresh</button>
  </header>
  <div class="panel-body">
    {#if loading}
      <p class="muted">Loading…</p>
    {:else if error}
      <p class="error">{error}</p>
    {:else if data === undefined}
      <p class="muted">This panel provides no data</p>
    {:else}
      <pre>{JSON.stringify(data, null, 2)}</pre>
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
  .muted {
    color: var(--rem2-color-text-muted);
    margin: 0;
  }
  .error {
    color: var(--rem2-color-text);
    margin: 0;
  }
</style>
