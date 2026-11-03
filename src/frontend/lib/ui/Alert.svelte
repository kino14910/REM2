<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { AlertTone } from './types'
  import { alertToneClasses } from './variants'
  import { cn } from './cn'

  let {
    tone = 'info',
    title,
    class: className,
    children,
    actions,
  }: {
    tone?: AlertTone
    title?: string
    class?: string
    children?: Snippet
    /** Right-aligned inline actions (buttons). */
    actions?: Snippet
  } = $props()
</script>

<!-- Errors are announced immediately; everything else is a status update. -->
<div
  role={tone === 'error' ? 'alert' : 'status'}
  class={cn(
    'flex items-start gap-3 rounded-base px-4 py-3 text-sm',
    alertToneClasses[tone],
    className,
  )}
>
  <div class="min-w-0 flex-1 space-y-1">
    {#if title}<p class="font-semibold">{title}</p>{/if}
    {@render children?.()}
  </div>
  {#if actions}
    <div class="flex shrink-0 items-center gap-2">{@render actions()}</div>
  {/if}
</div>
