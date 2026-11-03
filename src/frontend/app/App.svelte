<!--
  Root component: first-paint orchestration.

  Four data sets are loaded in parallel, each degrading to empty on failure
  (never blocking render); the unsubscribe functions for event subscriptions
  are returned from `onMount` so the runtime cleans them up on destroy
  (matching the kernel's `Unsubscribe` semantics).
-->
<script lang="ts">
  import { onMount } from 'svelte'
  import type { Component } from 'svelte'
  import Shell from './Shell.svelte'
  import TitleBar from './components/TitleBar.svelte'
  import CommandPrompt from './components/CommandPrompt.svelte'
  import PluginManager from './components/PluginManager.svelte'
  import SettingsView from './components/SettingsView.svelte'
  import { Navigation } from '@skeletonlabs/skeleton-svelte'
  import { Terminal, Blocks, Settings } from '@lucide/svelte'
  import type { LucideProps } from '@lucide/svelte'
  import { ipc } from '@/frontend/lib/ipc-client'
  import { events } from '@/shared/ipc-contract'
  import { panels } from '@/frontend/lib/stores/panels.svelte'
  import { routes } from '@/frontend/lib/stores/routes.svelte'
  import { theme } from '@/frontend/lib/stores/theme.svelte'
  import { health } from '@/frontend/lib/stores/health.svelte'
  import { resolveActivePanel } from '@/frontend/lib/nav-link'
  import { initThemeMode } from '@/frontend/lib/theme/vars'
  import type { ThemeDto } from '@/frontend/lib/bridge-types'

  type View = 'main' | 'plugins' | 'settings'

  let view = $state<View>('main')

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
    // Start from the OS preference; a theme pushed by the host overrides it.
    initThemeMode()
    void panels.load()
    void routes.load()
    void theme.load()
    void health.load()

    // Theme change event -> reapply theme (updates CSS variables and mode).
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

{#snippet railTrigger(
  target: View,
  label: string,
  Icon: Component<LucideProps>,
)}
  <Navigation.Trigger
    aria-label={label}
    title={label}
    aria-current={view === target ? 'page' : undefined}
    class="cursor-pointer p-0.75 hover:text-surface-700-300 
    {view === target
      ? 'text-surface-700-300 bg-surface-300-700 hover:filter-none'
      : 'text-surface-500'}"
    onclick={() => (view = target)}
  >
    <Icon size={24} class="size-6" />
  </Navigation.Trigger>
{/snippet}

<div class="flex h-screen flex-col bg-surface-50-950 text-surface-950-50">
  <TitleBar />
  <div class="flex min-h-0 flex-1">
    <Navigation
      layout="rail"
      role="navigation"
      aria-label="Workspace view"
      class="shrink-0 border-r border-surface-200-800 max-w-12 p-1"
    >
      <Navigation.Content>
        <Navigation.Menu>
          {@render railTrigger('main', 'Console', Terminal)}
          {@render railTrigger('plugins', 'Plugins', Blocks)}
        </Navigation.Menu>
      </Navigation.Content>
      <Navigation.Footer>
        {@render railTrigger('settings', 'Settings', Settings)}
      </Navigation.Footer>
    </Navigation>
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <header
        class="flex flex-wrap items-center gap-2 border-b border-surface-200-800 px-4 py-2"
      >
        <CommandPrompt />
      </header>
      {#if view === 'plugins'}
        <PluginManager />
      {:else if view === 'settings'}
        <SettingsView />
      {:else}
        <Shell />
      {/if}
    </div>
  </div>
</div>
