<script lang="ts">
  import type { HTMLSelectAttributes } from 'svelte/elements'
  import type { SelectOption } from './types'
  import { cn } from './cn'

  let {
    value = $bindable(''),
    options,
    class: className,
    ...rest
  }: Omit<HTMLSelectAttributes, 'value'> & {
    value?: string
    options: SelectOption[]
    class?: string
  } = $props()
</script>

<select {...rest} bind:value class={cn('select', className)}>
  {#each options as option (option.value)}
    <option value={option.value}>{option.label}</option>
  {/each}
</select>
