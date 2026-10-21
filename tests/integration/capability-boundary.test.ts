/**
 * Integration test: capability/permission boundary.
 *
 * Architectural promises:
 * - An unauthorized plugin resolving another plugin's exported service throws `CapabilityDeniedError` (never silently returns undefined).
 * - An authorized plugin may resolve another plugin's exported service (cross-plugin capability consumption).
 *
 * Uses a real Kernel + temp-dir plugins for end-to-end verification (no mocks).
 * Note: the kernel reads the manifest from `plugin.json`, so dependencies/capabilities must be written into the manifest (not only inlined in the plugin source).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Kernel } from '../../src/kernel/kernel.js'
import {
  createTmpPluginsDir,
  type TmpPluginsDir,
} from '../helpers/tmp-plugins-dir.js'

const SVC_ID = 'plugin.qa.secret'
const CAP = 'command.provide'

/** Provider: registers and exports (declares a capability for) a service. Unique shape = default-exported factory. */
const PROVIDER_SOURCE = `
const TOKEN = { id: ${JSON.stringify(SVC_ID)} }
export default function factory(ctx) {
  return {
    async onStart() {
      ctx.services.registerInstance(TOKEN, { value: 42 })
      ctx.api.export(TOKEN, { capability: ${JSON.stringify(CAP)} })
    },
  }
}
`

/** Consumer: hard-depends on the provider (so the provider starts first) and attempts cross-plugin resolution. */
const CONSUMER_SOURCE = `
const TOKEN = { id: ${JSON.stringify(SVC_ID)} }
export default function factory(ctx) {
  return {
    async onStart() {
      let result
      try {
        const svc = ctx.api.useCapability(TOKEN)
        result = 'RESOLVED:' + (svc && svc.value)
      } catch (e) {
        result = 'THREW:' + (e && e.name)
      }
      // Carry observability results in the failure message so the test can read the health report.
      throw new Error('CAP_RESULT=' + result)
    },
  }
}
`

describe('integration · capability-boundary', () => {
  let tmp: TmpPluginsDir | undefined

  afterEach(async () => {
    await tmp?.cleanup()
    tmp = undefined
  })

  it("unauthorized plugin resolving another plugin's exported service → CapabilityDeniedError (not silent)", async () => {
    tmp = await createTmpPluginsDir()
    await tmp.writePlugin(
      { id: 'com.qa.provider', requires: [CAP] },
      PROVIDER_SOURCE,
      'index.js',
    )
    // The consumer declares a hard dependency (provider starts first) but NOT command.provide -> unauthorized.
    await tmp.writePlugin(
      { id: 'com.qa.consumer', dependencies: { 'com.qa.provider': '^1.0.0' } },
      CONSUMER_SOURCE,
      'index.js',
    )

    const kernel = new Kernel({ roots: [tmp.root] })
    const result = await kernel.start()
    const report = await kernel.health()
    const consumer = report.plugins.find(p => p.id === 'com.qa.consumer')

    expect(result.started).toContain('com.qa.provider')
    expect(result.failed).toContain('com.qa.consumer')
    expect(kernel.pluginRegistry.getLoaded('com.qa.consumer')!.state).toBe(
      'Failed',
    )
    expect(consumer?.message).toContain('THREW:CapabilityDeniedError')

    await kernel.shutdown()
  })

  it("authorized plugin resolving another plugin's exported service → resolves successfully (cross-plugin capability consumption)", async () => {
    tmp = await createTmpPluginsDir()
    await tmp.writePlugin(
      { id: 'com.qa.provider', requires: [CAP] },
      PROVIDER_SOURCE,
      'index.js',
    )
    // The consumer declares command.provide + a trusted kernel -> granted.
    await tmp.writePlugin(
      {
        id: 'com.qa.consumer',
        dependencies: { 'com.qa.provider': '^1.0.0' },
        requires: [CAP],
      },
      CONSUMER_SOURCE,
      'index.js',
    )

    const kernel = new Kernel({ roots: [tmp.root], trustLevel: 'trusted' })
    const result = await kernel.start()
    const report = await kernel.health()
    const consumer = report.plugins.find(p => p.id === 'com.qa.consumer')

    expect(result.started).toContain('com.qa.provider')
    // After authorization, resolution should succeed; on failure the message shows the concrete exception (NoProviderError, etc.).
    expect(consumer?.message).toContain('RESOLVED:42')

    await kernel.shutdown()
  })
})
