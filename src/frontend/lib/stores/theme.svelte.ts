import { ipc } from '@/frontend/lib/ipc-client'
import { channels } from '@/shared/ipc-contract'
import type { AppearanceSettingsDto } from '@/shared/ipc-contract'
import { applyColorMode, applyTheme } from '@/frontend/lib/theme/vars'
import type { ColorMode } from '@/frontend/lib/theme/vars'
import { parseAppearanceSettings } from '@/frontend/lib/dto-guards'
import type { ThemeCatalogDto, ThemeDto } from '@/frontend/lib/bridge-types'

/** Follow-system entries stay `system` even after the host materializes their palette. */
function colorModeOf(theme: ThemeDto): ColorMode {
  return theme.followSystem === true || theme.mode === 'system'
    ? 'system'
    : theme.mode
}

/**
 * Theme catalog + mode switch.
 *
 * The host owns selection (`ui.theme.list` ships `activeId`); this store mirrors it
 * and applies CSS variables optimistically on click so the switch does not wait for
 * an IPC round trip.
 *
 * `colorMode` is the persisted host preference: it drives `data-mode` while no
 * catalog is loaded, and mirrors the active theme whenever one is.
 */
class ThemeStore {
  list = $state<ThemeDto[]>([])
  activeId = $state<string | undefined>(undefined)
  colorMode = $state<ColorMode>('system')
  error = $state<string | undefined>(undefined)

  active = $derived(this.list.find(t => t.id === this.activeId))
  light = $derived(this.list.find(t => t.mode === 'light'))
  dark = $derived(this.list.find(t => t.id === 'dark' || t.mode === 'dark'))
  system = $derived(this.list.find(t => t.followSystem))
  /** A switch only makes sense when both modes are resident (e.g. the theme plugin is loaded). */
  canSwitchMode = $derived(this.light !== undefined && this.dark !== undefined)

  applyCatalog(catalog: ThemeCatalogDto): void {
    this.list = catalog.themes
    this.activeId = catalog.activeId
    this.error = undefined
    const active = this.list.find(t => t.id === catalog.activeId)
    if (!active) return
    this.colorMode = colorModeOf(active)
    applyTheme(active)
  }

  /** Apply a theme pushed by the host. No IPC write back: that is what caused a set→emit→set loop. */
  applyRemote(theme: ThemeDto): void {
    this.activeId = theme.id
    this.colorMode = colorModeOf(theme)
    applyTheme(theme)
  }

  /** Theme switch: apply locally first, then notify the main process. */
  setActive(theme: ThemeDto): void {
    this.activeId = theme.id
    this.colorMode = colorModeOf(theme)
    applyTheme(theme)
    void ipc.request<{ ok: boolean }>(channels.themeSet, { themeId: theme.id })
  }

  setMode(mode: ThemeDto['mode']): void {
    const target = this.list.find(t => t.mode === mode)
    if (target && target.id !== this.activeId) this.setActive(target)
  }

  /** Apply and persist the color mode used when no theme catalog is loaded. */
  setColorMode(mode: ColorMode): void {
    this.colorMode = mode
    applyColorMode(mode)
    void ipc
      .request<AppearanceSettingsDto>(channels.settingsAppearanceSet, {
        colorMode: mode,
      })
      .catch(error => {
        this.error = error instanceof Error ? error.message : String(error)
      })
  }

  async load(): Promise<void> {
    try {
      const catalog = await ipc.request<ThemeCatalogDto>(channels.themeList)
      this.applyCatalog(catalog)
      // No catalog: `data-mode` is driven locally, so restore the mode the host
      // persisted from the previous run instead of always starting at `system`.
      if (catalog.themes.length === 0) await this.loadColorMode()
    } catch (e) {
      this.list = []
      this.error = (e as Error).message
    }
  }

  private async loadColorMode(): Promise<void> {
    try {
      const settings = parseAppearanceSettings(
        await ipc.request<AppearanceSettingsDto>(
          channels.settingsAppearanceGet,
        ),
      )
      this.colorMode = settings.colorMode
      applyColorMode(settings.colorMode)
    } catch {
      // Host without appearance settings: keep following the OS (initThemeMode).
    }
  }
}

export const theme = new ThemeStore()
