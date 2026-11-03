<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { CardPadding } from './types'
  import { cardPaddingClasses, surfaceClasses } from './variants'
  import { cn } from './cn'

  let {
    padding = 'md',
    class: className,
    children,
    ...rest
  }: {
    padding?: CardPadding
    class?: string
    children?: Snippet
  } = $props()
</script>

<div
  {...rest}
  class={cn(
    'card rounded-container shadow-sm',
    surfaceClasses,
    cardPaddingClasses[padding],
    className,
  )}
>
  {@render children?.()}
</div>
