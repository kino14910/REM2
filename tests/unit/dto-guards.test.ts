/**
 * Unit test: runtime DTO guards for data crossing the IPC boundary
 * (`src/frontend/lib/dto-guards.ts`).
 *
 * Rationale: the renderer cannot trust host payloads at runtime (the preload
 * bridge is a plain JS surface). These guards are the boundary: unparseable
 * lists throw (the store degrades to its error state), bad entries are dropped
 * with an issue recorded (never silently rendered), and panel data is
 * classified into an explicit shape. A regression that silently accepts bad
 * entries would corrupt the UI with invisible data, so the "issues must be
 * non-empty" assertions below are paired with a meta test proving they can fail.
 */

import { describe, expect, it } from 'vitest'
import {
  parsePanelData,
  parsePanelList,
  parseRouteList,
} from '../../src/frontend/lib/dto-guards.js'
import type { PanelDto, RouteDto } from '../../src/frontend/lib/bridge-types.js'

function validPanel(): PanelDto {
  return {
    panelId: 'plugin-inspector',
    title: 'Plugin Inspector',
    icon: '🔍',
    region: 'main',
    order: 10,
    command: 'com.rem2.plugin-inspector.data',
  }
}

function validRoute(): RouteDto {
  return {
    path: '/plugins',
    title: 'Plugins',
    panelId: 'plugin-inspector',
    commandPrefix: '',
    order: 10,
  }
}

describe('unit · dto guards · parsePanelList', () => {
  it('a valid array passes through unchanged', () => {
    const input = [validPanel()]
    const { items, issues } = parsePanelList(input)
    expect(items).toEqual(input)
    expect(issues).toEqual([])
  })

  it('an empty array yields empty items (a legitimate no-panel state)', () => {
    expect(parsePanelList([])).toEqual({ items: [], issues: [] })
  })

  it.each([
    ['null', null],
    ['an object', {}],
    ['a string', 'panels'],
  ])(
    'a non-array (%s) throws instead of degrading silently',
    (_label, value) => {
      expect(() => parsePanelList(value)).toThrow(/expected an array/)
    },
  )

  it('bad entries are dropped with an issue recorded; good entries survive', () => {
    const good = validPanel()
    const { items, issues } = parsePanelList([
      good,
      { ...good, panelId: '' },
      { ...good, region: 'top' },
      { ...good, order: 'x' },
      42,
    ])
    expect(items).toEqual([good])
    expect(issues).toHaveLength(4)
    expect(issues[0]).toContain('panel[1]')
    expect(issues[1]).toContain('panel[2]')
    expect(issues[2]).toContain('panel[3]')
    expect(issues[3]).toContain('panel[4]')
  })

  it('meta: a known-bad entry must land in issues (a silent-accept regression leaves issues empty and fails here)', () => {
    // The negative-verification companion for the drop-with-issue policy: if
    // the guard ever degrades to accepting bad entries, `items` would keep the
    // entry and `issues` would be empty - both assertions below would fail.
    const { items, issues } = parsePanelList([
      { ...validPanel(), region: 'top' },
    ])
    expect(items).toEqual([])
    expect(issues.length).toBeGreaterThan(0)
  })
})

describe('unit · dto guards · parseRouteList', () => {
  it('a valid array passes through unchanged', () => {
    const input = [validRoute()]
    const { items, issues } = parseRouteList(input)
    expect(items).toEqual(input)
    expect(issues).toEqual([])
  })

  it('an empty panelId is a legal route (no panel association) and is kept', () => {
    // nav-link surfaces the missing association as a notice; the guard must
    // not drop the route itself.
    const route = { ...validRoute(), panelId: '' }
    const { items, issues } = parseRouteList([route])
    expect(items).toEqual([route])
    expect(issues).toEqual([])
  })

  it('a non-string path is dropped with an issue', () => {
    const { items, issues } = parseRouteList([{ ...validRoute(), path: 42 }])
    expect(items).toEqual([])
    expect(issues).toHaveLength(1)
  })

  it('a non-number order is dropped with an issue', () => {
    const { items, issues } = parseRouteList([{ ...validRoute(), order: 'x' }])
    expect(items).toEqual([])
    expect(issues).toHaveLength(1)
  })

  it('a non-array throws', () => {
    expect(() => parseRouteList(null)).toThrow(/expected an array/)
  })
})

describe('unit · dto guards · parsePanelData', () => {
  it('a valid table is classified as a table (deep equality)', () => {
    const table = {
      kind: 'table',
      columns: ['id', 'state'],
      rows: [['com.rem2.x', 'Active']],
    }
    expect(parsePanelData(table)).toEqual({
      kind: 'table',
      columns: table.columns,
      rows: table.rows,
    })
  })

  it('an empty row is a legal table row (cells are checked, not row width)', () => {
    // Pinned against the real implementation: asTable requires every row to be
    // an array of string|number cells; an empty row satisfies that vacuously.
    expect(
      parsePanelData({ kind: 'table', columns: ['a'], rows: [[]] }),
    ).toEqual({ kind: 'table', columns: ['a'], rows: [[]] })
  })

  it.each([
    ['rows is not an array', { kind: 'table', columns: ['a'], rows: 'x' }],
    ['columns is empty', { kind: 'table', columns: [], rows: [] }],
    [
      'a cell is not a string/number',
      { kind: 'table', columns: ['a'], rows: [[true]] },
    ],
    ['a column is not a string', { kind: 'table', columns: [1], rows: [] }],
  ])('a malformed table (%s) is invalid with a reason', (_label, value) => {
    const parsed = parsePanelData(value)
    expect(parsed.kind).toBe('invalid')
    expect((parsed as { reason: string }).reason).toMatch(/invalid table/)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
  ])('%s means the panel provides no data (empty)', (_label, value) => {
    expect(parsePanelData(value)).toEqual({ kind: 'empty' })
  })

  it.each([
    ['an object', { a: 1, b: ['x'] }],
    ['an array', [1, 'two', null]],
    ['a string', 'hello'],
    ['a number', 42],
  ])('a non-table payload (%s) falls back to pretty JSON', (_label, value) => {
    const parsed = parsePanelData(value)
    expect(parsed.kind).toBe('json')
    expect(JSON.parse((parsed as { text: string }).text)).toEqual(value)
  })

  it('a payload over the 32KB budget is invalid', () => {
    const big = { blob: 'x'.repeat(33 * 1024) }
    expect(parsePanelData(big)).toEqual({
      kind: 'invalid',
      reason: 'panel data exceeds 32KB limit',
    })
  })
})
