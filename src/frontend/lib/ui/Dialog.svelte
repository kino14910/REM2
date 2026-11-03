<script lang="ts">
  import { Dialog as BitsDialog } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import type { DialogSize } from './types'
  import { dialogSizeClasses } from './variants'
  import { cn } from './cn'

  let {
    open = $bindable(false),
    title,
    description,
    size = 'md',
    closeable = true,
    class: className,
    children,
    footer,
    onOpenChange,
  }: {
    /** Bindable so parents can use `bind:open` or observe closes from Escape/backdrop. */
    open?: boolean
    title: string
    description?: string
    size?: DialogSize
    /** When false, Escape and backdrop dismissal are ignored (e.g. while an operation is running). */
    closeable?: boolean
    class?: string
    children?: Snippet
    footer?: Snippet
    onOpenChange?: (open: boolean) => void
  } = $props()
</script>

<!--
  Bits UI owns the hard parts: focus trap, Escape/backdrop dismissal, scroll
  lock and aria wiring (Title/Description ids). The kit only supplies chrome.
-->
<BitsDialog.Root
  {open}
  onOpenChange={(next) => {
    open = next
    onOpenChange?.(next)
  }}
>
  <BitsDialog.Portal>
    <BitsDialog.Overlay class="fixed inset-0 z-40 bg-surface-950/70" />
    <BitsDialog.Content
      escapeKeydownBehavior={closeable ? 'close' : 'ignore'}
      interactOutsideBehavior={closeable ? 'close' : 'ignore'}
      class={cn(
        'fixed left-1/2 top-1/2 z-50 max-h-[85vh] -translate-x-1/2 -translate-y-1/2',
        'overflow-y-auto rounded-container border border-surface-200-800 bg-surface-100-900 p-6 text-surface-950-50 shadow-2xl',
        'flex flex-col gap-4',
        dialogSizeClasses[size],
        className,
      )}
    >
      <header class="flex items-start justify-between gap-4">
        <div class="space-y-1">
          <BitsDialog.Title class="text-lg font-semibold">{title}</BitsDialog.Title>
          {#if description}
            <BitsDialog.Description class="text-xs text-surface-600-400">
              {description}
            </BitsDialog.Description>
          {/if}
        </div>
        {#if closeable}
          <BitsDialog.Close
            class="btn-icon btn-icon-sm preset-tonal shrink-0"
            aria-label="Close"
          >
            <svg
              viewBox="0 0 16 16"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </BitsDialog.Close>
        {/if}
      </header>

      {@render children?.()}

      {#if footer}
        <footer class="flex flex-wrap items-center justify-end gap-2 border-t border-surface-200-800 pt-4">
          {@render footer()}
        </footer>
      {/if}
    </BitsDialog.Content>
  </BitsDialog.Portal>
</BitsDialog.Root>
