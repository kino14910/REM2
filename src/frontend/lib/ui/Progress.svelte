<script lang="ts">
  import { cn } from './cn'

  let {
    value,
    label,
    detail,
    class: className,
  }: {
    /** 0–100. `undefined` renders an indeterminate bar (no known total). */
    value?: number
    label?: string
    detail?: string
    class?: string
  } = $props()

  const percent = $derived(
    value === undefined ? undefined : Math.min(100, Math.max(0, value)),
  )
</script>

<div class={cn('space-y-2', className)}>
  {#if label || detail}
    <div class="flex items-center justify-between gap-4 text-xs text-surface-600-400">
      <span>{label}</span>
      <span class="font-mono">{detail}</span>
    </div>
  {/if}
  <div
    class="h-2 w-full overflow-hidden rounded-base bg-surface-200-800"
    role="progressbar"
    aria-label={label ?? 'Progress'}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={percent === undefined ? undefined : Math.round(percent)}
  >
    {#if percent === undefined}
      <div
        class="h-full w-1/2 rounded-base bg-brand-light animate-progress-linear-indeterminate-horizontal dark:bg-brand-dark"
      ></div>
    {:else}
      <div
        class="h-full rounded-base bg-brand-light transition-[width] duration-150 dark:bg-brand-dark"
        style:width={`${percent}%`}
      ></div>
    {/if}
  </div>
</div>
