import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Kernel } from '../../src/kernel/kernel.js'
import { materializePlugins } from '../fixtures/fake-kernel.js'

/** Overwrites the index.js of a plugin directory (simulates a disk change). */
async function overwritePluginEntry(
  root: string,
  pluginId: string,
  newSource: string,
): Promise<void> {
  const dir = path.join(root, pluginId.replace(/[^a-z0-9._-]/gi, '_'))
  await writeFile(path.join(dir, 'index.js'), newSource, 'utf8')
}

describe('integration · reload', () => {
  let cleanup: () => Promise<void>
  beforeEach(() => {
    cleanup = async () => undefined
  })
  afterEach(async () => {
    await cleanup()
  })

  it('reload stops the old instance and starts a new one', async () => {
    const fx = await materializePlugins([{ id: 'com.rem2.reloadable' }])
    cleanup = fx.cleanup

    const kernel = new Kernel({ roots: [fx.root] })
    await kernel.start()
    expect(kernel.pluginRegistry.getLoaded('com.rem2.reloadable')!.state).toBe(
      'Active',
    )

    await kernel.reload('com.rem2.reloadable')
    expect(kernel.pluginRegistry.getLoaded('com.rem2.reloadable')!.state).toBe(
      'Active',
    )

    await kernel.shutdown()
  })

  it('reload picks up new code after a disk change', async () => {
    const fx = await materializePlugins([
      { id: 'com.rem2.reloadable', health: 'healthy' },
    ])
    cleanup = fx.cleanup

    const kernel = new Kernel({ roots: [fx.root] })
    await kernel.start()

    // Rewrite the source: change the health status to degraded.
    const newSource = `
export default function factory() {
  return {
    async onStart() {},
    onHealthCheck() { return 'degraded'; },
  };
}
`
    await overwritePluginEntry(fx.root, 'com.rem2.reloadable', newSource)

    await kernel.reload('com.rem2.reloadable')
    const report = await kernel.health()
    const info = report.plugins.find(p => p.id === 'com.rem2.reloadable')
    expect(info?.status).toBe('degraded')

    await kernel.shutdown()
  })

  it('reload of a plugin that is not loaded throws', async () => {
    const kernel = new Kernel({ roots: [] })
    await kernel.start()
    await expect(kernel.reload('com.rem2.nope')).rejects.toThrow()
    await kernel.shutdown()
  })
})
