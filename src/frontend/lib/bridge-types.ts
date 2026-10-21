/**
 * Frontend DTOs: an explicit projection of the kernel contracts.
 *
 * Why DTOs instead of kernel types directly: kernel `PluginInfo` /
 * `LoadedPlugin` / `HealthReport` carry internal fields (container,
 * permissions, absolute paths). The DTOs are an explicit whitelist that
 * projects only the necessary fields, so future kernel fields do not
 * automatically leak to the renderer.
 *
 * Each type's comment marks the kernel contract it corresponds to.
 */

/** Panel DTO, projected from `PanelContribution` in `kernel/contracts/ui.ts`. */
export interface PanelDto {
  panelId: string
  title: string
  icon: string
  region: 'main' | 'side'
  /** Sort weight, ascending. */
  order: number
  /** Name of the command that provides this panel's data. */
  command: string
}

/** Route DTO, projected from `RouteContribution` in `kernel/contracts/ui.ts`. */
export interface RouteDto {
  path: string
  title: string
  panelId: string
  commandPrefix: string
  order: number
}

/** Theme DTO, projected from `ThemeDefinition` in `kernel/contracts/ui.ts`. */
export interface ThemeDto {
  id: string
  /** Light/dark classification; drives the mode switch and the CSS `color-scheme`. */
  mode: 'light' | 'dark'
  colors: Record<string, string>
  fonts: Record<string, string>
  spacing: Record<string, string>
}

/**
 * Theme catalog DTO (return shape of `ui.theme.list`).
 *
 * `activeId` comes from the host instead of being derived on the renderer: the host
 * owns selection, and deriving it twice (e.g. "prefer dark") would make the applied
 * theme depend on which side guessed last.
 */
export interface ThemeCatalogDto {
  themes: ThemeDto[]
  activeId?: string
}

/** Health DTO, projected from `HealthReport` in `kernel/contracts/health.ts` (trimmed). */
export interface HealthDto {
  status: 'healthy' | 'degraded' | 'unhealthy'
  plugins: Array<{
    id: string
    state: string
    status: 'healthy' | 'degraded' | 'unhealthy'
    message?: string
  }>
}

/**
 * Command result DTO (the unified shape between frontend and main process).
 *
 * Field names must match what command plugins actually return: IpcBridge's
 * `reply({ok, result})` puts the plugin's return value into `result` as-is,
 * and preload unwraps `payload.result`, so the frontend `invoke` receives
 * the plugin's original return object itself.
 * This was once written as `{ok, result, error}` while plugins returned
 * `{ok, output}`: `res.result` was always undefined, the UI could only
 * show "ok", and nothing errored.
 */
export interface CommandResultDto {
  command: string
  ok: boolean
  output?: string
  error?: string
}

export interface PluginStateChangedDto {
  pluginId: string
  /** Logical state machine value (`PluginStateT` in `kernel/contracts/plugins.ts`). */
  state: string
}
