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
  import type { ThemeDto } from '../lib/bridge-types'

  onMount(() => {
    void panels.load()
    void routes.load()
    void theme.load()
    void health.load()

    // Theme change event -> reapply theme (updates CSS variables).
    const offTheme = ipc.subscribe(events.themeChanged, (payload) => {
      theme.applyRemote(payload as ThemeDto)
    })
    return () => {
      offTheme()
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
