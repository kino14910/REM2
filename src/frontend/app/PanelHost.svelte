<!--
  ui.panel slot: renders panels contributed via the `ui.panel` extension point.

  No plugin id appears in this file: the code is written once, plugins decide
  the content. Chrome (border, title bar, empty state) is owned by the host;
  plugins only provide declarative data.

  State priority is explicit (no blank screen, no silent fallback):
  active panel -> load error -> resolution notice -> loading -> empty.
-->
<script lang="ts">
  import PanelShell from './components/PanelShell.svelte'
  import { panels } from '../lib/stores/panels.svelte'
</script>

<section class="panel-host">
  {#if panels.active}
    <PanelShell panel={panels.active} />
  {:else if panels.error}
    <p class="empty error">{panels.error}</p>
  {:else if panels.notice}
    <p class="empty">{panels.notice}</p>
  {:else if panels.loading}
    <p class="empty">Loading…</p>
  {:else}
    <p class="empty">No panels available</p>
  {/if}
  {#if panels.issues.length > 0}
    <p class="issues">{panels.issues.length} panel entr(ies) dropped by validation</p>
  {/if}
</section>

<style>
  .empty {
    color: var(--rem2-color-text-muted);
    font-family: var(--rem2-font-mono);
  }
  .error {
    color: #ff6b6b;
  }
  .issues {
    color: var(--rem2-color-text-muted);
    font-size: 11px;
    margin: var(--rem2-space-xs) 0 0;
  }
</style>
