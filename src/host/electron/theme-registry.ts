/**
 * Theme registry implementation (host side).
 *
 * The shell never imports plugin sources: both sides depend only on the
 * kernel contract direction (`kernel/contracts/ui.js`).
 */

import type {
  ThemeDefinition,
  ThemeRegistry,
} from '../../kernel/contracts/ui.js'

/** In-memory theme registry: cache of the `ui.theme` slot plus the active id (selection is host state). */
export class ThemeRegistryImpl implements ThemeRegistry {
  private readonly themes = new Map<string, ThemeDefinition>()
  private activeId: string | undefined

  register(theme: ThemeDefinition): void {
    this.themes.set(theme.id, theme)
  }

  unregister(themeId: string): void {
    this.themes.delete(themeId)
    if (this.activeId === themeId) this.activeId = undefined
  }

  list(): ThemeDefinition[] {
    return Array.from(this.themes.values())
  }

  get(themeId: string): ThemeDefinition | undefined {
    return this.themes.get(themeId)
  }

  /** Switch the active theme; an unregistered id returns false (no throw, the caller reports it to the frontend). */
  activate(themeId: string): boolean {
    if (!this.themes.has(themeId)) return false
    this.activeId = themeId
    return true
  }

  active(): string | undefined {
    return this.activeId
  }
}
