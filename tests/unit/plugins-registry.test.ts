import { describe, expect, it } from 'vitest'

import type { PluginStateT } from '@/kernel/contracts/plugins.js'
import type { LoadedPlugin } from '@/kernel/extensions/ports-types.js'

import { PluginsRegistry } from '@/kernel/registry/plugins-registry.js'

import { makeManifest } from '../helpers/make-manifest.js'

function loadedPlugin(
  id: string,
  state: PluginStateT = 'Loaded',
): LoadedPlugin {
  return {
    manifest: makeManifest({ id }),
    hooks: {},
    context: {} as LoadedPlugin['context'],
    container: {} as LoadedPlugin['container'],
    state,
    health: { status: 'healthy' },
    rootDir: `/virtual/${id}`,
    permissions: {
      pluginId: id,
      granted: [],
      denied: [],
      isGranted: () => false,
    },
  }
}

describe('plugins-registry · storage', () => {
  it('adds a plugin and reads it back', () => {
    const registry = new PluginsRegistry()
    registry.add(loadedPlugin('com.rem2.a'))

    expect(registry.getLoaded('com.rem2.a')?.manifest.id).toBe('com.rem2.a')
    expect(registry.has('com.rem2.a')).toBe(true)
    expect(registry.size).toBe(1)
  })

  it('overwrites an entry with the same id instead of duplicating it', () => {
    const registry = new PluginsRegistry()
    registry.add(loadedPlugin('com.rem2.a', 'Loaded'))
    registry.add(loadedPlugin('com.rem2.a', 'Active'))

    expect(registry.size).toBe(1)
    expect(registry.getLoaded('com.rem2.a')?.state).toBe('Active')
  })

  it('sorts allLoaded by id regardless of insertion order', () => {
    const registry = new PluginsRegistry()
    registry.add(loadedPlugin('com.rem2.z'))
    registry.add(loadedPlugin('com.rem2.a'))
    registry.add(loadedPlugin('com.rem2.m'))

    expect(registry.allLoaded().map(p => p.manifest.id)).toEqual([
      'com.rem2.a',
      'com.rem2.m',
      'com.rem2.z',
    ])
  })

  it('removes an entry and reports the shrink', () => {
    const registry = new PluginsRegistry()
    registry.add(loadedPlugin('com.rem2.a'))
    registry.remove('com.rem2.a')

    expect(registry.has('com.rem2.a')).toBe(false)
    expect(registry.size).toBe(0)
    expect(registry.getLoaded('com.rem2.a')).toBeUndefined()
  })
})

describe('plugins-registry · mutation', () => {
  it('setState updates a known plugin and ignores an unknown one', () => {
    const registry = new PluginsRegistry()
    registry.add(loadedPlugin('com.rem2.a', 'Loaded'))

    registry.setState('com.rem2.a', 'Active')
    registry.setState('com.rem2.ghost', 'Active')

    expect(registry.getLoaded('com.rem2.a')?.state).toBe('Active')
    expect(registry.size).toBe(1)
  })

  it('setHealth replaces the health snapshot without touching the state', () => {
    const registry = new PluginsRegistry()
    registry.add(loadedPlugin('com.rem2.a', 'Active'))

    registry.setHealth('com.rem2.a', { status: 'degraded', message: 'slow' })

    const entry = registry.getLoaded('com.rem2.a')
    expect(entry?.health.status).toBe('degraded')
    expect(entry?.health.message).toBe('slow')
    expect(entry?.state).toBe('Active')
  })

  it('setHealth on an unknown plugin is a no-op', () => {
    const registry = new PluginsRegistry()

    expect(() =>
      registry.setHealth('com.rem2.ghost', { status: 'unhealthy' }),
    ).not.toThrow()
    expect(registry.size).toBe(0)
  })
})

describe('plugins-registry · read-only view', () => {
  it('isStarted is true only in the Active state', () => {
    const registry = new PluginsRegistry()
    registry.add(loadedPlugin('com.rem2.active', 'Active'))
    registry.add(loadedPlugin('com.rem2.idle', 'Loaded'))

    expect(registry.isStarted('com.rem2.active')).toBe(true)
    expect(registry.isStarted('com.rem2.idle')).toBe(false)
    expect(registry.isStarted('com.rem2.absent')).toBe(false)
  })

  it('get exposes only the whitelisted PluginInfo fields', () => {
    const registry = new PluginsRegistry()
    registry.add(loadedPlugin('com.rem2.a', 'Configured'))

    const info = registry.get('com.rem2.a')

    expect(info).toEqual({
      id: 'com.rem2.a',
      name: 'com.rem2.a',
      version: '1.0.0',
      state: 'Configured',
      manifest: makeManifest({ id: 'com.rem2.a' }),
    })
  })

  it('get returns undefined for an unknown id', () => {
    expect(new PluginsRegistry().get('com.rem2.ghost')).toBeUndefined()
  })

  it('all and byState project every entry through the same whitelist', () => {
    const registry = new PluginsRegistry()
    registry.add(loadedPlugin('com.rem2.a', 'Active'))
    registry.add(loadedPlugin('com.rem2.b', 'Failed'))
    registry.add(loadedPlugin('com.rem2.c', 'Active'))

    expect(registry.all().map(i => i.id)).toEqual([
      'com.rem2.a',
      'com.rem2.b',
      'com.rem2.c',
    ])
    expect(registry.byState('Active').map(i => i.id)).toEqual([
      'com.rem2.a',
      'com.rem2.c',
    ])
    expect(registry.byStateLoaded('Active').map(p => p.manifest.id)).toEqual([
      'com.rem2.a',
      'com.rem2.c',
    ])
  })

  it('byState returns an empty list when nothing matches', () => {
    const registry = new PluginsRegistry()
    registry.add(loadedPlugin('com.rem2.a', 'Loaded'))

    expect(registry.byState('Active')).toEqual([])
    expect(registry.byStateLoaded('Disposed')).toEqual([])
  })
})
