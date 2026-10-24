/**
 * Route -> active panel resolution (pure function, unit-testable).
 *
 * The route is the single source of truth for which panel is active; this
 * module turns (active route, known panels, list readiness) into an explicit
 * resolution: either a panel id, or a notice explaining why nothing shows.
 */

import type { PanelDto, RouteDto } from './bridge-types.js'

export interface PanelResolution {
  panelId: string | undefined
  notice?: string
}

/**
 * Resolve which panel the active route selects.
 *
 * `panelsReady` (the panel list has finished loading) gates the
 * "not available" verdict: while the list is still in flight, a missing
 * panel is not yet a fact and must not flash an error.
 */
export function resolveActivePanel(
  route: RouteDto | undefined,
  panels: readonly PanelDto[],
  panelsReady: boolean,
): PanelResolution {
  if (!route) return { panelId: undefined }
  const target = route.panelId
  if (typeof target !== 'string' || target.length === 0) {
    return {
      panelId: undefined,
      notice: `route "${route.path}" has no panel association`,
    }
  }
  if (!panels.some(p => p.panelId === target)) {
    if (!panelsReady) return { panelId: undefined }
    return { panelId: undefined, notice: `panel "${target}" is not available` }
  }
  return { panelId: target }
}
