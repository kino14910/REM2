<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements'
  import { cn } from './cn'

  let {
    value = $bindable(''),
    class: className,
    ...rest
  }: Omit<HTMLInputAttributes, 'value'> & {
    /** Bindable so callers can use `bind:value`; the native input stays the source of truth. */
    value?: string
    class?: string
  } = $props()
</script>

<input {...rest} bind:value class={cn('input', className)} />
