import { describe, expect, it } from 'vitest'

import type { ExtensionPointDef } from '@/kernel/contracts/extension-point.js'

import {
  CapabilityDeniedError,
  ExtensionConflictError,
  UnknownExtensionPointError,
} from '@/kernel/errors.js'
import {
  ExtensionPointRegistry,
  HOST_PLUGIN_ID,
} from '@/kernel/extensions/registry.js'
import { PermissionManager } from '@/kernel/security/permission-manager.js'

const multiDef: ExtensionPointDef<unknown> = {
  id: 'log.sink',
  describe: 'test multi slot',
  multi: true,
  hasHostDefault: false,
  conflict: 'keep-first',
}

const keepFirstDef: ExtensionPointDef<unknown> = {
  id: 'config.provider',
  describe: 'test singleton, keep-first',
  multi: false,
  hasHostDefault: false,
  conflict: 'keep-first',
}

const rejectNewDef: ExtensionPointDef<unknown> = {
  id: 'ui.route',
  describe: 'test singleton, reject-new',
  multi: false,
  hasHostDefault: false,
  conflict: 'reject-new',
}

const replaceOldDef: ExtensionPointDef<unknown> = {
  id: 'loader.replace',
  describe: 'test singleton, replace-old',
  multi: false,
  hasHostDefault: false,
  conflict: 'replace-old',
}

const capableDef: ExtensionPointDef<unknown> = {
  id: 'ui.panel',
  describe: 'test singleton behind a capability',
  multi: true,
  hasHostDefault: false,
  conflict: 'reject-new',
  capability: 'ui.panel',
}

function contribution(contributionId: string, impl: unknown = contributionId) {
  return { contributionId, impl }
}

describe('extension-registry · define', () => {
  it('registers a definition and reports it as known', () => {
    const registry = new ExtensionPointRegistry()
    registry.define(multiDef)

    expect(registry.has('log.sink')).toBe(true)
    expect(registry.has('ui.panel')).toBe(false)
  })

  it('rejects a duplicate definition', () => {
    const registry = new ExtensionPointRegistry()
    registry.define(multiDef)

    expect(() => registry.define(multiDef)).toThrow(ExtensionConflictError)
  })

  it('defineAll registers every definition', () => {
    const registry = new ExtensionPointRegistry()
    registry.defineAll([multiDef, keepFirstDef, rejectNewDef])

    expect(
      registry
        .list()
        .map(s => s.point)
        .toSorted(),
    ).toEqual(['config.provider', 'log.sink', 'ui.route'])
  })
})

describe('extension-registry · multi slots', () => {
  it('accepts several contributions and resolves them in order', () => {
    const registry = new ExtensionPointRegistry()
    registry.define(multiDef)

    registry.contribute('com.rem2.a', 'log.sink', contribution('a1'))
    registry.contribute('com.rem2.b', 'log.sink', contribution('b1'))

    expect(registry.resolve('log.sink')).toEqual(['a1', 'b1'])
    expect(registry.listAll('log.sink')).toEqual(['a1', 'b1'])
  })

  it('returns an empty array for an empty slot', () => {
    const registry = new ExtensionPointRegistry()
    registry.define(multiDef)

    expect(registry.resolve('log.sink')).toEqual([])
    expect(registry.listAll('log.sink')).toEqual([])
    expect(registry.entries('log.sink')).toEqual([])
  })

  it('rejects a duplicate contributionId', () => {
    const registry = new ExtensionPointRegistry()
    registry.define(multiDef)
    registry.contribute('com.rem2.a', 'log.sink', contribution('same'))

    expect(() =>
      registry.contribute('com.rem2.b', 'log.sink', contribution('same')),
    ).toThrow(ExtensionConflictError)
  })

  it('entries expose contribution and plugin ids', () => {
    const registry = new ExtensionPointRegistry()
    registry.define(multiDef)
    registry.contribute('com.rem2.a', 'log.sink', contribution('a1', 'impl-a'))

    expect(registry.entries('log.sink')).toEqual([
      { contributionId: 'a1', pluginId: 'com.rem2.a', impl: 'impl-a' },
    ])
  })

  it('resolveSingle is undefined for a multi slot', () => {
    const registry = new ExtensionPointRegistry()
    registry.define(multiDef)
    registry.contribute('com.rem2.a', 'log.sink', contribution('a1'))

    expect(registry.resolveSingle('log.sink')).toBeUndefined()
  })
})

describe('extension-registry · singleton conflict policies', () => {
  it('keep-first keeps the original and records an issue without throwing', () => {
    const registry = new ExtensionPointRegistry()
    registry.define(keepFirstDef)

    registry.contribute('com.rem2.a', 'config.provider', contribution('a'))
    expect(() =>
      registry.contribute('com.rem2.b', 'config.provider', contribution('b')),
    ).not.toThrow()

    expect(registry.resolve('config.provider')).toBe('a')
    const issues = registry.listIssues()
    expect(issues).toHaveLength(1)
    expect(issues[0]?.contributionId).toBe('b')
    expect(issues[0]?.pluginId).toBe('com.rem2.b')
    expect(issues[0]?.reason).toMatch(/keep-first/)
  })

  it('reject-new throws and keeps the original', () => {
    const registry = new ExtensionPointRegistry()
    registry.define(rejectNewDef)
    registry.contribute('com.rem2.a', 'ui.route', contribution('a'))

    expect(() =>
      registry.contribute('com.rem2.b', 'ui.route', contribution('b')),
    ).toThrow(ExtensionConflictError)
    expect(registry.resolve('ui.route')).toBe('a')
  })

  it('replace-old swaps the active entry', () => {
    const registry = new ExtensionPointRegistry()
    registry.define(replaceOldDef)

    registry.contribute('com.rem2.a', 'loader.replace', contribution('a', 'A'))
    registry.contribute('com.rem2.b', 'loader.replace', contribution('b', 'B'))

    expect(registry.resolve('loader.replace')).toBe('B')
    expect(registry.resolveSingle('loader.replace')).toBe('B')
  })

  it('a singleton slot lists as a single-entry array', () => {
    const registry = new ExtensionPointRegistry()
    registry.define(replaceOldDef)
    registry.contribute('com.rem2.a', 'loader.replace', contribution('a', 'A'))

    expect(registry.listAll('loader.replace')).toEqual(['A'])
  })
})

