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
  import { ipc } from '../lib/ipc-client'
  import { events } from '../../shared/ipc-contract'
  import { panels } from '../lib/stores/panels.svelte'
  import { routes } from '../lib/stores/routes.svelte'
  import { theme } from '../lib/stores/theme.svelte'
  import { health } from '../lib/stores/health.svelte'
  import { resolveActivePanel } from '../lib/nav-link'
  import type { ThemeDto } from '../lib/bridge-types'

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
    // set would miss a late-arriving Active.
    const offPluginState = ipc.subscribe(events.pluginStateChanged, () => {
      void panels.load()
      void routes.load()
      void health.load()
    })
    return () => {
      offTheme()
      offPluginState()
    }
  })
</script>

<div class="app">
  <header class="topbar">
    <CommandPrompt />
    <ThemeToggle />
  </header>
  <Shell />
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
</style>
