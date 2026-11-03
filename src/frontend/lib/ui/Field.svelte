<script lang="ts">
  import type { Snippet } from 'svelte'
  import { cn } from './cn'

  let {
    label,
    forId,
    hint,
    error,
    class: className,
    children,
  }: {
    label: string
    /** Id of the control the label points at. */
    forId?: string
    hint?: string
    error?: string
    class?: string
    children?: Snippet
  } = $props()
</script>

<label class={cn('label', className)} for={forId}>
  <span class="label-text">{label}</span>
  {@render children?.()}
  {#if error}
    <span class="text-xs text-error-500">{error}</span>
  {:else if hint}
    <span class="text-xs text-surface-600-400">{hint}</span>
  {/if}
</label>
