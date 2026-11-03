<!--
  ui.route slot: nav items are derived from route declarations; handles
  navigation events.

  Like PanelHost, no plugin id appears here.
-->
<script lang="ts">
  import { routes } from '@/frontend/lib/stores/routes.svelte'
  import Button from '@/frontend/lib/ui/Button.svelte'

  function onSelect(path: string): void {
    routes.navigate(path)
  }
</script>

<nav class="flex flex-col gap-1 p-2" aria-label="Routes">
  {#if routes.error}
    <p class="px-3 py-2 text-xs text-error-500">{routes.error}</p>
  {/if}
  {#each routes.ordered as route (route.path)}
    <Button
      variant={route.path === routes.activePath ? 'tonal' : 'ghost'}
      size="sm"
      class="w-full justify-start"
      aria-current={route.path === routes.activePath ? 'page' : undefined}
      onclick={() => onSelect(route.path)}
    >
      {route.title}
    </Button>
  {:else}
    <p class="px-3 py-2 text-xs text-surface-600-400">No routes available</p>
  {/each}
</nav>
