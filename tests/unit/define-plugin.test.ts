import { describe, expect, it, vi } from 'vitest'

import type { PluginContext } from '@/kernel/contracts/context.js'
import type { PluginManifestInit } from '@/kernel/contracts/manifest.js'
import type { PluginFactory } from '@/kernel/contracts/plugin.js'

import { definePlugin } from '@/kernel/define-plugin.js'
import { ManifestError } from '@/kernel/errors.js'

const ctx = {} as PluginContext

function manifest(id: string): PluginManifestInit {
  return { id, name: id } as PluginManifestInit
}

/**
 * The inline manifest is attached at runtime; `PluginFactory` does not declare
 * it, so the loader and tests read it through the same narrow cast.
 */
function manifestOf(factory: PluginFactory): { id: string } {
  return (factory as PluginFactory & { manifest: { id: string } }).manifest
}

describe('define-plugin · manifest validation', () => {
  it('rejects a missing manifest', () => {
    expect(() =>
      definePlugin(undefined as unknown as PluginManifestInit, () => ({})),
    ).toThrow(ManifestError)
  })

  it('rejects a non-string id', () => {
    expect(() =>
      definePlugin({ id: 42 } as unknown as PluginManifestInit, () => ({})),
    ).toThrow(/manifest\.id/)
  })

  it('rejects an empty id', () => {
    expect(() => definePlugin(manifest(''), () => ({}))).toThrow(ManifestError)
  })

  it('rejects a whitespace-only id', () => {
    expect(() => definePlugin(manifest('   '), () => ({}))).toThrow(
      /non-empty string/,
    )
  })

  it('rejects a non-function setup', () => {
    expect(() =>
      definePlugin(manifest('com.rem2.bad'), undefined as never),
    ).toThrow(TypeError)
    expect(() => definePlugin(manifest('com.rem2.bad'), null as never)).toThrow(
      /must be a function/,
    )
  })
})

describe('define-plugin · factory shape', () => {
  it('returns a callable factory that forwards the context to setup', () => {
    const setup = vi.fn(() => ({ onStart: async () => undefined }))
    const factory = definePlugin(manifest('com.rem2.ok'), setup)

    const hooks = factory(ctx)

    expect(setup).toHaveBeenCalledWith(ctx)
    expect(hooks.onStart).toBeTypeOf('function')
  })

  it('passes every argument through unchanged', () => {
    const seen: PluginContext[] = []
    const factory = definePlugin(manifest('com.rem2.ok'), context => {
      seen.push(context)
      return {}
    })

    factory(ctx)
    factory(ctx)

    expect(seen).toEqual([ctx, ctx])
  })

  it('attaches the inline manifest to the factory', () => {
    const factory = definePlugin(manifest('com.rem2.ok'), () => ({}))

    expect(manifestOf(factory).id).toBe('com.rem2.ok')
  })

  it('freezes the attached manifest', () => {
    const source = manifest('com.rem2.ok')
    const factory = definePlugin(source, () => ({}))

    source.id = 'com.rem2.mutated'

    expect(manifestOf(factory).id).toBe('com.rem2.ok')
    expect(Object.isFrozen(manifestOf(factory))).toBe(true)
  })

  it('freezes the factory itself', () => {
    const factory = definePlugin(manifest('com.rem2.ok'), () => ({}))

    expect(Object.isFrozen(factory)).toBe(true)
    expect(() => {
      ;(factory as unknown as Record<string, unknown>).extra = 1
    }).toThrow(TypeError)
  })
})
