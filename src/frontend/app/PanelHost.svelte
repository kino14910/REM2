<!--
  ui.panel slot: renders panels contributed via the `ui.panel` extension point.

  No plugin id appears in this file: the code is written once, plugins decide
  the content. Chrome (border, title bar, empty state) is owned by the host;
  plugins only provide declarative data.
-->
<script lang="ts">
  import PanelShell from './components/PanelShell.svelte'
  import { panels } from '../lib/stores/panels.svelte'
</script>

<section class="panel-host">
  {#if panels.active}
    <PanelShell panel={panels.active} />
  {:else}
    <p class="empty">No panels available</p>
  {/if}
</section>

<style>
  .empty {
    color: var(--rem2-color-text-muted);
    font-family: var(--rem2-font-mono);
  }
</style>
