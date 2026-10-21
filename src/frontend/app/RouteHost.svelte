<!--
  ui.route slot: nav items are derived from route declarations; handles
  navigation events.

  Like PanelHost, no plugin id appears here.
-->
<script lang="ts">
  import { routes } from '../lib/stores/routes.svelte'

  function onSelect(path: string): void {
    routes.navigate(path)
  }
</script>

<nav class="route-host">
  {#each routes.ordered as route (route.path)}
    <button
      type="button"
      class:active={route.path === routes.activePath}
      onclick={() => onSelect(route.path)}
    >
      {route.title}
    </button>
  {:else}
    <p class="empty">No routes available</p>
  {/each}
</nav>

<style>
  .route-host {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--rem2-space-sm);
  }
  button {
    text-align: left;
    padding: var(--rem2-space-xs) var(--rem2-space-sm);
    background: transparent;
    color: var(--rem2-color-text-muted);
    border: 0;
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
  }
  button.active {
    background: var(--rem2-color-surface);
    color: var(--rem2-color-text);
  }
  .empty {
    color: var(--rem2-color-text-muted);
    font-size: 12px;
    padding: var(--rem2-space-xs);
  }
</style>
