<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { HTMLButtonAttributes } from 'svelte/elements'
  import type { ButtonSize, ButtonVariant } from './types'
  import { buttonSizeClasses, buttonVariantClasses } from './variants'
  import { cn } from './cn'
  import Spinner from './Spinner.svelte'

  let {
    variant = 'primary',
    size = 'base',
    loading = false,
    loadingLabel,
    type = 'button',
    class: className,
    children,
    ...rest
  }: {
    variant?: ButtonVariant
    size?: ButtonSize
    /** Disables the button and swaps the label for a spinner. */
    loading?: boolean
    loadingLabel?: string
    class?: string
    children?: Snippet
  } & Omit<HTMLButtonAttributes, 'class' | 'children'> = $props()
</script>

<button
  {...rest}
  {type}
  disabled={Boolean(rest.disabled) || loading}
  aria-busy={loading || undefined}
  class={cn(
    'btn',
    buttonSizeClasses[size],
    buttonVariantClasses[variant],
    className,
  )}
>
  {#if loading}
    <Spinner />
    <span>{loadingLabel ?? 'Working…'}</span>
  {:else}
    {@render children?.()}
  {/if}
</button>
