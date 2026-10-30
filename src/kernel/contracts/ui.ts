/**
 * UI extension point contracts.
 *
 * Rationale for living in the kernel: themes, panels, and routes are kernel
 * contracts, not one plugin's private types. Host and plugins both depend only on
 * kernel/contracts/ui.js, which removes the shell's out-of-bounds import of plugin
 * source code.
 *
 * Shape decision: ui.panel / ui.route are declarative descriptions. Plugins do not
 * provide Svelte components; the frontend PanelHost.svelte / RouteHost.svelte render
 * the chrome.
 *
 * Shape decision: `ui.theme` is a multi slot = a theme *catalog*, not "the active
 * theme". Switching between light and dark needs both token sets to be resident at
 * the same time, so existence is a contribution and selection is host UI state
 * (`ThemeRegistry.active()`). Contribution ids are theme ids, so the kernel's
 * multi-slot duplicate check already forbids two themes claiming the same id.
 */

/**
 * Light/dark classification of a token set.
 *
 * The kernel never interprets it: the shell uses it to pair one theme per mode into
 * a light/dark switch and to set the CSS `color-scheme`.
 */
export type ThemeMode = 'light' | 'dark' | 'system'

export interface ThemeDefinition {
  readonly id: string
  /** Mode this token set represents. A system entry is materialized to light/dark by the host. */
  readonly mode: ThemeMode
  readonly colors: Readonly<Record<string, string>>
  readonly fonts: Readonly<Record<string, string>>
  readonly spacing: Readonly<Record<string, string>>
  /** Resolve this entry from the current OS palette while preserving its own id and accent. */
  readonly followSystem?: boolean
}

export interface PanelFormOption {
  readonly value: string
  readonly label: string
}

/** Declarative form field rendered by the generic PanelShell. */
export interface PanelFormField {
  readonly id: string
  readonly label: string
  readonly type: 'select' | 'color'
  readonly value: string
  readonly options?: readonly PanelFormOption[]
}

export interface PanelFormData {
  readonly kind: 'form'
  readonly fields: readonly PanelFormField[]
}

/**
 * Theme catalog + active selection (provided by the host as the default `ui.theme` implementation).
 *
 * It is a cache of the extension slot plus the "which one is applied" state: the slot
 * is the single source of truth for existence, this registry for selection.
 */
export interface ThemeRegistry {
  register(theme: ThemeDefinition): void
  unregister(themeId: string): void
  list(): ThemeDefinition[]
  get(themeId: string): ThemeDefinition | undefined
  activate(themeId: string): boolean
  /** Id of the currently active theme (undefined when none is active). */
  active(): string | undefined
}

export type PanelRegion = 'main' | 'side'

/**
 * Declarative panel description.
 *
 * `command` is the data source: when the frontend requests a panel's data, the main
 * process routes that command over the event bus and the plugin decides the response
 * shape itself (the kernel does not validate it).
 */
export interface PanelContribution {
  readonly panelId: string
  readonly title: string
  readonly icon: string
  readonly region: PanelRegion
  /** Sort weight, ascending. */
  readonly order: number
  /** Name of the command that provides this panel's data (via the event bus `bus.request`). */
  readonly command: string
}

export interface RouteContribution {
  readonly path: string
  readonly title: string
  /** Id of the associated panel (the frontend switches the main region accordingly). */
  readonly panelId: string
  /** Command prefix (the prefix allowed for commands under this route). */
  readonly commandPrefix: string
  readonly order: number
}
