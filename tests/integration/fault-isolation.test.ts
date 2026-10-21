import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Kernel } from '../../src/kernel/kernel.js'
import { materializePlugins } from '../fixtures/fake-kernel.js'

describe('integration · fault-isolation', () => {
  let cleanup: () => Promise<void>
  beforeEach(() => {
    cleanup = async () => undefined
  })
  afterEach(async () => {
    await cleanup()
  })

  it('one plugin throwing in onStart → the others start as usual, the kernel does not crash', async () => {
    const fx = await materializePlugins([
      { id: 'com.rem2.good.a' },
      { id: 'com.rem2.bad', behavior: 'throw' },
      { id: 'com.rem2.good.b' },
    ])
    cleanup = fx.cleanup

    const kernel = new Kernel({ roots: [fx.root] })
    const result = await kernel.start()

    expect(result.started).toContain('com.rem2.good.a')
    expect(result.started).toContain('com.rem2.good.b')
    expect(result.failed).toContain('com.rem2.bad')
    expect(kernel.pluginRegistry.getLoaded('com.rem2.bad')!.state).toBe(
      'Failed',
    )
    expect(kernel.isStarted()).toBe(true)

    await kernel.shutdown()
  })

  it('a startup timeout is isolated, the other plugins are unaffected', async () => {
    const fx = await materializePlugins([
      { id: 'com.rem2.fast' },
      { id: 'com.rem2.slow', behavior: { delayMs: 500 } },
    ])
    cleanup = fx.cleanup

    const kernel = new Kernel({ roots: [fx.root], startTimeoutMs: 40 })
    const result = await kernel.start()

    expect(result.started).toContain('com.rem2.fast')
    expect(result.failed).toContain('com.rem2.slow')

    await kernel.shutdown()
  })

  it('the health report reflects the failed plugin as unhealthy', async () => {
    const fx = await materializePlugins([
      { id: 'com.rem2.ok' },
      { id: 'com.rem2.bad', behavior: 'throw' },
    ])
    cleanup = fx.cleanup

    const kernel = new Kernel({ roots: [fx.root] })
    await kernel.start()
    const report = await kernel.health()

    expect(report.status).toBe('unhealthy')
    const bad = report.plugins.find(p => p.id === 'com.rem2.bad')
    expect(bad?.status).toBe('unhealthy')

    await kernel.shutdown()
  })
})
