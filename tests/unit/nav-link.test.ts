/**
 * Unit test: route -> active panel resolution (`src/frontend/lib/nav-link.ts`).
 *
 * Rationale: the route is the single source of truth for which panel is
 * active. A missing panel must produce an explicit notice (never a silent
 * blank the user cannot explain), except while the panel list is still in
 * flight - a "not available" verdict before the list has loaded would flash an
 * error on every cold start.
 */

import { describe, expect, it } from 'vitest'
import { resolveActivePanel } from '../../src/frontend/lib/nav-link.js'
import type { PanelDto, RouteDto } from '../../src/frontend/lib/bridge-types.js'

function panel(panelId: string): PanelDto {
  return {
    panelId,
    title: panelId,
    icon: '▦',
    region: 'main',
    order: 10,
    command: `${panelId}.data`,
  }
}

function route(panelId: string): RouteDto {
  return {
    path: `/${panelId || 'root'}`,
    title: panelId || 'root',
    panelId,
    commandPrefix: '',
    order: 10,
  }
}

describe('unit · nav-link · resolveActivePanel', () => {
  it('no route resolves to no panel and no notice', () => {
    expect(resolveActivePanel(undefined, [panel('a')], true)).toEqual({
      panelId: undefined,
    })
  })

  it('a route without panel association surfaces a notice (not a silent blank)', () => {
    const res = resolveActivePanel(route(''), [panel('a')], true)
    expect(res.panelId).toBeUndefined()
    expect(res.notice).toMatch(/no panel association/)
  })

  it('an unknown panel with a ready list surfaces an availability notice', () => {
    const res = resolveActivePanel(route('missing'), [panel('a')], true)
    expect(res.panelId).toBeUndefined()
    expect(res.notice).toMatch(/is not available/)
  })

  it('an unknown panel while the list is still loading surfaces nothing (no error flash)', () => {
    expect(resolveActivePanel(route('missing'), [], false)).toEqual({
      panelId: undefined,
    })
  })

  it('a known panel resolves to that panel id', () => {
    expect(
      resolveActivePanel(route('a'), [panel('a'), panel('b')], true),
    ).toEqual({ panelId: 'a' })
  })

  it('an empty panel list with a ready state is not silently empty', () => {
    const res = resolveActivePanel(route('a'), [], true)
    expect(res.panelId).toBeUndefined()
    expect(res.notice).toMatch(/is not available/)
  })
})
