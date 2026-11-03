import { describe, expect, it, vi } from 'vitest'

import type { ConfigProvider } from '@/kernel/contracts/config.js'

import { ConfigService } from '@/kernel/config/config-service.js'
import { MemoryConfigProvider } from '@/kernel/config/memory-provider.js'
import { NotWritableError } from '@/kernel/errors.js'

describe('config-service · layered merging', () => {
  it('higher priority overrides lower priority', async () => {
    const svc = new ConfigService()
    svc.registerProvider(new MemoryConfigProvider({ a: 1, b: 1 }, 'low', 10))
    svc.registerProvider(new MemoryConfigProvider({ b: 2 }, 'high', 100))
    await svc.refresh()

    expect(svc.get('a')).toBe(1)
    expect(svc.get('b')).toBe(2)
  })

  it('deep merges objects', async () => {
    const svc = new ConfigService()
    svc.registerProvider(
      new MemoryConfigProvider({ app: { a: 1, b: 2 } }, 'low', 10),
    )
    svc.registerProvider(
      new MemoryConfigProvider({ app: { b: 3 } }, 'high', 100),
    )
    await svc.refresh()

    expect(svc.get('app.a')).toBe(1)
    expect(svc.get('app.b')).toBe(3)
  })

  it('get supports paths and default values', async () => {
    const svc = new ConfigService()
    svc.registerProvider(
      new MemoryConfigProvider({ app: { greeting: 'hi' } }, 'm', 10),
    )
    await svc.refresh()

    expect(svc.get('app.greeting')).toBe('hi')
    expect(svc.get<string>('app.missing', 'default')).toBe('default')
    expect(svc.has('app.greeting')).toBe(true)
    expect(svc.has('nope')).toBe(false)
  })

  it('getOrThrow throws when the key is missing', async () => {
    const svc = new ConfigService()
    await svc.refresh()
    expect(() => svc.getOrThrow('missing')).toThrow(/missing/)
  })

  it('layers are sorted by priority ascending', () => {
    const svc = new ConfigService()
    svc.registerProvider(new MemoryConfigProvider({}, 'high', 100))
    svc.registerProvider(new MemoryConfigProvider({}, 'low', 10))
    expect(svc.layers()).toEqual(['low', 'high'])
  })

  it('a single provider failing to load does not affect the other layers', async () => {
    const svc = new ConfigService()
    const broken: ConfigProvider = {
      name: 'broken',
      priority: 50,
      load: async () => {
        throw new Error('boom')
      },
    }
    svc.registerProvider(new MemoryConfigProvider({ ok: true }, 'good', 10))
    svc.registerProvider(broken)
    await svc.refresh()
    expect(svc.get('ok')).toBe(true)
  })
})

describe('config-service · change notifications', () => {
  it('set triggers onDidChange', async () => {
    const svc = new ConfigService()
    svc.registerProvider(new MemoryConfigProvider({}, 'memory', 1000))
    await svc.refresh()

    let changedKey = ''
    svc.onDidChange((_keys, key) => {
      changedKey = key
    })
    await svc.set('foo', 'bar')
    expect(changedKey).toBe('foo')
    expect(svc.get('foo')).toBe('bar')
  })

  it('provider.onDidChange triggers a kernel refresh', async () => {
    const svc = new ConfigService()
    let notify: ((keys: string[]) => void) | null = null
    const provider: ConfigProvider = {
      name: 'watch',
      priority: 10,
      load: async () => ({ watched: Date.now() }),
      onDidChange: cb => {
        notify = cb
        return () => {
          notify = null
        }
      },
    }
    svc.registerProvider(provider)
    await svc.refresh()
    expect(notify).not.toBeNull()

    const before = svc.get<number>('watched')
    // Trigger a change: marks dirty (the snapshot updates only after another refresh)
    notify!(['watched'])
    await svc.refresh()
    expect(svc.get<number>('watched')).toBeGreaterThanOrEqual(before)
  })
})

