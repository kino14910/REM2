import { describe, expect, it } from 'vitest'
import { HealthService } from '../../src/kernel/observability/health-service.js'
import { PluginsRegistry } from '../../src/kernel/registry/plugins-registry.js'
import { ExtensionPointRegistry } from '../../src/kernel/extensions/registry.js'
import { EXTENSION_POINT_DEFS } from '../../src/kernel/extensions/definitions.js'
import type { LoadedPlugin } from '../../src/kernel/extensions/ports-types.js'
import type { PluginStateT } from '../../src/kernel/contracts/plugins.js'
import { makeManifest } from '../helpers/make-manifest.js'

function fakeLoaded(id: string, state: PluginStateT): LoadedPlugin {
  return {
    manifest: makeManifest({ id }),
    hooks: {},
    context: {} as never,
    container: {} as never,
    state,
    health: { status: 'healthy' },
    rootDir: `/x/${id}`,
    permissions: {
      pluginId: id,
      granted: [],
      denied: [],
      isGranted: () => true,
    },
  }
}

/** Build a fixture with an empty registry plus defined extension points. */
function fixture(): {
  registry: PluginsRegistry
  extensions: ExtensionPointRegistry
} {
  const registry = new PluginsRegistry()
  const extensions = new ExtensionPointRegistry()
  extensions.defineAll(EXTENSION_POINT_DEFS)
  return { registry, extensions }
}

describe('health-service · report aggregation', () => {
  it('all Active → healthy', async () => {
    const { registry, extensions } = fixture()
    registry.add(fakeLoaded('a', 'Active'))
    registry.add(fakeLoaded('b', 'Active'))
    const svc = new HealthService('1.0.0', registry, extensions)

    const report = await svc.report()
    expect(report.status).toBe('healthy')
    expect(report.plugins.length).toBe(2)
    expect(report.kernel.version).toBe('1.0.0')
  })

  it('any Failed → unhealthy', async () => {
    const { registry, extensions } = fixture()
    registry.add(fakeLoaded('a', 'Active'))
    registry.add(fakeLoaded('b', 'Failed'))
    const svc = new HealthService('1.0.0', registry, extensions)
    expect((await svc.report()).status).toBe('unhealthy')
  })

  it('any Degraded → degraded', async () => {
    const { registry, extensions } = fixture()
    registry.add(fakeLoaded('a', 'Active'))
    registry.add(fakeLoaded('b', 'Degraded'))
    const svc = new HealthService('1.0.0', registry, extensions)
    expect((await svc.report()).status).toBe('degraded')
  })

  it('self-check functions contributed via the health.check extension point are called', async () => {
    const { registry, extensions } = fixture()
    registry.add(fakeLoaded('a', 'Active'))
    const svc = new HealthService('1.0.0', registry, extensions)
    extensions.contribute('a', 'health.check', {
      contributionId: 'a',
      impl: () => 'degraded',
    })

    const report = await svc.report()
    expect(report.status).toBe('degraded')
    expect(report.plugins[0]!.status).toBe('degraded')
  })

  it('a throwing self-check → unhealthy', async () => {
    const { registry, extensions } = fixture()
    registry.add(fakeLoaded('a', 'Active'))
    const svc = new HealthService('1.0.0', registry, extensions)
    extensions.contribute('a', 'health.check', {
      contributionId: 'a',
      impl: () => {
        throw new Error('check failed')
      },
    })

    const report = await svc.report()
    expect(report.status).toBe('unhealthy')
    expect(report.plugins[0]!.message).toMatch(/check failed/)
  })

  it('after retractAll, falls back to the state mapping (P6 forced reclaim)', async () => {
    const { registry, extensions } = fixture()
    registry.add(fakeLoaded('a', 'Active'))
    const svc = new HealthService('1.0.0', registry, extensions)
    extensions.contribute('a', 'health.check', {
      contributionId: 'a',
      impl: () => 'unhealthy',
    })
    extensions.retractAll('a')

    const report = await svc.report()
    expect(report.status).toBe('healthy')
  })
})
