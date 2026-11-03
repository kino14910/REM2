<script lang="ts">
  import { DropdownMenu } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import type { MenuItem } from './types'
  import { cn } from './cn'

  let {
    items,
    triggerLabel,
    align = 'end',
    class: className,
    trigger,
  }: {
    items: MenuItem[]
    /** Accessible name for the icon trigger. */
    triggerLabel: string
    align?: 'start' | 'center' | 'end'
    class?: string
    /** Trigger content (icon and optional dot); the button chrome is owned by the kit. */
    trigger: Snippet
  } = $props()
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    aria-label={triggerLabel}
    title={triggerLabel}
    class={cn(
      'btn-icon btn-icon-base relative text-surface-600-400 data-[state=open]:preset-tonal hover:preset-tonal hover:text-surface-950-50',
      className,
    )}
  >
    {@render trigger()}
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      {align}
      sideOffset={6}
      class="z-50 min-w-52 rounded-container border border-surface-200-800 bg-surface-100-900 p-1 shadow-2xl"
    >
      {#each items as item (item.label)}
        <DropdownMenu.Item
          disabled={item.disabled}
          onSelect={() => item.onSelect()}
          class="flex w-full cursor-default items-center justify-between gap-6 rounded-base px-3 py-2 text-left text-sm text-surface-950-50 outline-none data-[disabled]:opacity-50 data-[highlighted]:preset-tonal"
        >
          <span>{item.label}</span>
          {#if item.detail}
            <span class="badge preset-filled-brand">{item.detail}</span>
          {/if}
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
