import { ipc } from '../ipc-client'
import { channels } from '../../../shared/ipc-contract'
import type { RouteDto } from '../bridge-types'
import { parseRouteList } from '../dto-guards'
import { panels } from './panels.svelte'

class RoutesStore {
  items = $state<RouteDto[]>([])
  activePath = $state<string | undefined>(undefined)
  error = $state<string | undefined>(undefined)

  ordered = $derived([...this.items].sort((a, b) => a.order - b.order))
  active = $derived(this.ordered.find(r => r.path === this.activePath))

  set(list: RouteDto[]): void {
    this.items = list
    // The active route may have disappeared with a plugin unload: fall back
    // to the first item (undefined for an empty list) instead of keeping a
    // dead selection.
    this.activePath = this.active?.path ?? list[0]?.path
    this.error = undefined
    this.syncPanels()
  }

  navigate(path: string): void {
    // Unknown route: explicit error, current view untouched (no silent jump).
    if (!this.ordered.some(r => r.path === path)) {
      this.error = `unknown route: ${path}`
      return
    }
    this.activePath = path
    this.syncPanels()
  }

  async load(): Promise<void> {
    try {
      const { items } = parseRouteList(
        await ipc.request<RouteDto[]>(channels.routeList),
      )
      this.set(items)
    } catch (e) {
      this.items = []
      this.error = (e as Error).message
    }
  }

  /** Routes are the single source of truth for which panel is active. */
  private syncPanels(): void {
    panels.setActive(this.active?.panelId)
  }
}

export const routes = new RoutesStore()
