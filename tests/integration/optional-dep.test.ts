import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Kernel } from '../../src/kernel/kernel.js'
import { materializePlugins } from '../fixtures/fake-kernel.js'

describe('integration · optional-dependency', () => {
  let cleanup: () => Promise<void>
  beforeEach(() => {
    cleanup = async () => undefined
  })
  afterEach(async () => {
    await cleanup()
  })

  it('missing optional dependency → the plugin still starts (not failed)', async () => {
    const fx = await materializePlugins([
      {
        id: 'com.rem2.app',
        optionalDependencies: { 'com.rem2.absent': '^1.0.0' },
      },
    ])
    cleanup = fx.cleanup

    const kernel = new Kernel({ roots: [fx.root] })
    const result = await kernel.start()

    expect(result.failed).toEqual([])
    expect(result.degraded).toContain('com.rem2.app')
    expect(result.started).not.toContain('com.rem2.app')

    const issues = kernel.issues.filter(i => i.pluginId === 'com.rem2.app')
    expect(issues.some(i => i.code === 'W_MISSING_OPTIONAL')).toBe(true)

    await kernel.shutdown()
  })

  it('optional dependency present → no warnings, both plugins start normally', async () => {
    const fx = await materializePlugins([
      { id: 'com.rem2.base' },
      {
        id: 'com.rem2.app',
        optionalDependencies: { 'com.rem2.base': '^1.0.0' },
      },
    ])
    cleanup = fx.cleanup

    const kernel = new Kernel({ roots: [fx.root] })
    const result = await kernel.start()

    expect(result.started).toContain('com.rem2.base')
    expect(result.started).toContain('com.rem2.app')
    expect(kernel.pluginRegistry.getLoaded('com.rem2.app')!.state).toBe(
      'Active',
    )

    await kernel.shutdown()
  })
})
