<script lang="ts">
  import { RadioGroup } from 'bits-ui'
  import type { SegmentOption } from './types'
  import { cn } from './cn'

  let {
    value = $bindable(''),
    options,
    label,
    size = 'base',
    class: className,
    onValueChange,
  }: {
    /** Selected option value; bindable so the parent owns the state. */
    value?: string
    options: SegmentOption[]
    /** Accessible name for the whole group. */
    label: string
    size?: 'sm' | 'base'
    class?: string
    onValueChange?: (value: string) => void
  } = $props()

  const sizeClass = $derived(size === 'sm' ? 'btn-sm' : 'btn-base')
</script>

<!--
  Radio semantics, not toggle buttons: a segmented control always has exactly
  one active option, so clicking the active one must not deselect it.
-->
<RadioGroup.Root
  bind:value
  orientation="horizontal"
  aria-label={label}
  class={cn(
    'inline-flex items-center gap-1 rounded-base border border-surface-200-800 bg-surface-100-900 p-1',
    className,
  )}
  {onValueChange}
>
  {#each options as option (option.value)}
    <RadioGroup.Item
      value={option.value}
      aria-label={option.icon ? option.label : undefined}
      class={cn(
        'btn justify-center bg-transparent text-surface-600-400 hover:text-surface-950-50 data-[state=checked]:preset-filled-brand',
        sizeClass,
      )}
    >
      {#if option.icon}
        {@render option.icon()}
      {:else}
        {option.label}
      {/if}
    </RadioGroup.Item>
  {/each}
</RadioGroup.Root>
