<!--
  ui.route 插槽：由 route 声明派生导航项，处理导航事件。

  同 PanelHost：这里不出现任何插件 id。
-->
<script lang="ts">
  import { routes } from '../lib/stores/routes.svelte';

  function onSelect(path: string): void {
    routes.navigate(path);
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
    <p class="empty">暂无路由</p>
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
