import { afterEach, describe, expect, it } from 'vitest'
import { Kernel } from '../../src/kernel/kernel.js'
import {
  createTmpPluginsDir,
  type TmpPluginsDir,
} from '../helpers/tmp-plugins-dir.js'

/**
 * Generates an inline JS plugin source: unique shape = default-exported factory.
 *
 * The authoritative manifest lives in plugin.json (the kernel only reads it), so the source need not repeat it.
 */
function jsPlugin(hooks: string): string {
  return `
export default function factory(ctx) {
  void ctx;
  return {
    ${hooks}
  }
}
`
}

describe('integration · fault-isolation-extra', () => {
  let tmp: TmpPluginsDir | undefined

  afterEach(async () => {
    await tmp?.cleanup()
    tmp = undefined
  })

  it('onStop throws → shutdown does not crash, the other plugins stop normally', async () => {
    tmp = await createTmpPluginsDir()
    await tmp.writePlugin(
      { id: 'com.qa.good' },
      jsPlugin('async onStart() {}'),
      'index.js',
    )
    await tmp.writePlugin(
      { id: 'com.qa.stopthrow' },
      jsPlugin(
        'async onStart() {}, async onStop() { throw new Error("stop boom"); }',
      ),
      'index.js',
    )

    const kernel = new Kernel({ roots: [tmp.root] })
    const result = await kernel.start()
    expect(result.started).toEqual(
      expect.arrayContaining(['com.qa.good', 'com.qa.stopthrow']),
    )

    await expect(kernel.shutdown()).resolves.toBeUndefined()
    expect(kernel.isStarted()).toBe(false)
    expect(kernel.pluginRegistry.getLoaded('com.qa.good')!.state).toBe(
      'Stopped',
    )
  })

  it('onConfigure throws (fatal) → that plugin is Failed, the others start normally', async () => {
    tmp = await createTmpPluginsDir()
    await tmp.writePlugin(
      { id: 'com.qa.good' },
      jsPlugin('async onStart() {}'),
      'index.js',
    )
    await tmp.writePlugin(
      { id: 'com.qa.badcfg' },
      jsPlugin('async onConfigure() { throw new Error("configure boom"); }'),
      'index.js',
    )

    const kernel = new Kernel({ roots: [tmp.root] })
    const result = await kernel.start()

    expect(result.started).toContain('com.qa.good')
    expect(result.failed).toContain('com.qa.badcfg')
    expect(kernel.pluginRegistry.getLoaded('com.qa.badcfg')!.state).toBe(
      'Failed',
    )
    expect(kernel.isStarted()).toBe(true)

    await kernel.shutdown()
  })
})
