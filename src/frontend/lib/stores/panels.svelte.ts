/**
 * The filename MUST end with `.svelte.ts`: `$state` / `$derived` are recognized
 * at compile time; in a plain `.ts` they silently have no effect.
 */

import { ipc } from '../ipc-client'
import { channels } from '../../../shared/ipc-contract'
import type { PanelDto } from '../bridge-types'
import { parsePanelList } from '../dto-guards'
import type { PanelResolution } from '../nav-link'

class PanelsStore {
  items = $state<PanelDto[]>([])
  activeId = $state<string | undefined>(undefined)
  loading = $state<boolean>(false)
  error = $state<string | undefined>(undefined)
  /** Why no panel is active (route without association / panel unavailable). */
  notice = $state<string | undefined>(undefined)
  /** Validation issues from the last load (dropped entries, never rendered). */
  issues = $state<string[]>([])

  /** Sort once in the derived value, not in the template. */
  ordered = $derived([...this.items].sort((a, b) => a.order - b.order))
  /**
   * No silent fallback to the first panel: an unknown active id must surface
   * as an explicit empty state, not quietly render a different panel.
   */
  active = $derived(
    this.activeId === undefined
      ? undefined
      : this.ordered.find(p => p.panelId === this.activeId),
  )

  /** Applies a route-driven resolution (active id + optional notice). */
  applyResolution(res: PanelResolution): void {
    this.activeId = res.panelId
    this.notice = res.notice
  }

  setActive(id: string | undefined): void {
    this.activeId = id
  }

  /** Initial load; on failure degrade to empty without blocking render. */
  async load(): Promise<void> {
    this.loading = true
    try {
      const { items, issues } = parsePanelList(
        await ipc.request<PanelDto[]>(channels.panelList),
      )
      this.items = items
      this.issues = issues
      this.error = undefined
    } catch (e) {
      this.items = []
      this.issues = []
      this.error = (e as Error).message
    } finally {
      this.loading = false
    }
  }
}

export const panels = new PanelsStore()
