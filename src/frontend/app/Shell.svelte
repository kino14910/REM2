<script lang="ts">
  import RouteHost from './RouteHost.svelte'
  import PanelHost from './PanelHost.svelte'
  import HealthBadge from './components/HealthBadge.svelte'
</script>

<div class="shell">
  <aside class="side">
    <RouteHost />
  </aside>
  <main class="main">
    <PanelHost />
  </main>
  <footer class="statusbar">
    <HealthBadge />
  </footer>
</div>

<style>
  .shell {
    display: grid;
    grid-template-columns: 200px 1fr;
    grid-template-rows: 1fr auto;
    flex: 1;
    min-height: 0;
  }
  .side {
    border-right: 1px solid var(--rem2-color-border);
    overflow-y: auto;
  }
  .main {
    min-height: 0;
    overflow: auto;
    padding: var(--rem2-space-md);
  }
  .statusbar {
    grid-column: 1 / -1;
    border-top: 1px solid var(--rem2-color-border);
    padding: var(--rem2-space-xs) var(--rem2-space-md);
  }
</style>
