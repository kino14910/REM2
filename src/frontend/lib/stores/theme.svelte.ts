import { ipc } from '../ipc-client'
import { channels } from '../../../shared/ipc-contract'
import { applyTheme } from '../theme/vars'
import type { ThemeCatalogDto, ThemeDto } from '../bridge-types'

/**
 * Theme catalog + mode switch.
 *
 * The host owns selection (`ui.theme.list` ships `activeId`); this store mirrors it
 * and applies CSS variables optimistically on click so the switch does not wait for
 * an IPC round trip.
 */
class ThemeStore {
  list = $state<ThemeDto[]>([])
  activeId = $state<string | undefined>(undefined)
  error = $state<string | undefined>(undefined)

  active = $derived(this.list.find(t => t.id === this.activeId))
  light = $derived(this.list.find(t => t.mode === 'light'))
  dark = $derived(this.list.find(t => t.mode === 'dark'))
  /** A switch only makes sense when both modes are resident (e.g. the theme plugin is loaded). */
  canSwitchMode = $derived(this.light !== undefined && this.dark !== undefined)

  applyCatalog(catalog: ThemeCatalogDto): void {
    this.list = catalog.themes
    this.activeId = catalog.activeId
    this.error = undefined
    const active = this.list.find(t => t.id === catalog.activeId)
    if (active) applyTheme(active)
  }

  /** Apply a theme pushed by the host. No IPC write back: that is what caused a set→emit→set loop. */
  applyRemote(theme: ThemeDto): void {
    this.activeId = theme.id
    applyTheme(theme)
  }

  /** Theme switch: apply locally first, then notify the main process. */
  setActive(theme: ThemeDto): void {
    this.activeId = theme.id
    applyTheme(theme)
    void ipc.request<{ ok: boolean }>(channels.themeSet, { themeId: theme.id })
  }

  setMode(mode: 'light' | 'dark'): void {
    const target = this.list.find(t => t.mode === mode)
    if (target && target.id !== this.activeId) this.setActive(target)
  }

  async load(): Promise<void> {
    try {
      this.applyCatalog(await ipc.request<ThemeCatalogDto>(channels.themeList))
    } catch (e) {
      this.list = []
      this.error = (e as Error).message
    }
  }
}

export const theme = new ThemeStore()
