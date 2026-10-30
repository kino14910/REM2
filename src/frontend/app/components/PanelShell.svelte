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
  let actionError = $state<string | undefined>(undefined)
  let changing = $state<boolean>(false)

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

  async function onFieldChange(fieldId: string, event: Event): Promise<void> {
    if (changing) return
    const target = event.currentTarget as HTMLInputElement | HTMLSelectElement
    changing = true
    actionError = undefined
    try {
      const result = await ipc.request<
        { ok?: boolean; error?: string } | undefined
      >(channels.uiEvent, {
        panelId: panel.panelId,
        kind: 'change',
        payload: { fieldId, value: target.value },
      })
      if (result?.ok === false) {
        throw new Error(result.error ?? 'The change was rejected')
      }
    } catch (e) {
      actionError = (e as Error).message
    } finally {
      // Re-read after success and failure: the plugin owns the canonical value.
      await reload()
      changing = false
    }
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
    {:else if parsed.kind === 'form'}
      <form class="settings-form" onsubmit={(event) => event.preventDefault()}>
        {#each parsed.fields as field (field.id)}
          <label class="form-field" for={`${panel.panelId}-${field.id}`}>
            <span>{field.label}</span>
            {#if field.type === 'select'}
              <select
                id={`${panel.panelId}-${field.id}`}
                value={field.value}
                disabled={changing}
                onchange={(event) => void onFieldChange(field.id, event)}
              >
                {#each field.options ?? [] as option (option.value)}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            {:else}
              <input
                id={`${panel.panelId}-${field.id}`}
                type="color"
                value={field.value}
                disabled={changing}
                onchange={(event) => void onFieldChange(field.id, event)}
              />
            {/if}
          </label>
        {/each}
        {#if actionError}
          <p class="error" role="alert">{actionError}</p>
        {/if}
      </form>
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
  .settings-form {
    display: grid;
    gap: var(--rem2-space-md);
    max-width: 32rem;
  }
  .form-field {
    display: grid;
    grid-template-columns: minmax(8rem, 1fr) minmax(10rem, 2fr);
    align-items: center;
    gap: var(--rem2-space-md);
    color: var(--rem2-color-text);
  }
  .form-field select {
    padding: var(--rem2-space-xs) var(--rem2-space-sm);
    border: 1px solid var(--rem2-color-border);
    border-radius: 4px;
    background: var(--rem2-color-background);
    color: var(--rem2-color-text);
    font: inherit;
  }
  .form-field input[type='color'] {
    width: 4rem;
    height: 2rem;
    padding: 2px;
    border: 1px solid var(--rem2-color-border);
    border-radius: 4px;
    background: var(--rem2-color-background);
    cursor: pointer;
  }
  .form-field select:focus-visible,
  .form-field input:focus-visible {
    outline: 2px solid var(--rem2-color-accent);
    outline-offset: 2px;
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
