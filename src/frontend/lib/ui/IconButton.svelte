<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { HTMLButtonAttributes } from 'svelte/elements'
  import type { ButtonSize } from './types'
  import {
    iconButtonSizeClasses,
    iconButtonVariantClasses,
  } from './variants'
  import { cn } from './cn'

  let {
    label,
    variant = 'ghost',
    size = 'base',
    type = 'button',
    class: className,
    children,
    ...rest
  }: {
    /** Accessible name; icon-only buttons have no text content. */
    label: string
    variant?: keyof typeof iconButtonVariantClasses
    size?: ButtonSize
    class?: string
    children?: Snippet
  } & Omit<HTMLButtonAttributes, 'class' | 'children' | 'aria-label'> = $props()
</script>

<button
  {...rest}
  {type}
  aria-label={label}
  title={rest.title ?? label}
  class={cn(
    'btn-icon',
    iconButtonSizeClasses[size],
    iconButtonVariantClasses[variant],
    className,
  )}
>
  {@render children?.()}
</button>
