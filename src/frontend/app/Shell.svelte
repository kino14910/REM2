<script lang="ts">
  import RouteHost from './RouteHost.svelte'
  import PanelHost from './PanelHost.svelte'
  import HealthBadge from './components/HealthBadge.svelte'
</script>

<div class="grid min-h-0 flex-1 grid-cols-[14rem_1fr] grid-rows-[1fr_auto]">
  <aside class="overflow-y-auto border-r border-surface-200-800">
    <RouteHost />
  </aside>
  <main class="min-h-0 overflow-auto p-4">
    <PanelHost />
  </main>
  <footer
    class="col-span-full border-t border-surface-200-800 px-4 py-1"
  >
    <HealthBadge />
  </footer>
</div>
