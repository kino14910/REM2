<!--
  Chrome for a single panel (title bar + content area + empty state).

  It does not care about content semantics: plugins only contribute a
  `PanelDto` (declarative description); the main process fetches data over
  the event bus according to `panel.command`, and the shape is up to the
  plugin (classified by dto-guards into table / json / empty / invalid).

  Everything here uses the shared UI kit, so plugin-contributed panels inherit
  the same theme, spacing and controls as the host views.
-->
<script lang="ts">
  import { ipc } from '@/frontend/lib/ipc-client'
  import { channels, events } from '@/shared/ipc-contract'
  import type { PanelDto } from '@/frontend/lib/bridge-types'
  import { parsePanelData } from '@/frontend/lib/dto-guards'
  import Alert from '@/frontend/lib/ui/Alert.svelte'
  import Button from '@/frontend/lib/ui/Button.svelte'
  import Card from '@/frontend/lib/ui/Card.svelte'
  import Field from '@/frontend/lib/ui/Field.svelte'
  import Select from '@/frontend/lib/ui/Select.svelte'
  import Spinner from '@/frontend/lib/ui/Spinner.svelte'
  import TextField from '@/frontend/lib/ui/TextField.svelte'

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

<Card padding="none" class="overflow-hidden">
  <header
    class="flex items-center gap-3 border-b border-surface-200-800 px-4 py-3"
  >
    <span class="text-lg leading-none" aria-hidden="true">{panel.icon}</span>
    <h2 class="min-w-0 flex-1 truncate text-sm font-semibold">{panel.title}</h2>
    <Button
      size="sm"
      variant="secondary"
      loading={loading}
      loadingLabel="Loading…"
      onclick={onRefresh}
    >
      Refresh
    </Button>
  </header>
  <div class="p-4">
    {#if loading && data === undefined}
      <div class="flex items-center gap-2 text-sm text-surface-600-400">
        <Spinner />
        <span>Loading…</span>
      </div>
    {:else if error}
      <Alert tone="error">{error}</Alert>
    {:else if parsed.kind === 'form'}
      <form
        class="grid max-w-lg gap-4"
        onsubmit={(event) => event.preventDefault()}
      >
        {#each parsed.fields as field (field.id)}
          {@const id = `${panel.panelId}-${field.id}`}
          <Field label={field.label} forId={id}>
            {#if field.type === 'select'}
              <Select
                id={id}
                value={field.value}
                options={field.options ?? []}
                disabled={changing}
                onchange={(event) => void onFieldChange(field.id, event)}
              />
            {:else}
              <TextField
                id={id}
                type="color"
                value={field.value}
                disabled={changing}
                onchange={(event) => void onFieldChange(field.id, event)}
              />
            {/if}
          </Field>
        {/each}
        {#if actionError}
          <Alert tone="error">{actionError}</Alert>
        {/if}
      </form>
    {:else if parsed.kind === 'table'}
      <div class="table-wrap">
        <table class="table">
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
      </div>
    {:else if parsed.kind === 'json'}
      <pre
        class="max-h-96 overflow-auto rounded-base bg-surface-50-950 p-3 font-mono text-xs whitespace-pre-wrap">{parsed.text}</pre>
    {:else if parsed.kind === 'invalid'}
      <Alert tone="error">{parsed.reason}</Alert>
    {:else}
      <p class="text-sm text-surface-600-400">This panel provides no data</p>
    {/if}
  </div>
</Card>
