/**
 * The filename MUST end with `.svelte.ts`: `$state` / `$derived` are recognized
 * at compile time; in a plain `.ts` they silently have no effect.
 */

import { ipc } from '../ipc-client'
import { channels } from '../../../shared/ipc-contract'
import type { PanelDto } from '../bridge-types'

class PanelsStore {
  items = $state<PanelDto[]>([])
  activeId = $state<string | undefined>(undefined)
  loading = $state<boolean>(false)
  error = $state<string | undefined>(undefined)

  /** Sort once in the derived value, not in the template. */
  ordered = $derived([...this.items].sort((a, b) => a.order - b.order))
  active = $derived(
    this.ordered.find(p => p.panelId === this.activeId) ?? this.ordered[0],
  )

  set(list: PanelDto[]): void {
    this.items = list
    this.loading = false
    this.error = undefined
  }

  setActive(id: string | undefined): void {
    this.activeId = id
  }

  /** Initial load; on failure degrade to empty without blocking render. */
  async load(): Promise<void> {
    this.loading = true
    try {
      this.set(await ipc.request<PanelDto[]>(channels.panelList))
    } catch (e) {
      this.items = []
      this.loading = false
      this.error = (e as Error).message
    }
  }
}

export const panels = new PanelsStore()
