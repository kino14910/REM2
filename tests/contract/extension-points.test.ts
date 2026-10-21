/**
 * Contract test: extension point list consistency.
 *
 * Expected ids are hardcoded as a literal array (not imported from
 * elsewhere) so the expectation stays an independent criterion: if
 * definitions.ts and this table were both changed incorrectly, the test
 * still fails.
 */

import { describe, expect, it } from 'vitest'
import {
  EXTENSION_POINT_DEFS,
  EXTENSION_POINT_IDS,
} from '../../src/kernel/extensions/definitions.js'
import type { ExtensionPointDef } from '../../src/kernel/contracts/extension-point.js'

type AnyDef = ExtensionPointDef<unknown>

const EXPECTED_IDS = [
  'log.sink',
  'metrics.sink',
  'trace.exporter',
  'config.provider',
  'command.provide',
  'health.check',
  'ui.theme',
  'ui.panel',
  'ui.route',
  'scheduler.replace',
  'resolver.replace',
  'loader.replace',
] as const

describe('contract · the extension point list matches docs/01 §4.1', () => {
  it('the exported extension point ids match the documentation table entry by entry (in order)', () => {
    expect(EXTENSION_POINT_IDS).toEqual(EXPECTED_IDS)
  })

  it('ids have no duplicates', () => {
    expect(new Set(EXTENSION_POINT_IDS).size).toBe(EXTENSION_POINT_IDS.length)
  })

  it('every definition has a describe, and singleton slots must explicitly declare a conflict strategy', () => {
    for (const def of EXTENSION_POINT_DEFS) {
      expect(def.describe.length).toBeGreaterThan(0)
      if (!def.multi) {
        // Singleton slots may not rely on an implicit default: one of the three strategies must be explicitly declared.
        expect(['reject-new', 'replace-old', 'keep-first']).toContain(
          def.conflict,
        )
      }
    }
  })

  it('the UI extension points are complete (ui.theme / ui.panel / ui.route)', () => {
    // These three are the mount surface for the Svelte frontend slots; without one of them the frontend has no generic render entry.
    for (const id of ['ui.theme', 'ui.panel', 'ui.route']) {
      expect(EXTENSION_POINT_IDS).toContain(id)
    }
  })

  it('ui.panel is a multi slot with same-id conflict reject-new; ui.route is a multi slot with replace-old', () => {
    const panel = EXTENSION_POINT_DEFS.find(d => d.id === 'ui.panel')
    expect(panel).toBeDefined()
    expect(panel?.multi).toBe(true)
    expect(panel?.conflict).toBe('reject-new')

    const route = EXTENSION_POINT_DEFS.find(d => d.id === 'ui.route')
    expect(route).toBeDefined()
    expect(route?.multi).toBe(true)
    expect(route?.conflict).toBe('replace-old')
  })

  it('ui.theme is a multi slot (theme catalog); a duplicate theme id is rejected', () => {
    // Multi, not singleton: a light/dark switch needs both token sets resident at the
    // same time. Selection is host state (`ThemeRegistry.active()`), not a contribution.
    const theme = EXTENSION_POINT_DEFS.find(d => d.id === 'ui.theme')
    expect(theme?.multi).toBe(true)
    expect(theme?.conflict).toBe('reject-new')
  })

  it('all three *.replace extension points are singleton + replace-old + kernel.internals gated', () => {
    for (const id of [
      'scheduler.replace',
      'resolver.replace',
      'loader.replace',
    ]) {
      const def = EXTENSION_POINT_DEFS.find(d => d.id === id)
      expect(def).toBeDefined()
      expect(def?.multi).toBe(false)
      expect(def?.conflict).toBe('replace-old')
      // capability is optional; `as const` turns 'some defs lack it' into a union type,
      // so it is explicitly narrowed to ExtensionPointDef here before reading.
      expect((def as AnyDef | undefined)?.capability).toBe('kernel.internals')
    }
  })
})
