import { describe, expect, it } from 'vitest'

import type { PluginFactory } from '@/kernel/contracts/plugin.js'

import {
  assertPluginFactory,
  inlineManifestId,
} from '@/kernel/loader/plugin-factory.js'

function makeFactory(): PluginFactory {
  return (() => ({})) as unknown as PluginFactory
}

const factory = makeFactory()

describe('plugin-factory · assertPluginFactory', () => {
  it('returns the default export when it is a function', () => {
    const moduleExports = { default: factory }

    expect(assertPluginFactory(moduleExports, 'com.rem2.p')).toBe(factory)
  })

  it('rejects a module without a default export', () => {
    expect(() => assertPluginFactory({ named: factory }, 'com.rem2.p')).toThrow(
      TypeError,
    )
  })

  it('rejects a default export that is not a function', () => {
    expect(() =>
      assertPluginFactory({ default: { setup: () => ({}) } }, 'com.rem2.p'),
    ).toThrow(/default must be a function, received object/)
  })

  it('rejects a null module export without throwing a TypeError of its own', () => {
    expect(() => assertPluginFactory(null, 'com.rem2.p')).toThrow(
      /received undefined/,
    )
  })

  it('names the offending plugin in the error', () => {
    expect(() => assertPluginFactory({}, 'com.rem2.broken')).toThrow(
      /com\.rem2\.broken/,
    )
  })
})

describe('plugin-factory · inlineManifestId', () => {
  it('reads the id attached by definePlugin', () => {
    const withManifest = Object.assign(makeFactory(), {
      manifest: { id: 'com.rem2.p', name: 'p', version: '1.0.0' },
    })

    expect(inlineManifestId(withManifest)).toBe('com.rem2.p')
  })

  it('returns undefined when no manifest is attached', () => {
    expect(inlineManifestId(makeFactory() as never)).toBeUndefined()
  })

  it('returns undefined when the id is not a string', () => {
    const withBadManifest = Object.assign(makeFactory(), {
      manifest: { id: 42 },
    })

    expect(inlineManifestId(withBadManifest as never)).toBeUndefined()
  })
})
