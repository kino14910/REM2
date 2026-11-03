<script lang="ts">
  import type { Snippet } from 'svelte'
  import { cn } from './cn'

  let {
    title,
    description,
    icon,
    action,
    class: className,
  }: {
    title: string
    description?: string
    /** Decorative glyph (emoji or short text). */
    icon?: string
    action?: Snippet
    class?: string
  } = $props()
</script>

<div
  class={cn(
    'flex flex-col items-center justify-center gap-2 px-6 py-10 text-center',
    className,
  )}
>
  {#if icon}
    <span class="text-2xl" aria-hidden="true">{icon}</span>
  {/if}
  <p class="text-sm font-semibold text-surface-950-50">{title}</p>
  {#if description}
    <p class="max-w-prose text-xs text-surface-600-400">{description}</p>
  {/if}
  {#if action}
    <div class="mt-2">{@render action()}</div>
  {/if}
</div>
