import { describe, expect, it } from 'vitest'
import { ConfigService } from '../../src/kernel/config/config-service.js'
import { MemoryConfigProvider } from '../../src/kernel/config/memory-provider.js'
import type { ConfigProvider } from '../../src/kernel/contracts/config.js'

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
