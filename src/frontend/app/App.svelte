<!--
  Root component: first-paint orchestration.

  Four data sets are loaded in parallel, each degrading to empty on failure
  (never blocking render); the unsubscribe functions for event subscriptions
  are returned from `onMount` so the runtime cleans them up on destroy
  (matching the kernel's `Unsubscribe` semantics).
-->
<script lang="ts">
  import { onMount } from 'svelte'
  import Shell from './Shell.svelte'
  import CommandPrompt from './components/CommandPrompt.svelte'
  import ThemeToggle from './components/ThemeToggle.svelte'
  import PluginManager from './components/PluginManager.svelte'
  import { ipc } from '../lib/ipc-client'
  import { events } from '../../shared/ipc-contract'
  import { panels } from '../lib/stores/panels.svelte'
  import { routes } from '../lib/stores/routes.svelte'
  import { theme } from '../lib/stores/theme.svelte'
  import { health } from '../lib/stores/health.svelte'
  import { resolveActivePanel } from '../lib/nav-link'
  import type { ThemeDto } from '../lib/bridge-types'

  let managingPlugins = $state(false)

  // Route drives which panel is active. The four loads start in parallel, so
  // neither store is guaranteed to arrive first: this effect re-resolves
  // whenever any input lands. It reads only routes.active / panels.items /
  // panels.loading and writes only activeId + notice, so it never re-triggers
  // itself.
  $effect(() => {
    const res = resolveActivePanel(routes.active, panels.items, !panels.loading)
    panels.applyResolution(res)
  })

  onMount(() => {
    void panels.load()
    void routes.load()
    void theme.load()
    void health.load()

    // Theme change event -> reapply theme (updates CSS variables).
    const offTheme = ipc.subscribe(events.themeChanged, (payload) => {
      theme.applyRemote(payload as ThemeDto)
    })
    // Any plugin state change can add contributions (Active) or reclaim them
    // (Stopped / Failed): re-pull unconditionally, because filtering by state
    // set would miss a late-arriving Active. Coalesced because a plugin-service
    // restart unloads and reloads every plugin, i.e. dozens of events in a row.
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleRefresh = (): void => {
      if (refreshTimer !== undefined) return
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined
        void panels.load()
        void routes.load()
        void health.load()
      }, 60)
    }
    const offPluginState = ipc.subscribe(
      events.pluginStateChanged,
      scheduleRefresh,
    )
    return () => {
      offTheme()
      offPluginState()
      if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    }
  })
</script>

<div class="app">
  <header class="topbar">
    <CommandPrompt />
    <button
      type="button"
      class:active={managingPlugins}
      aria-pressed={managingPlugins}
      onclick={() => (managingPlugins = !managingPlugins)}
    >
      Plugins
    </button>
    <ThemeToggle />
  </header>
  {#if managingPlugins}
    <PluginManager />
  {:else}
    <Shell />
  {/if}
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .topbar {
    display: flex;
    gap: var(--rem2-space-sm);
    align-items: center;
    padding: var(--rem2-space-sm) var(--rem2-space-md);
    border-bottom: 1px solid var(--rem2-color-border);
  }
  .topbar > button {
    padding: 6px 10px;
    border: 1px solid var(--rem2-color-border);
    border-radius: 4px;
    background: var(--rem2-color-surface);
    color: var(--rem2-color-text);
    font: inherit;
    cursor: pointer;
  }
  .topbar > button.active {
    border-color: var(--rem2-color-accent);
  }
</style>
