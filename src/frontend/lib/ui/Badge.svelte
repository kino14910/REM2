<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { BadgeTone } from './types'
  import { badgeToneClasses } from './variants'
  import { cn } from './cn'

  let {
    tone = 'neutral',
    class: className,
    children,
  }: { tone?: BadgeTone; class?: string; children?: Snippet } = $props()
</script>

<span class={cn('badge', badgeToneClasses[tone], className)}>
  {@render children?.()}
</span>