describe('extension-registry · capability gate', () => {
  it('denies a plugin without the capability', () => {
    const registry = new ExtensionPointRegistry({
      permissions: new PermissionManager(),
    })
    registry.define(capableDef)

    expect(() =>
      registry.contribute('com.rem2.a', 'ui.panel', contribution('a')),
    ).toThrow(CapabilityDeniedError)
  })

  it('allows a plugin that holds the capability', () => {
    const permissions = new PermissionManager()
    permissions.grant('com.rem2.a', 'ui.panel')
    const registry = new ExtensionPointRegistry({ permissions })
    registry.define(capableDef)

    registry.contribute('com.rem2.a', 'ui.panel', contribution('a'))

    expect(registry.resolve('ui.panel')).toEqual(['a'])
  })

  it('allows a plugin that holds the set but not the capability', () => {
    const permissions = new PermissionManager()
    permissions.grant('com.rem2.a', 'log.sink')
    const registry = new ExtensionPointRegistry({ permissions })
    registry.define(capableDef)

    expect(() =>
      registry.contribute('com.rem2.a', 'ui.panel', contribution('a')),
    ).toThrow(CapabilityDeniedError)
  })

  it('exempts the host plugin from the capability gate', () => {
    const registry = new ExtensionPointRegistry({
      permissions: new PermissionManager(),
    })
    registry.define(capableDef)

    registry.registerHostDefault('ui.panel', contribution('host'))

    expect(registry.resolve('ui.panel')).toEqual(['host'])
  })
})

describe('extension-registry · retraction', () => {
  it('retract removes one contribution from a multi slot', () => {
    const registry = new ExtensionPointRegistry()
    registry.define(multiDef)
    registry.contribute('com.rem2.a', 'log.sink', contribution('a1'))
    registry.contribute('com.rem2.a', 'log.sink', contribution('a2'))

    registry.retract('log.sink', 'a1')

    expect(registry.resolve('log.sink')).toEqual(['a2'])
  })

  it('retract removes the active entry from a singleton slot', () => {
    const registry = new ExtensionPointRegistry()
    registry.define(replaceOldDef)
    registry.contribute('com.rem2.a', 'loader.replace', contribution('a', 'A'))

    registry.retract('loader.replace', 'a')

    expect(registry.resolve('loader.replace')).toBeUndefined()
  })

  it('retract on an unknown point throws', () => {
    const registry = new ExtensionPointRegistry()

    expect(() => registry.retract('log.sink', 'x')).toThrow(
      UnknownExtensionPointError,
    )
  })

  it('retractAll reclaims every contribution of a plugin', () => {
    const registry = new ExtensionPointRegistry()
    registry.defineAll([multiDef, replaceOldDef])
    registry.contribute('com.rem2.a', 'log.sink', contribution('a1'))
    registry.contribute('com.rem2.a', 'loader.replace', contribution('r1', 'R'))
    registry.contribute('com.rem2.b', 'log.sink', contribution('b1'))

    registry.retractAll('com.rem2.a')

    expect(registry.resolve('log.sink')).toEqual(['b1'])
    expect(registry.resolve('loader.replace')).toBeUndefined()
  })

  it('retractAll is a no-op for a plugin that never contributed', () => {
    const registry = new ExtensionPointRegistry()
    registry.define(multiDef)
    registry.contribute('com.rem2.a', 'log.sink', contribution('a1'))

    expect(() => registry.retractAll('com.rem2.ghost')).not.toThrow()
    expect(registry.resolve('log.sink')).toEqual(['a1'])
  })
})

describe('extension-registry · unknown points and summary', () => {
  it('contribute on an unknown point throws', () => {
    const registry = new ExtensionPointRegistry()

    expect(() =>
      registry.contribute('com.rem2.a', 'ui.panel', contribution('a')),
    ).toThrow(UnknownExtensionPointError)
  })

  it('resolve on an unknown point throws', () => {
    const registry = new ExtensionPointRegistry()

    expect(() => registry.resolve('ui.panel')).toThrow(
      UnknownExtensionPointError,
    )
  })

  it('list reports contributions per point and the multi flag', () => {
    const registry = new ExtensionPointRegistry()
    registry.defineAll([multiDef, replaceOldDef])
    registry.contribute('com.rem2.a', 'log.sink', contribution('a1'))
    registry.contribute('com.rem2.a', 'loader.replace', contribution('r1', 'R'))

    expect(registry.list()).toEqual([
      { point: 'log.sink', multi: true, contributions: ['a1'] },
      { point: 'loader.replace', multi: false, contributions: ['r1'] },
    ])
  })

  it('host defaults are attributed to the kernel plugin id', () => {
    const registry = new ExtensionPointRegistry()
    registry.define(multiDef)
    registry.registerHostDefault('log.sink', contribution('default'))

    expect(registry.entries('log.sink')[0]?.pluginId).toBe(HOST_PLUGIN_ID)
  })
})
