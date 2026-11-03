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
  import { panels } from '@/frontend/lib/stores/panels.svelte'
  import Alert from '@/frontend/lib/ui/Alert.svelte'
  import EmptyState from '@/frontend/lib/ui/EmptyState.svelte'
  import Spinner from '@/frontend/lib/ui/Spinner.svelte'
</script>

<section class="flex flex-col gap-3">
  {#if panels.active}
    <PanelShell panel={panels.active} />
  {:else if panels.error}
    <Alert tone="error">{panels.error}</Alert>
  {:else if panels.notice}
    <Alert tone="info">{panels.notice}</Alert>
  {:else if panels.loading}
    <div class="flex items-center gap-2 text-sm text-surface-600-400">
      <Spinner />
      <span>Loading panels…</span>
    </div>
  {:else}
    <EmptyState
      title="No panels available"
      description="Load a plugin that contributes a ui.panel entry to see it here."
    />
  {/if}
  {#if panels.issues.length > 0}
    <p class="text-xs text-surface-600-400">
      {panels.issues.length} panel entr(ies) dropped by validation
    </p>
  {/if}
</section>
