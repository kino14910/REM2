<!--
  Light/dark switch.

  Two sources of truth, in priority order:
    1. A host theme catalog (theme-switcher plugin): selection is persisted by
       the host through `ui.theme.set`, and the `System` option exists only when
       the catalog ships a follow-system entry.
    2. No catalog: the Skeleton theme is still fully light/dark capable, so the
       switch drives `data-mode` locally. The choice is persisted by the host
       (`settings.appearance.set`) and restored on the next start.
-->
<script lang="ts">
  import { theme } from '@/frontend/lib/stores/theme.svelte'
  import SegmentedControl from '@/frontend/lib/ui/SegmentedControl.svelte'
  import type { SegmentOption } from '@/frontend/lib/ui/types'

  /** Nothing to switch when a loaded catalog is single-mode. */
  const available = $derived(theme.canSwitchMode || theme.list.length === 0)

  const options = $derived<SegmentOption[]>(
    theme.canSwitchMode && !theme.system
      ? [
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ]
      : [
          { value: 'system', label: 'System' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ],
  )

  const mode = $derived(
    theme.canSwitchMode
      ? theme.active?.followSystem
        ? 'system'
        : (theme.active?.mode ?? '')
      : theme.colorMode,
  )

  function setMode(next: string): void {
    if (next === 'system') {
      if (theme.canSwitchMode && theme.system) {
        theme.setActive(theme.system)
        return
      }
      theme.setColorMode('system')
      return
    }
    if (next !== 'light' && next !== 'dark') return
    if (theme.canSwitchMode) {
      theme.setMode(next)
      return
    }
    theme.setColorMode(next)
  }
</script>

{#if available}
  <SegmentedControl
    value={mode}
    options={options}
    label="Color mode"
    size="sm"
    onValueChange={setMode}
  />
{/if}