describe('config-service · provider lifecycle', () => {
  it('replaces a provider registered under the same name', async () => {
    const svc = new ConfigService()
    svc.registerProvider(new MemoryConfigProvider({ v: 1 }, 'same', 10))
    svc.registerProvider(new MemoryConfigProvider({ v: 2 }, 'same', 10))
    await svc.refresh()

    expect(svc.layers()).toEqual(['same'])
    expect(svc.get('v')).toBe(2)
  })

  it('unregisterProvider drops the layer and its change subscription', () => {
    const svc = new ConfigService()
    const unsub = vi.fn()
    svc.registerProvider({
      name: 'watch',
      priority: 10,
      load: async () => ({ watched: 1 }),
      onDidChange: () => unsub,
    })

    svc.unregisterProvider('watch')

    expect(unsub).toHaveBeenCalledTimes(1)
    expect(svc.layers()).toEqual([])
  })

  it('layerDetails reports names with priorities in merge order', () => {
    const svc = new ConfigService()
    svc.registerProvider(new MemoryConfigProvider({}, 'high', 100))
    svc.registerProvider(new MemoryConfigProvider({}, 'low', 10))

    expect(svc.layerDetails()).toEqual([
      { name: 'low', priority: 10 },
      { name: 'high', priority: 100 },
    ])
  })
})

describe('config-service · provider failures', () => {
  it('records a load failure and reports it to onProviderError', async () => {
    const onProviderError = vi.fn()
    const svc = new ConfigService({ onProviderError })
    svc.registerProvider({
      name: 'broken',
      priority: 10,
      load: async () => {
        throw new Error('boom')
      },
    })

    await svc.refresh()

    expect(svc.loadFailures).toHaveLength(1)
    expect(svc.loadFailures[0]).toMatchObject({
      provider: 'broken',
      error: 'boom',
    })
    expect(onProviderError).toHaveBeenCalledTimes(1)
  })

  it('clearLoadFailures empties the record', async () => {
    const svc = new ConfigService()
    svc.registerProvider({
      name: 'broken',
      priority: 1,
      load: async () => {
        throw new Error('x')
      },
    })
    await svc.refresh()

    svc.clearLoadFailures()

    expect(svc.loadFailures).toEqual([])
  })

  it('set notifies subscribers even when the follow-up load fails', async () => {
    const svc = new ConfigService()
    svc.registerProvider({
      name: 'flaky',
      priority: 10,
      load: async () => {
        throw new Error('load boom')
      },
      set: async () => undefined,
    })
    const changed = vi.fn()
    svc.onDidChange(changed)

    await svc.set('k', 1)

    expect(changed).toHaveBeenCalledWith(['k'], 'k')
    expect(svc.loadFailures[0]).toMatchObject({
      provider: 'flaky',
      error: 'load boom',
    })
  })

  it('set throws when no provider is writable', async () => {
    const svc = new ConfigService()
    svc.registerProvider({
      name: 'readonly',
      priority: 10,
      load: async () => ({}),
    })

    await expect(svc.set('k', 1)).rejects.toThrow(NotWritableError)
  })
})

describe('config-service · subscribers and lazy refresh', () => {
  it('a throwing subscriber does not block the others', async () => {
    const svc = new ConfigService()
    svc.registerProvider(new MemoryConfigProvider({}, 'm', 10))
    await svc.refresh()
    const good = vi.fn()
    svc.onDidChange(() => {
      throw new Error('boom')
    })
    svc.onDidChange(good)

    await svc.set('a', 1)

    expect(good).toHaveBeenCalledTimes(1)
  })

  it('unsubscribe stops notifications', async () => {
    const svc = new ConfigService()
    svc.registerProvider(new MemoryConfigProvider({}, 'm', 10))
    const cb = vi.fn()
    svc.onDidChange(cb)()

    await svc.set('a', 1)

    expect(cb).not.toHaveBeenCalled()
  })

  it('a dirty service serves the old snapshot and refreshes on a microtask', async () => {
    const svc = new ConfigService()
    svc.registerProvider(new MemoryConfigProvider({ v: 1 }, 'm', 10))
    await svc.refresh()

    svc.registerProvider(new MemoryConfigProvider({ v: 2 }, 'late', 20))
    expect(svc.isDirty).toBe(true)
    expect(svc.get('v')).toBe(1)

    await new Promise(resolve => setTimeout(resolve, 0))

    expect(svc.isDirty).toBe(false)
    expect(svc.get('v')).toBe(2)
  })

  it('snapshotOf exposes the merged snapshot', async () => {
    const svc = new ConfigService()
    svc.registerProvider(new MemoryConfigProvider({ a: 1 }, 'm', 10))
    await svc.refresh()

    expect(svc.snapshotOf()).toEqual({ a: 1 })
  })
})
